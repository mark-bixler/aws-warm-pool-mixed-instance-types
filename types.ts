/**
 * Base level interface for payload from EventBridge
 * @export
 * @interface
 */
export interface IceEvent {
  /**
   * The original event details from CloudTrail passed through.
   *
   * @type {OriginalEvent}
   * @memberof  IceEvent
   */
  originalEvent: OriginalEvent;
  /**
   * The Array of different instance types to try after ICE Event
   *
   * @type {string[]}
   * @memberof  IceEvent
   */
  mixedTypes: string[];
  /**
   * The SlackChannel to send alerts
   *
   * @type {string}
   * @memberof  IceEvent
   */
  slackChannel: string; // The Slack channel associated with the event.
}

/**
 * Crafted type of the original base level event.
 * @export
 * @interface
 */
export interface OriginalEvent {
  version: string;
  id: string;
  'detail-type': string;
  source: string;
  account: string;
  time: string;
  region: string;
  resources: any[];
  detail: Detail;
}

/**
 * All the juicy details about the event that occurred.
 * @interface
 */
export interface Detail {
  eventVersion: string;
  userIdentity: UserIdentity;
  eventTime: string;
  eventSource: string;
  eventName: string;
  awsRegion: string;
  sourceIPAddress: string;
  userAgent: string;
  errorCode: string;
  errorMessage: string;
  requestParameters: RequestParameters;
  responseElements: string;
  requestID: string;
  eventID: string;
  readOnly: string;
  eventType: string;
  managementEvent: string;
  recipientAccountId: string;
  eventCategory: string;
}

/**
 * Represents user identity information.
 * @interface
 */
export interface UserIdentity {
  type: string;
  principalId: string;
  arn: string;
  accountId: string;
  sessionContext: SessionContext;
  invokedBy: string;
}

/**
 * Session context information.
 * @interface
 */
export interface SessionContext {
  sessionIssuer: SessionIssuer;
  webIdFederationData: string;
  attributes: Attributes;
}

/**
 * Session issuer information.
 * @interface
 */
export interface SessionIssuer {
  type: string;
  principalId: string;
  arn: string;
  accountId: string;
  userName: string;
}

/**
 * Attributes associated with session context.
 * @interface
 */
export interface Attributes {
  creationDate: string;
  mfaAuthenticated: string;
}

/**
 * Request parameters of the event.
 * @interface
 */
export interface RequestParameters {
  instancesSet: InstancesSet;
  blockDeviceMapping: string;
  availabilityZone: string;
  monitoring: Monitoring;
  subnetId: string;
  disableApiTermination: string;
  disableApiStop: string;
  clientToken: string;
  tagSpecificationSet: TagSpecificationSet;
  launchTemplate: LaunchTemplate;
}

/**
 * Information about instances affected.
 * @interface
 */
export interface InstancesSet {
  items: Item[];
}

/**
 * Subset of the Instance, the i
 * @interface
 */
export interface Item {
  minCount: number;
  maxCount: number;
}

/**
 * Monitoring information.
 * @interface
 */
export interface Monitoring {
  enabled: string;
}

/**
 * Represents a set of tag specifications.
 * @interface
 */
export interface TagSpecificationSet {
  items: Item2[];
}

/**
 * An item in the tag specification set.
 * @interface
 */
export interface Item2 {
  resourceType: string; // Type of resource.
  tags: Tag[];
}

/**
 * A tag.
 * @interface
 */
export interface Tag {
  key: string;
  value: string;
}

/**
 * Information about a launch template.
 * @interface
 */
export interface LaunchTemplate {
  launchTemplateId: string;
  version: string;
}
