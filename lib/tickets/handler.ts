import {
  closeTicket,
  createTicket,
  getTicket,
  listMyTickets,
  parseClose,
  parseCreate,
  parseUpdate,
  randomIds,
  requireCustomerId,
  requireTicketId,
  systemClock,
  updateTicket,
  type Clock,
  type IdSource,
} from './api';
import { LIMITS, TicketError, isChannel, type TicketChannel } from './model';
import { DynamoTicketStore, type TicketStore } from './store';

export const API_ROUTES = [
  { method: 'POST', resource: '/tickets', operationId: 'createTicket' },
  { method: 'GET', resource: '/tickets', operationId: 'listMyTickets' },
  { method: 'GET', resource: '/tickets/{ticketId}', operationId: 'getTicket' },
  { method: 'POST', resource: '/tickets/{ticketId}', operationId: 'updateTicket' },
  { method: 'POST', resource: '/tickets/{ticketId}/close', operationId: 'closeTicket' },
] as const;

export interface ApiResult {
  readonly statusCode: number;
  readonly headers: { readonly 'Content-Type': 'application/json' };
  readonly body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function apiResult(statusCode: number, body: unknown): ApiResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function errorResult(error: unknown): ApiResult {
  if (error instanceof TicketError) {
    return apiResult(error.status, { message: error.message });
  }
  console.error(error instanceof Error ? error.name : 'Error');
  return apiResult(500, { message: 'Could not complete the request' });
}

function jsonBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'string' || body.length === 0) {
    throw new TicketError(400, 'Request body is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TicketError(400, 'Request body is invalid');
  }
  if (!isRecord(parsed)) throw new TicketError(400, 'Request body is invalid');
  return parsed;
}

function queryValue(params: unknown, name: string): unknown {
  if (params === undefined || params === null) return undefined;
  if (!isRecord(params)) throw new TicketError(400, 'Query string is invalid');
  return params[name];
}

function customerFromQuery(params: unknown): string {
  return requireCustomerId(queryValue(params, 'customerId'));
}

function sameCustomer(params: unknown, customerId: string): void {
  const query = queryValue(params, 'customerId');
  if (query !== undefined && query !== customerId) {
    throw new TicketError(400, 'customerId is invalid');
  }
}

async function handleApi(
  event: Record<string, unknown>,
  store: TicketStore,
  clock: Clock,
  ids: IdSource,
): Promise<ApiResult> {
  const method = event.httpMethod;
  const resource = event.resource;
  const route = API_ROUTES.find((candidate) => candidate.method === method && candidate.resource === resource);
  if (!route) return apiResult(404, { message: 'Not found' });
  const path = isRecord(event.pathParameters) ? event.pathParameters : {};
  if (route.operationId === 'createTicket') {
    const ticket = await createTicket(store, parseCreate(jsonBody(event.body)), clock, ids);
    return apiResult(201, ticket);
  }
  if (route.operationId === 'listMyTickets') {
    const tickets = await listMyTickets(store, customerFromQuery(event.queryStringParameters));
    return apiResult(200, { tickets });
  }
  const ticketId = requireTicketId(path.ticketId);
  if (route.operationId === 'getTicket') {
    return apiResult(200, await getTicket(store, {
      customerId: customerFromQuery(event.queryStringParameters),
      ticketId,
    }));
  }
  if (route.operationId === 'closeTicket') {
    const customerId = parseClose(jsonBody(event.body));
    sameCustomer(event.queryStringParameters, customerId);
    return apiResult(200, await closeTicket(store, { customerId, ticketId }, clock));
  }
  const update = parseUpdate(jsonBody(event.body), ticketId);
  sameCustomer(event.queryStringParameters, update.customerId);
  return apiResult(200, await updateTicket(store, update, clock));
}

function attribute(attributes: unknown, name: string): string {
  if (!isRecord(attributes) || typeof attributes[name] !== 'string' || attributes[name].length === 0) {
    throw new TicketError(400, `${name} is missing`);
  }
  return attributes[name];
}

async function handleContact(
  event: Record<string, unknown>,
  store: TicketStore,
  clock: Clock,
  ids: IdSource,
): Promise<{ ticketId: string }> {
  const details = event.Details;
  if (!isRecord(details) || !isRecord(details.ContactData)) {
    throw new TicketError(400, 'Contact data is missing');
  }
  const contact = details.ContactData;
  const attributes = contact.Attributes;
  const channelValue = contact.Channel;
  const channel: TicketChannel = typeof channelValue === 'string' && isChannel(channelValue) ? channelValue : 'VOICE';
  const subject = attribute(attributes, 'ticketSubject').trim().slice(0, LIMITS.subject);
  if (subject.length === 0) throw new TicketError(400, 'ticketSubject is missing');
  const descriptionValue = isRecord(attributes) && typeof attributes.escalationSummary === 'string'
    ? attributes.escalationSummary.trim().slice(0, LIMITS.description)
    : '';
  const ticket = await createTicket(store, {
    customerId: requireCustomerId(attribute(attributes, 'customerId')),
    category: 'other',
    subject,
    description: descriptionValue.length === 0 ? subject : descriptionValue,
    channel,
    contactId: requireCustomerId(attribute(contact, 'ContactId')),
  }, clock, ids);
  return { ticketId: ticket.ticketId };
}

export async function handleTicketEvent(
  event: unknown,
  store: TicketStore,
  clock: Clock = systemClock,
  ids: IdSource = randomIds,
): Promise<ApiResult | { ticketId: string }> {
  if (!isRecord(event)) return apiResult(400, { message: 'Unrecognized request' });
  if (typeof event.httpMethod === 'string') {
    try {
      return await handleApi(event, store, clock, ids);
    } catch (error) {
      return errorResult(error);
    }
  }
  if (isRecord(event.Details)) return handleContact(event, store, clock, ids);
  return apiResult(400, { message: 'Unrecognized request' });
}

let cached: TicketStore | undefined;

function storeFromEnv(): TicketStore {
  const tableName = process.env.TICKET_TABLE_NAME;
  if (!tableName) throw new Error('TICKET_TABLE_NAME is not set');
  cached ??= new DynamoTicketStore(tableName);
  return cached;
}

export async function handler(event: unknown): Promise<ApiResult | { ticketId: string }> {
  return handleTicketEvent(event, storeFromEnv());
}
