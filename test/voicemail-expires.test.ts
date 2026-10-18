import { handler, VOICEMAIL_RETENTION_DAYS, voicemailRuntime } from '../lib/voicemail-handler';

const CONTACT_ID = '11111111-2222-4333-8444-555555555555';
const EVENT_TIME = '2026-10-18T18:44:00.000Z';
const RETENTION_SECONDS = 30 * 24 * 60 * 60;

function wavHeader(): Uint8Array {
  const header = Buffer.alloc(64);
  header.write('RIFF', 0);
  header.writeUInt32LE(36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(0, 40);
  return header;
}

test('handler writes expiresAt as the object creation time plus 30 days', async () => {
  expect(VOICEMAIL_RETENTION_DAYS).toBe(30);
  const items: Array<Record<string, { N?: string }>> = [];
  const originalLoad = voicemailRuntime.loadSdk;
  const originalNow = voicemailRuntime.now;
  process.env.INSTANCE_ID = 'instance';
  process.env.BUCKET_NAME = 'bucket';
  process.env.TABLE_NAME = 'HarborRidge311-Voicemails';
  voicemailRuntime.loadSdk = async <T>(specifier: string): Promise<T> => {
    if (specifier === '@aws-sdk/client-connect') {
      return {
        ConnectClient: class {
          send(command: { kind: string }) {
            if (command.kind === 'attributes') {
              return { Attributes: { Voicemail: 'true' } };
            }
            return {
              Contact: {
                CustomerEndpoint: { Address: '+12065550100' },
                DisconnectTimestamp: EVENT_TIME,
              },
            };
          }
        },
        GetContactAttributesCommand: class {
          readonly kind = 'attributes';
        },
        DescribeContactCommand: class {
          readonly kind = 'describe';
        },
      } as T;
    }
    if (specifier === '@aws-sdk/client-s3') {
      return {
        S3Client: class {
          send() {
            return { Body: { transformToByteArray: async () => wavHeader() } };
          }
        },
        GetObjectCommand: class {},
      } as T;
    }
    if (specifier === '@aws-sdk/client-dynamodb') {
      return {
        DynamoDBClient: class {
          send(command: { Item: Record<string, { N?: string }> }) {
            items.push(command.Item);
          }
        },
        PutItemCommand: class {
          Item: Record<string, { N?: string }>;
          constructor(input: { Item: Record<string, { N?: string }> }) {
            this.Item = input.Item;
          }
        },
      } as T;
    }
    throw new Error(`unexpected sdk ${specifier}`);
  };

  try {
    await handler({
      time: EVENT_TIME,
      detail: {
        object: {
          key: `call-recordings//ivr/2026/10/18/${CONTACT_ID}_20261018T18:44_UTC.wav`,
          size: 253_484,
        },
      },
    });
    expect(items[0]?.expiresAt?.N).toBe(String(Math.floor(Date.parse(EVENT_TIME) / 1000) + RETENTION_SECONDS));

    items.length = 0;
    const nowMs = Date.parse('2026-10-01T00:00:00.000Z');
    voicemailRuntime.now = () => nowMs;
    await handler({
      detail: {
        object: {
          key: `call-recordings//ivr/2026/10/18/${CONTACT_ID}_20261018T18:44_UTC.wav`,
          size: 253_484,
        },
      },
    });
    expect(items[0]?.expiresAt?.N).toBe(String(Math.floor(nowMs / 1000) + VOICEMAIL_RETENTION_DAYS * 24 * 60 * 60));
  } finally {
    voicemailRuntime.loadSdk = originalLoad;
    voicemailRuntime.now = originalNow;
    delete process.env.INSTANCE_ID;
    delete process.env.BUCKET_NAME;
    delete process.env.TABLE_NAME;
  }
});
