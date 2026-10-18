import { findRecordingKey } from './find-recording';

interface S3Module {
  S3Client: new (config?: { region?: string }) => {
    send(command: unknown): Promise<{
      Contents?: Array<{ Key?: string }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    }>;
  };
  ListObjectsV2Command: new (input: {
    Bucket?: string;
    Prefix?: string;
    ContinuationToken?: string;
  }) => unknown;
}

interface DynamoModule {
  DynamoDBClient: new (config?: { region?: string }) => {
    send(command: unknown): Promise<unknown>;
  };
  PutItemCommand: new (input: {
    TableName?: string;
    Item?: Record<string, { S?: string; N?: string }>;
  }) => unknown;
}

interface ConnectModule {
  ConnectClient: new (config?: { region?: string }) => {
    send(command: unknown): Promise<{
      Attributes?: Record<string, string>;
      Contact?: {
        CustomerEndpoint?: { Address?: string };
        InitiationTimestamp?: Date | string | number;
        DisconnectTimestamp?: Date | string | number;
      };
    }>;
  };
  GetContactAttributesCommand: new (input: { InstanceId?: string; InitialContactId?: string }) => unknown;
  DescribeContactCommand: new (input: { InstanceId?: string; ContactId?: string }) => unknown;
}

function loadSdk<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

const RECORDINGS_PREFIX = process.env.RECORDINGS_PREFIX ?? 'call-recordings/';

interface DisconnectEvent {
  time?: string;
  detail?: {
    contactId?: string;
    disconnectTimestamp?: string;
  };
}

export async function handler(event: DisconnectEvent): Promise<void> {
  const contactId = event.detail?.contactId;
  if (!contactId) {
    return;
  }

  const instanceId = required('INSTANCE_ID');
  const bucket = required('BUCKET_NAME');
  const tableName = required('TABLE_NAME');
  const connectSdk = await loadSdk<ConnectModule>('@aws-sdk/client-connect');
  const connect = new connectSdk.ConnectClient({});
  const attributes = await connect.send(new connectSdk.GetContactAttributesCommand({
    InstanceId: instanceId,
    InitialContactId: contactId,
  }));
  if (attributes.Attributes?.Voicemail !== 'true') {
    return;
  }

  const described = await connect.send(new connectSdk.DescribeContactCommand({
    InstanceId: instanceId,
    ContactId: contactId,
  }));
  const contact = described.Contact;
  const s3Key = await findRecordingKey(
    (prefix) => listKeys(bucket, prefix),
    RECORDINGS_PREFIX,
    contactId,
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  );
  const initiationMs = epochMs(contact?.InitiationTimestamp);
  const disconnectMs = epochMs(contact?.DisconnectTimestamp);
  const durationSeconds = initiationMs !== undefined && disconnectMs !== undefined
    ? Math.max(0, Math.round((disconnectMs - initiationMs) / 1000))
    : 0;
  const timestamp = disconnectMs !== undefined
    ? new Date(disconnectMs).toISOString()
    : event.detail?.disconnectTimestamp ?? event.time ?? new Date().toISOString();

  const dynamo = await loadSdk<DynamoModule>('@aws-sdk/client-dynamodb');
  await new dynamo.DynamoDBClient({}).send(new dynamo.PutItemCommand({
    TableName: tableName,
    Item: {
      contactId: { S: contactId },
      callerNumber: { S: contact?.CustomerEndpoint?.Address ?? '' },
      timestamp: { S: timestamp },
      s3Key: { S: s3Key },
      durationSeconds: { N: String(durationSeconds) },
    },
  }));
}

async function listKeys(bucket: string, prefix: string): Promise<string[]> {
  const s3 = await loadSdk<S3Module>('@aws-sdk/client-s3');
  const client = new s3.S3Client({});
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new s3.ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const item of page.Contents ?? []) {
      if (item.Key) {
        keys.push(item.Key);
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

function epochMs(value: Date | string | number | undefined): number | undefined {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}
