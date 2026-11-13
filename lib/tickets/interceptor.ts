import { ConnectClient, DescribeContactCommand, GetContactAttributesCommand } from '@aws-sdk/client-connect';
import {
  CUSTOMER_ID_ATTRIBUTE,
  IDENTITY_SOURCE_ANI,
  IDENTITY_SOURCE_ATTRIBUTE,
} from './identity';
import { isCustomerId } from './model';

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const READ_TOOLS = new Set(['getTicket', 'listMyTickets', 'updateTicket', 'closeTicket']);
const PROFILE_REQUIRED = 'A verified customer profile is required.';
const CALL_TO_CHANGE = 'Call from your phone to check or change a ticket.';
const CONTACT_UNVERIFIED = 'The contact could not be verified.';
const TOOL_MARKERS = ['Tickets___', 'Incidents___'];
const INCIDENT_CHANNELS = new Set(['VOICE', 'CHAT']);

export interface InterceptorOutput {
  readonly interceptorOutputVersion: '1.0';
  readonly mcp: {
    readonly transformedGatewayRequest?: { readonly body: unknown };
    readonly transformedGatewayResponse?: {
      readonly statusCode: number;
      readonly body: unknown;
    };
  };
}

export interface ContactEndpoint {
  readonly Type?: string;
  readonly Address?: string;
}

export interface VerifiedContact {
  readonly customerId: string | undefined;
  readonly identitySource: string | undefined;
  readonly channel: string | undefined;
  readonly phone?: string;
  readonly email?: string;
}

function endpointAddress(endpoint: ContactEndpoint | undefined, type: string): string | undefined {
  if (endpoint?.Type !== type) return undefined;
  const address = endpoint.Address?.trim();
  return address && address.length > 0 ? address : undefined;
}

export function verifiedContact(
  attributes: Record<string, string> | undefined,
  channel: string | undefined,
  endpoint?: ContactEndpoint,
): VerifiedContact {
  const phone = endpointAddress(endpoint, 'TELEPHONE_NUMBER');
  const email = endpointAddress(endpoint, 'EMAIL_ADDRESS');
  return {
    customerId: attribute(attributes, CUSTOMER_ID_ATTRIBUTE),
    identitySource: attribute(attributes, IDENTITY_SOURCE_ATTRIBUTE),
    channel: typeof channel === 'string' && channel.length > 0 ? channel : undefined,
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
  };
}

export type ContactLookup = (instanceId: string, contactId: string) => Promise<VerifiedContact>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestBody(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event) || !isRecord(event.mcp) || !isRecord(event.mcp.gatewayRequest)) return undefined;
  const body = event.mcp.gatewayRequest.body;
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(body) ? body : undefined;
}

function pass(body: unknown): InterceptorOutput {
  return {
    interceptorOutputVersion: '1.0',
    mcp: { transformedGatewayRequest: { body } },
  };
}

function reject(id: unknown, message: string): InterceptorOutput {
  return {
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayResponse: {
        statusCode: 200,
        body: {
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32602, message },
        },
      },
    },
  };
}

function operationName(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  let foundAt = -1;
  let marker = '';
  for (const candidate of TOOL_MARKERS) {
    const index = name.lastIndexOf(candidate);
    if (index > foundAt) {
      foundAt = index;
      marker = candidate;
    }
  }
  return foundAt === -1 ? name : name.slice(foundAt + marker.length);
}

function attribute(attributes: Record<string, string> | undefined, name: string): string | undefined {
  const value = attributes?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function bindCustomer(event: unknown, lookup: ContactLookup): Promise<InterceptorOutput> {
  const body = requestBody(event);
  if (!body || body.method !== 'tools/call') {
    return pass(body ?? (isRecord(event) && isRecord(event.mcp) && isRecord(event.mcp.gatewayRequest)
      ? event.mcp.gatewayRequest.body
      : {}));
  }
  const params = isRecord(body.params) ? body.params : undefined;
  const toolName = params?.name;
  if (typeof toolName === 'string') {
    const incidentTool = toolName === 'reportMajorIncident' || toolName.includes('Incidents___');
    console.info(`${incidentTool ? 'incident' : 'ticket'} tool ${toolName}`);
  }
  const args = params && isRecord(params.arguments) ? { ...params.arguments } : undefined;
  const contactId = args?.contactId;
  const instanceId = args?.instanceId;
  const operation = operationName(toolName);
  const incident = operation === 'reportMajorIncident';
  const denied = incident ? CONTACT_UNVERIFIED : PROFILE_REQUIRED;
  if (!args || typeof contactId !== 'string' || typeof instanceId !== 'string' || !isCustomerId(contactId) || !ID_PATTERN.test(instanceId) || !operation) {
    return reject(body.id, denied);
  }
  let verified: VerifiedContact;
  try {
    verified = await lookup(instanceId, contactId);
  } catch {
    return reject(body.id, denied);
  }
  if (incident) {
    if (!verified.channel || !INCIDENT_CHANNELS.has(verified.channel)) {
      return reject(body.id, CONTACT_UNVERIFIED);
    }
    args.channel = verified.channel;
    if (verified.customerId && isCustomerId(verified.customerId)) args.profileId = verified.customerId;
    else delete args.profileId;
    if (verified.phone) args.phone = verified.phone;
    else delete args.phone;
    if (verified.email) args.email = verified.email;
    else delete args.email;
    delete args.customerId;
    delete args.instanceId;
    return pass({
      ...body,
      params: { ...params, arguments: args },
    });
  }
  if (!verified.customerId || !isCustomerId(verified.customerId)) {
    return reject(body.id, PROFILE_REQUIRED);
  }
  if (READ_TOOLS.has(operation)) {
    if (verified.channel !== 'VOICE' || verified.identitySource !== IDENTITY_SOURCE_ANI) {
      return reject(body.id, CALL_TO_CHANGE);
    }
  } else if (operation === 'createTicket') {
    if (verified.channel !== 'VOICE' && verified.channel !== 'CHAT') {
      return reject(body.id, PROFILE_REQUIRED);
    }
    args.channel = verified.channel;
  } else {
    return reject(body.id, PROFILE_REQUIRED);
  }
  args.customerId = verified.customerId;
  delete args.instanceId;
  return pass({
    ...body,
    params: { ...params, arguments: args },
  });
}

export async function handler(event: unknown): Promise<InterceptorOutput> {
  const client = new ConnectClient({});
  return bindCustomer(event, async (instanceId, contactId) => {
    const [attributes, contact] = await Promise.all([
      client.send(new GetContactAttributesCommand({
        InstanceId: instanceId,
        InitialContactId: contactId,
      })),
      client.send(new DescribeContactCommand({
        InstanceId: instanceId,
        ContactId: contactId,
      })),
    ]);
    return verifiedContact(attributes.Attributes, contact.Contact?.Channel, contact.Contact?.CustomerEndpoint);
  });
}
