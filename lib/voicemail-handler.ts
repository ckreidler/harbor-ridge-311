interface S3Module {
  S3Client: new (config?: { region?: string }) => {
    send(command: unknown): Promise<{
      Body?: { transformToByteArray(): Promise<Uint8Array> };
    }>;
  };
  GetObjectCommand: new (input: { Bucket?: string; Key?: string; Range?: string }) => unknown;
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

const CONTACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ObjectCreatedEvent {
  time?: string;
  detail?: {
    object?: {
      key?: string;
      size?: number;
    };
  };
}

export function contactIdFromRecordingKey(encodedKey: string): string | undefined {
  let key: string;
  try {
    key = decodeObjectKey(encodedKey);
  } catch {
    return undefined;
  }
  const basename = key.slice(key.lastIndexOf('/') + 1);
  const contactId = basename.split('_')[0] ?? '';
  return CONTACT_ID.test(contactId) ? contactId : undefined;
}

function decodeObjectKey(encodedKey: string): string {
  return decodeURIComponent(encodedKey.replaceAll('+', ' '));
}

export function wavDurationSeconds(header: Uint8Array, objectSize: number): number {
  if (header.length < 12 || ascii(header, 0, 4) !== 'RIFF' || ascii(header, 8, 4) !== 'WAVE') {
    throw new Error('Recording is not a RIFF WAVE file');
  }
  let offset = 12;
  let byteRate: number | undefined;
  let dataOffset: number | undefined;
  while (offset + 8 <= header.length) {
    const id = ascii(header, offset, 4);
    const size = readU32(header, offset + 4);
    if (id === 'fmt ') {
      if (offset + 20 > header.length) {
        throw new Error('WAV fmt chunk extends past the header range');
      }
      byteRate = readU32(header, offset + 16);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      break;
    }
    const next = offset + 8 + size + (size % 2);
    if (next <= offset) {
      break;
    }
    offset = next;
  }
  if (byteRate === undefined || byteRate <= 0 || dataOffset === undefined) {
    throw new Error('WAV header is missing fmt byteRate or the data chunk');
  }
  if (objectSize < dataOffset) {
    throw new Error('Recording is smaller than its WAV data offset');
  }
  return (objectSize - dataOffset) / byteRate;
}

export async function handler(event: ObjectCreatedEvent): Promise<void> {
  const encodedKey = event.detail?.object?.key;
  if (!encodedKey) {
    console.log('Ignoring S3 event without an object key');
    return;
  }
  const contactId = contactIdFromRecordingKey(encodedKey);
  if (!contactId) {
    console.log(`Ignoring recording key that does not start with a contact id: ${encodedKey}`);
    return;
  }
  const objectSize = event.detail?.object?.size;
  if (typeof objectSize !== 'number') {
    throw new Error(`S3 event for ${encodedKey} is missing the object size`);
  }

  const instanceId = required('INSTANCE_ID');
  const bucket = required('BUCKET_NAME');
  const tableName = required('TABLE_NAME');
  const key = decodeObjectKey(encodedKey);
  const connectSdk = await loadSdk<ConnectModule>('@aws-sdk/client-connect');
  const connect = new connectSdk.ConnectClient({});
  const attributes = await connect.send(new connectSdk.GetContactAttributesCommand({
    InstanceId: instanceId,
    InitialContactId: contactId,
  }));
  if (attributes.Attributes?.Voicemail !== 'true') {
    console.log(`Contact ${contactId} is not a voicemail`);
    return;
  }

  const described = await connect.send(new connectSdk.DescribeContactCommand({
    InstanceId: instanceId,
    ContactId: contactId,
  }));
  const contact = described.Contact;
  const disconnectMs = epochMs(contact?.DisconnectTimestamp);
  const initiationMs = epochMs(contact?.InitiationTimestamp);
  const timestamp = disconnectMs !== undefined
    ? new Date(disconnectMs).toISOString()
    : initiationMs !== undefined
      ? new Date(initiationMs).toISOString()
      : event.time ?? new Date().toISOString();
  const durationSeconds = wavDurationSeconds(await readWavHeader(bucket, key), objectSize);

  const dynamo = await loadSdk<DynamoModule>('@aws-sdk/client-dynamodb');
  await new dynamo.DynamoDBClient({}).send(new dynamo.PutItemCommand({
    TableName: tableName,
    Item: {
      contactId: { S: contactId },
      callerNumber: { S: contact?.CustomerEndpoint?.Address ?? '' },
      timestamp: { S: timestamp },
      s3Key: { S: key },
      durationSeconds: { N: String(durationSeconds) },
    },
  }));
}

async function readWavHeader(bucket: string, key: string): Promise<Uint8Array> {
  const s3 = await loadSdk<S3Module>('@aws-sdk/client-s3');
  const response = await new s3.S3Client({}).send(new s3.GetObjectCommand({
    Bucket: bucket,
    Key: key,
    Range: 'bytes=0-63',
  }));
  if (!response.Body) {
    throw new Error(`Recording ${key} returned an empty header`);
  }
  return response.Body.transformToByteArray();
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readU32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]!
    + (bytes[offset + 1]! * 0x100)
    + (bytes[offset + 2]! * 0x10000)
    + (bytes[offset + 3]! * 0x1000000);
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
