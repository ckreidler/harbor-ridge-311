import { ConnectClient, GetContactAttributesCommand } from '@aws-sdk/client-connect';
import { isCustomerId } from './model';

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

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

export type CustomerLookup = (instanceId: string, contactId: string) => Promise<string | undefined>;

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

export async function bindCustomer(event: unknown, lookup: CustomerLookup): Promise<InterceptorOutput> {
  const body = requestBody(event);
  if (!body || body.method !== 'tools/call') {
    return pass(body ?? (isRecord(event) && isRecord(event.mcp) && isRecord(event.mcp.gatewayRequest)
      ? event.mcp.gatewayRequest.body
      : {}));
  }
  const params = isRecord(body.params) ? body.params : undefined;
  const args = params && isRecord(params.arguments) ? { ...params.arguments } : undefined;
  const contactId = args?.contactId;
  const instanceId = args?.instanceId;
  if (!args || typeof contactId !== 'string' || typeof instanceId !== 'string' || !ID_PATTERN.test(contactId) || !ID_PATTERN.test(instanceId)) {
    return reject(body.id, 'A verified customer profile is required.');
  }
  let customerId: string | undefined;
  try {
    customerId = await lookup(instanceId, contactId);
  } catch {
    return reject(body.id, 'A verified customer profile is required.');
  }
  if (!customerId || !isCustomerId(customerId)) {
    return reject(body.id, 'A verified customer profile is required.');
  }
  args.customerId = customerId;
  delete args.instanceId;
  return pass({
    ...body,
    params: { ...params, arguments: args },
  });
}

export async function handler(event: unknown): Promise<InterceptorOutput> {
  const client = new ConnectClient({});
  return bindCustomer(event, async (instanceId, contactId) => {
    const result = await client.send(new GetContactAttributesCommand({
      InstanceId: instanceId,
      InitialContactId: contactId,
    }));
    const customerId = result.Attributes?.customerId;
    return typeof customerId === 'string' && customerId.length > 0 ? customerId : undefined;
  });
}
