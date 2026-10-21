import { createHmac, timingSafeEqual } from 'node:crypto';

const DISPLAY_NAME = 'Harbor Ridge visitor';
const MAX_BODY_BYTES = 4096;
const CONTACT_ID = /^[A-Za-z0-9-]{1,256}$/;
const ALREADY_ENDED = new Set([
  'ContactNotFoundException',
  'ResourceNotFoundException',
  'InvalidRequestException',
]);

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
  StopContactCommand: new (input: Record<string, unknown>) => ConnectCommand;
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

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stopTokenFor(contactId: string): string {
  return createHmac('sha256', required('STOP_SECRET')).update(contactId).digest('base64url');
}

function sameToken(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function startContact(event: ProxyEvent, channel: 'chat' | 'voice'): Promise<ProxyResult> {
  const origin = required('ALLOWED_ORIGIN');
  if (header(event.headers, 'origin') !== origin) {
    return jsonResult(403, { message: 'Origin is not allowed' }, origin);
  }

  try {
    readBody(event);
    if (channel === 'voice') required('STOP_SECRET');
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
    const contactId = typeof result.ContactId === 'string' ? result.ContactId : '';
    return jsonResult(200, {
      ConnectionData: result.ConnectionData,
      ContactId: result.ContactId,
      ParticipantId: result.ParticipantId,
      ParticipantToken: result.ParticipantToken,
      ...(contactId ? { StopToken: stopTokenFor(contactId) } : {}),
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

export async function stopVoiceHandler(event: ProxyEvent): Promise<ProxyResult> {
  const origin = required('ALLOWED_ORIGIN');
  if (header(event.headers, 'origin') !== origin) {
    return jsonResult(403, { message: 'Origin is not allowed' }, origin);
  }

  try {
    const body = plainObject(readBody(event));
    const contactId = body?.ContactId;
    const stopToken = body?.StopToken;
    if (typeof contactId !== 'string' || typeof stopToken !== 'string') {
      return jsonResult(400, { message: 'Request body is not JSON' }, origin);
    }
    if (!CONTACT_ID.test(contactId) || !sameToken(stopToken, stopTokenFor(contactId))) {
      return jsonResult(403, { message: 'Contact cannot be stopped' }, origin);
    }
    const sdk = await touchpointRuntime.loadSdk<ConnectModule>('@aws-sdk/client-connect');
    const client = new sdk.ConnectClient();
    await client.send(new sdk.StopContactCommand({
      InstanceId: required('INSTANCE_ID'),
      ContactId: contactId,
    }));
    return jsonResult(200, { stopped: true }, origin);
  } catch (error) {
    if (error instanceof BodyError) {
      return jsonResult(400, { message: error.message }, origin);
    }
    const name = error instanceof Error ? error.name : 'Error';
    if (name === 'InvalidRequestException') console.error('stop', name);
    if (ALREADY_ENDED.has(name)) {
      return jsonResult(200, { stopped: true }, origin);
    }
    console.error('stop', name);
    return jsonResult(502, { message: 'Could not stop the contact' }, origin);
  }
}
