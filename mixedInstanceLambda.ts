import {
  AutoScalingClient,
  ResumeProcessesCommand,
  SuspendProcessesCommand,
  DescribeWarmPoolCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  EC2Client,
  CreateCapacityReservationCommand,
  CancelCapacityReservationCommand,
  CreateLaunchTemplateVersionCommand,
  ModifyLaunchTemplateCommand,
  ModifyInstanceAttributeCommand,
  DescribeLaunchTemplateVersionsCommand,
} from '@aws-sdk/client-ec2';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { IceEvent } from './types';
import { v4 as uuidv4 } from 'uuid';

/**
 * AWS Lambda function to handle trying various instance types during an ICE (insufficient capacity event)
 *
 * This function suspends the ASG launch process, checks for an alternative instance type's capacity
 * in the specified availability zone, and updates the ASG's launch template with the available instance type,
 * as well as changes any 'Warm:Stopped' instances in the Warm Pool.
 * If no capacity is found, it sends a message to our Slack channel.
 * Finally, it resumes the ASG launch process and returns a 200 OK response.
 *
 * @param {IceEvent} event - The event object containing information about the ICE Event and our desired mixed instances.
 * @returns {Object} - A response object with a status code and a message indicating the execution status.
 *
 * @throws {Error} - Any error encountered during the execution of this function.
 */
export const handler = async (event: IceEvent): Promise<object> => {
  // Store Event Parameters
  const tags =
    event.originalEvent.detail.requestParameters.tagSpecificationSet.items[0]
      .tags;
  const launchTemplateId =
    event.originalEvent.detail.requestParameters.launchTemplate
      .launchTemplateId;
  const launchTemplateVersion =
    event.originalEvent.detail.requestParameters.launchTemplate.version;
  const availabilityZone =
    event.originalEvent.detail.requestParameters.availabilityZone;
  const accountId = event.originalEvent.account;
  const region = event.originalEvent.region;

  // Initialize clients
  const config = { region };
  const asgClient = new AutoScalingClient(config);
  const ec2Client = new EC2Client(config);
  const snsClient = new SNSClient(config);

  // Get Autoscaling Group Name
  const asgName = getTags(tags, 'aws:autoscaling:groupName');
  const env = getTags(tags, 't_env');

  // Get Current Instance Type
  const instanceType = await getLaunchTemplateInstance(
    ec2Client,
    launchTemplateId,
    launchTemplateVersion,
  );

  // Send Slack Alert that ICE Event Happened
  await sendSlackAlerts(
    snsClient,
    JSON.stringify({
      ImChannel: `${event.slackChannel}`,
      Subject: `-- ICE Alert: ${asgName}  --`,
      Message:
        `${instanceType} in ${availabilityZone} has insufficient capacity.` +
        '\nChecking alternative instance types.',
      Version: 1,
    }),
    accountId,
    region,
    env,
  );

  // Suspend ASG Launch Process
  await handleLaunchProcess(asgClient, 'Suspend', asgName);

  // Check for alternative instance type capacity
  const newInstanceType = await checkCapacity(
    ec2Client,
    event.mixedTypes,
    availabilityZone,
  );

  // Check response from Capacity Creation
  if (newInstanceType) {
    // Update launch template with available instance type
    await updateLaunchTemplate(
      ec2Client,
      launchTemplateId,
      launchTemplateVersion,
      newInstanceType,
    );
    await updateStoppedInstances(
      asgClient,
      ec2Client,
      asgName,
      newInstanceType,
    );

    // Alert that a new instance type was found to have capacity
    await sendSlackAlerts(
      snsClient,
      JSON.stringify({
        ImChannel: `${event.slackChannel}`,
        Subject: `-- ICE Alert: ${asgName}  --`,
        Message: `Capacity available for ${newInstanceType}!\nSwitching to available instance type.`,
        Version: 1,
      }),
      accountId,
      region,
      env,
    );
  } else {
    // Alert no alternative instances had capacity
    await sendSlackAlerts(
      snsClient,
      JSON.stringify({
        ImChannel: `${event.slackChannel}`,
        Subject: `-- ICE Alert: ${asgName}  --`,
        Message: `[${event.mixedTypes}] are all out of capacity.\nResuming ASG Launch Process and trying again.`,
        Version: 1,
      }),
      accountId,
      region,
      env,
    );
  }

  // Resume ASG Launch Process
  await handleLaunchProcess(asgClient, 'Resume', asgName);

  // Return a 200 OK response
  const response = {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Lambda function executed successfully!',
    }),
  };

  return response;
};

/**
 * Retrieves a value of a tag key passed in.
 *
 * @param tags - An array of tag objects, each containing a 'key' and 'value'.
 * @returns The value of the tag key.
 * @throws Error if the tag key is not found.
 */
function getTags(
  tags: { key: string; value: string }[],
  tagKey: string,
): string {
  // eslint-disable-next-line no-restricted-syntax
  for (const tag of tags) {
    if (tag.key === tagKey) {
      return tag.value;
    }
  }
  throw new Error(`Tag ${tagKey} not found!`);
}
/**
 * Retrieves the instance type of the default launch template during the ICE Event.
 *
 * @param {EC2Client} client - An instance of the AWS EC2 Client used to make API requests.
 * @param {string} launchTemplateId - The ID of the Launch Template.
 * @param {string} launchTemplateVersion - The specific version of the Launch Template to retrieve.
 * @returns {Promise<string | undefined>} A Promise that resolves to the instance type of the Launch Template version,
 *   or undefined if there was an error or if the Launch Template version does not exist.
 */
async function getLaunchTemplateInstance(
  client: EC2Client,
  launchTemplateId: string,
  launchTemplateVersion: string,
) {
  const input = {
    LaunchTemplateId: launchTemplateId,
    Versions: [launchTemplateVersion],
  };
  const command = new DescribeLaunchTemplateVersionsCommand(input);

  try {
    const response = await client.send(command);
    if (response.LaunchTemplateVersions)
      return response.LaunchTemplateVersions[0].LaunchTemplateData
        ?.InstanceType;
  } catch (error) {
    console.error(error);
  }
}

/**
 * Handles the suspension or resumption of the 'Launch' process for an Auto Scaling Group (ASG).
 *
 * @param {string} action - The action to perform on the 'Launch' process ('Suspend' or 'Resume').
 * @param {string} asgName - The name of the Auto Scaling Group.
 * @throws {Error} Throws an error if the provided action is not supported.
 */
async function handleLaunchProcess(
  client: AutoScalingClient,
  action: string,
  asgName: string,
) {
  const input = {
    AutoScalingGroupName: asgName,
    ScalingProcesses: ['Launch'],
  };

  let command: SuspendProcessesCommand | ResumeProcessesCommand;

  // handle passed action
  if (action == 'Suspend') {
    command = new SuspendProcessesCommand(input);
  } else if (action == 'Resume') {
    command = new ResumeProcessesCommand(input);
  } else {
    throw new Error('Action not supported.');
  }

  // send response to asg
  await client.send(command);

  try {
    // Suspend or Resume the 'Launch' process of the Auto Scaling Group
    await client.send(command);

    console.log(
      `${action} 'Launch' process for Auto Scaling Group: ${asgName}`,
    );
  } catch (error) {
    console.error(
      `Error in ${action} 'Launch' process for Auto Scaling Group: ${asgName}`,
    );
    console.error(error);
  }
}

/**
 * For each instance type, this function performs the following steps:
 * 1. Creates an On-Demand Capacity Reservation (ODCR) with specific configuration parameters.
 * 2. If the ODCR creation is successful, it immediately cancels the reservation.
 * 3. If the cancellation is successful, it returns the instance type as a successful result.
 * 4. If any errors occur during the process, it logs error messages and continues to the next instance type.
 *
 * @param {string[]} instanceTypes - An array containing the names or types of instances to be checked for capacity.
 * @param {string} AvailabilityZone - The name of the AWS Availability Zone in which to check capacity.
 * @returns {string | false | undefined} A string representing the instance type for which the capacity check was successful.
 *                                    If none of the instance types pass the capacity check, it returns `false`.
 */
async function checkCapacity(
  client: EC2Client,
  instanceTypes: string[],
  az: string,
): Promise<string | false | undefined> {
  // eslint-disable-next-line no-restricted-syntax
  for (const instanceType of instanceTypes) {
    // CreateCapacityReservationRequest
    const createInput = {
      InstanceType: instanceType,
      InstancePlatform: 'Windows',
      AvailabilityZone: az,
      Tenancy: 'default',
      InstanceCount: 1, // required
      EbsOptimized: false,
      EphemeralStorage: false,
      EndDateType: 'unlimited',
      InstanceMatchCriteria: 'targeted',
      TagSpecifications: [
        // TagSpecificationList
        {
          // TagSpecification
          ResourceType: 'capacity-reservation',
          Tags: [
            {
              // Tag
              Key: 'created-by',
              Value: 'iceLambda',
            },
          ],
        },
      ],
    };
    const createCommand = new CreateCapacityReservationCommand(createInput);
    try {
      const response = await client.send(createCommand);
      console.log(`Successfully created ODCR for type: ${instanceType}`);
      // CancelCapacityReservationRequest
      const cancelInput = {
        CapacityReservationId:
          response.CapacityReservation?.CapacityReservationId,
      };
      const cancelCommand = new CancelCapacityReservationCommand(cancelInput);
      try {
        await client.send(cancelCommand);
        console.log(`Successfully cancelled ODCR for type: ${instanceType}`);

        return instanceType;
      } catch (error) {
        console.error(`Error creating ODCR for type: ${instanceType}`);
        console.error(error);
      }
    } catch (error) {
      console.error(`Error creating ODCR for type: ${instanceType}`);
      console.error(error);
      continue;
    }
    return false;
  }
}

/**
 * Updates the ASG Launch Template by creating a new version with
 * an updated instance type and sets it as the default version.
 *
 * @async
 * @param {string} LaunchTemplateId - The ID of the Launch Template to update.
 * @param {string} SourceVersion - The version of previous Launch Template to update.
 * @param {string} instanceType - The new instance type to set in the updated Launch Template.
 * @throws {Error} If any error occurs during the update process.
 */
async function updateLaunchTemplate(
  client: EC2Client,
  ltId: string,
  ltVersion: string,
  instanceType: string,
) {
  const ltUpdateInput = {
    LaunchTemplateData: {
      InstanceType: instanceType,
    },
    LaunchTemplateId: ltId,
    SourceVersion: ltVersion,
    VersionDescription: 'Updated Instance Type for ICE Event',
  };

  const ltUpdateCommand = new CreateLaunchTemplateVersionCommand(ltUpdateInput);

  try {
    // Create new launch template version
    const ltResponse = await client.send(ltUpdateCommand);
    console.log('New launch template version created!');

    // Make new version the default
    const ltModifyInput = {
      LaunchTemplateId: ltId,
      DefaultVersion: `${ltResponse.LaunchTemplateVersion?.VersionNumber}`,
    };
    const ltModifyCommand = new ModifyLaunchTemplateCommand(ltModifyInput);
    try {
      await client.send(ltModifyCommand);
      console.log('New launch template version set as default!');
    } catch (error) {
      console.error('Error setting version as default.');
      console.error(error);
    }
  } catch (error) {
    console.error('Error creating new launch template version.');
    console.error(error);
  }
}

/**
 * Updates the instance type of 'Warmed:Stopped' instances within an ASG Warm Pool.
 *
 * @param asgName - The name of the Auto Scaling Group
 * @param instanceType - The new instance type to set for the stopped instances.
 * @throws {Error} If any error occurs during the update process.
 */
async function updateStoppedInstances(
  asgClient: AutoScalingClient,
  ec2Client: EC2Client,
  asgName: string,
  instanceType: string,
) {
  const wpDescribeInput = {
    AutoScalingGroupName: asgName,
  };

  const wpDescribeCommand = new DescribeWarmPoolCommand(wpDescribeInput);

  try {
    // Get all Warm Pool Instances
    const wpResponse = await asgClient.send(wpDescribeCommand);
    console.log("Getting 'Warmed:Stopped' instances");
    if (wpResponse.Instances) {
      // eslint-disable-next-line no-restricted-syntax
      for (const instance of wpResponse.Instances) {
        const lifecycleState = instance.LifecycleState;
        // Change stopped instance type
        if (lifecycleState == 'Warmed:Stopped') {
          const modifyInstanceInput = {
            InstanceId: instance.InstanceId,
            InstanceType: {
              Value: instanceType,
            },
          };
          const modifyInstanceCommand = new ModifyInstanceAttributeCommand(
            modifyInstanceInput,
          );
          try {
            await ec2Client.send(modifyInstanceCommand);
            console.log(
              `Instance '${instance.InstanceId}' changed to: ${instanceType}`,
            );
          } catch (error) {
            console.error('Error setting Warm Pool instance type.');
            console.error(error);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error getting warm pool instances.');
    console.error(error);
  }
}
/**
 * Sends a Slack alert message using AWS SNS (Simple Notification Service).
 *
 * @param {SNSClient} client - An instance of the AWS SNS client.
 * @param {string} message - The message content to be sent to Slack.
 * @param {string} accountId - The AWS account ID where the SNS topic is located.
 * @param {string} region - The AWS region where the SNS topic is located.
 *
 * @throws {Error} Throws an error if there is an issue with sending the message.
 */
async function sendSlackAlerts(
  client: SNSClient,
  message: string,
  accountId: string,
  region: string,
  env: string,
) {
  // Craft SNS Arn
  let snsArn: string;

  // We use our own "in house" app to handle sending SNS Messages. These lines exist
  // to handle lab work vs shared environments. 
  if (env == 'lab') {
    snsArn = `arn:aws:sns:${region}:${accountId}:platform-communications-${region}.fifo`;
  } else {
    snsArn = `arn:aws:sns:${region}:${accountId}:platform-communications-prod-${region}.fifo`;
  }

  const uuId = uuidv4();

  const input = {
    TopicArn: snsArn,
    Message: message,
    MessageGroupId: uuId,
  };

  // Send Message
  const command = new PublishCommand(input);

  try {
    await client.send(command);
    console.log(`<Sent Message ${uuId} to Slack>`);
  } catch (error: any) {
    console.error('Error publishing message:', error.message);
    console.error('Error name:', error.name);
    console.error('Error stack:', error.stack);
  }
}
