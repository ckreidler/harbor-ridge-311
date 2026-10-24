const DISPLAY_NAME = 'Harbor Ridge visitor';
const MAX_BODY_BYTES = 4096;

const CHAT_CONTENT_TYPES = [
  'text/plain',
  'text/markdown',
  'application/json',
  'application/vnd.amazonaws.connect.message.interactive',
  'application/vnd.amazonaws.connect.message.interactive.response',
];

export interface ProxyEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
}

export interface ProxyResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface ConnectCommand {
  readonly input: Record<string, unknown>;
}

interface ConnectModule {
  ConnectClient: new () => {
    send(command: ConnectCommand): Promise<Record<string, unknown>>;
  };
  StartChatContactCommand: new (input: Record<string, unknown>) => ConnectCommand;
  StartWebRTCContactCommand: new (input: Record<string, unknown>) => ConnectCommand;
}

class BodyError extends Error {}

export const touchpointRuntime = {
  loadSdk<T>(specifier: string): Promise<T> {
    return import(specifier) as Promise<T>;
  },
};

function header(headers: ProxyEvent['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function jsonResult(statusCode: number, body: unknown, origin: string): ProxyResult {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBody(event: ProxyEvent): unknown {
  if (!event.body) return undefined;
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if (text.length > MAX_BODY_BYTES) {
    throw new BodyError('Request body is too large');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BodyError('Request body is not JSON');
  }
}

function chatEmail(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.Attributes) || typeof body.Attributes.email !== 'string') {
    throw new BodyError('Chat requires an email address');
  }
  const email = body.Attributes.email.trim();
  if (!EMAIL.test(email) || email.length > 254) {
    throw new BodyError('Chat requires an email address');
  }
  return email;
}

async function startContact(event: ProxyEvent, channel: 'chat' | 'voice'): Promise<ProxyResult> {
  const origin = required('ALLOWED_ORIGIN');
  if (header(event.headers, 'origin') !== origin) {
    return jsonResult(403, { message: 'Origin is not allowed' }, origin);
  }

  try {
    const body = readBody(event);
    const sdk = await touchpointRuntime.loadSdk<ConnectModule>('@aws-sdk/client-connect');
    const client = new sdk.ConnectClient();
    const input: Record<string, unknown> = {
      InstanceId: required('INSTANCE_ID'),
      ContactFlowId: required('CONTACT_FLOW_ID'),
      ParticipantDetails: { DisplayName: DISPLAY_NAME },
    };
    const command = channel === 'chat'
      ? new sdk.StartChatContactCommand({
        ...input,
        Attributes: { email: chatEmail(body) },
        SupportedMessagingContentTypes: CHAT_CONTENT_TYPES,
      })
      : new sdk.StartWebRTCContactCommand(input);
    const result = await client.send(command);
    if (channel === 'chat') {
      return jsonResult(200, {
        data: {
          startChatResult: {
            ContactId: result.ContactId,
            ParticipantId: result.ParticipantId,
            ParticipantToken: result.ParticipantToken,
          },
          featurePermissions: { MESSAGING_MARKDOWN: true },
        },
      }, origin);
    }
    return jsonResult(200, {
      ConnectionData: result.ConnectionData,
      ContactId: result.ContactId,
      ParticipantId: result.ParticipantId,
      ParticipantToken: result.ParticipantToken,
    }, origin);
  } catch (error) {
    if (error instanceof BodyError) {
      return jsonResult(400, { message: error.message }, origin);
    }
    console.error(channel, error instanceof Error ? error.name : 'Error');
    return jsonResult(502, { message: 'Could not start the contact' }, origin);
  }
}

export function chatHandler(event: ProxyEvent): Promise<ProxyResult> {
  return startContact(event, 'chat');
}

export function voiceHandler(event: ProxyEvent): Promise<ProxyResult> {
  return startContact(event, 'voice');
}
