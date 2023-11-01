import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx';
import * as pulumi from '@pulumi/pulumi';
import { Config } from './config';

/** Represents a parent resource in the mixedInstances:Lambda namespace.
 * @extends pulumi.ComponentResource
 * @param {string} name - The unique name of the parent resource.
 * @param {pulumi.ResourceOptions} [opts] - Optional settings for the resource.
 */
class ParentResource extends pulumi.ComponentResource {
  /** Constructs a new instance of the ParentResource class.
   * @constructor
   * @param {string} name - The unique name of the resource.
   * @param {pulumi.ResourceOptions} [opts] - Optional settings for the resource.
   */
  constructor(name: string, opts?: pulumi.ResourceOptions) {
    super('mixedInstances:Lambda', name, {}, opts);
  }
}

/**
 * Creates a Lambda & necessary resources to handle ICE Event and Mixed Instances
 *
 * @param {config} Config
 * @returns {string}
 */
export function createMixedInstancesLambda(
  config: Config,
): aws.lambda.Function {
  // Create an instance of the parent resource
  const parent = new ParentResource(
    `${config.cluster.name}-mixedInstancesLambda`,
  );

  // Create Lambda Role
  const mixedInstancesLambdaRole = new aws.iam.Role(
    `${config.cluster.name}-mixedInstancesLambda-role`,
    {
      name: `${config.cluster.name}-mixedInstancesLambda-role`,
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: 'lambda.amazonaws.com',
      }),
      tags: config.tags,
    },
    {
      parent,
    },
  );

  // Create Lambda Role Policy
  new aws.iam.RolePolicy(
    `${config.cluster.name}-mixedInstancesLambda-rolePolicy`,
    {
      name: `${config.cluster.name}-mixedInstancesLambda-rolePolicy`,
      policy: `{
				"Version": "2012-10-17",
				"Statement": [
					{
						"Effect": "Allow",
						"Action": [
							<< CRAFT TO YOUR NEEDS >>
						],
						"Resource": "*"
					}
				]
		}`,
      role: mixedInstancesLambdaRole.name,
    },
    {
      parent,
    },
  );

  // Create ECR Repository
  const repo = new awsx.ecr.Repository(
    `${config.cluster.name}-mixedInstancesLambda-ecr`,
    {
      name: `${config.cluster.name.toLowerCase()}-mixed-instances-lambda-ecr`,
      tags: config.tags,
    },
    {
      parent,
    },
  );

  // Create Lambda Container Image
  const mixedInstancesLambdaImage = new awsx.ecr.Image(
    `${config.cluster.name}-lambda-ecrImage`,
    {
      repositoryUrl: repo.url,
      platform: 'linux/amd64',
      context: './config/lambdas/mixedInstancesLambda',
      extraOptions: ['--quiet'],
    },
    {
      parent,
    },
  );

  // Create the lambda using docker image
  const mixedInstancesLambda = new aws.lambda.Function(
    `${config.cluster.name}-mixedInstancesLambda`,
    {
      name: `${config.cluster.name}-mixedInstancesLambda`,
      packageType: 'Image',
      architectures: ['x86_64'],
      imageUri: mixedInstancesLambdaImage.imageUri,
      role: mixedInstancesLambdaRole.arn,
      timeout: 30,
      description: 'Lambda to mix instance types',
      tags: config.tags,
    },
    {
      parent,
    },
  );

  // Create EventBridge Rule for Mixed Instances
  const mixedInstancesEventPattern = {
    source: ['aws.ec2'],
    'detail-type': ['AWS API Call via CloudTrail'],
    detail: {
      eventSource: ['ec2.amazonaws.com'],
      eventName: ['RunInstances'],
      errorCode: ['Server.InsufficientInstanceCapacity'],
      requestParameters: {
        tagSpecificationSet: {
          items: {
            tags: {
              key: ['aws:autoscaling:groupName'],
              // This filters to ASGs to only the Windows EKS Node Groups
              value: [{ prefix: config.runbookConfig?.asgNamePrefix }],
            },
          },
        },
      },
    },
  };

  // Create EventBridge Rule
  const mixedInstancesEventRule = new aws.cloudwatch.EventRule(
    `${config.cluster.name}-mixedInstancesEventBridge-rule`,
    {
      name: `${config.cluster.name}-mixedInstancesEventBridge-rule`,
      description: 'Handle Mixed Instances and ICE Events',
      tags: config.tags,
      eventPattern: JSON.stringify(mixedInstancesEventPattern),
    },
    {
      parent,
    },
  );

  // Here we pull in the original event and also inject our desired Slack Channel for alerts.
  new aws.cloudwatch.EventTarget(
    `${config.cluster.name}-mixedInstancesEventBridge-eventRule`,
    {
      rule: mixedInstancesEventRule.name,
      arn: mixedInstancesLambda.arn,
      inputTransformer: {
        inputTemplate: `{
              "originalEvent": <aws.events.event.json>,
              "mixedTypes": ${JSON.stringify(
                config.runbookConfig?.mixedInstanceTypes,
              )},
              "slackChannel": "${config.slackNotificationChannel}"
            }`,
      },
    },
    {
      parent,
    },
  );

  // Grant permission to the Lambda function from the EventBridge rule
  new aws.lambda.Permission(
    `${config.cluster.name}-mixedInstancesLambda-permissions`,
    {
      action: 'lambda:InvokeFunction',
      function: mixedInstancesLambda.arn,
      principal: 'events.amazonaws.com',
      sourceArn: mixedInstancesEventRule.arn,
    },
    {
      parent,
    },
  );

  // Return Lambda
  return mixedInstancesLambda;
}
