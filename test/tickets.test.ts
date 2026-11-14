import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  closeTicket,
  createTicket,
  randomTicketId,
  type Clock,
  type IdSource,
} from '../lib/tickets/api';
import { API_ROUTES, handleTicketEvent } from '../lib/tickets/handler';
import { bindCustomer, verifiedContact } from '../lib/tickets/interceptor';
import {
  LIMITS,
  TICKET_ID_ALPHABET,
  TicketError,
  canTransition,
  isCustomerId,
  ticketIdFromBytes,
  transition,
  type Ticket,
  type TicketStatus,
} from '../lib/tickets/model';
import { ticketOpenApiDocument } from '../lib/tickets/openapi';
import { ticketPermission, ticketToolId } from '../lib/tickets/tools';
import { IDENTITY_SOURCE_ANI, IDENTITY_SOURCE_CHAT } from '../lib/tickets/identity';
import type { StoredTicket, TicketStore } from '../lib/tickets/store';

const clock: Clock = { now: () => '2026-10-24T12:00:00.000Z' };
const later: Clock = { now: () => '2026-10-24T13:00:00.000Z' };

class MemoryStore implements TicketStore {
  readonly tickets = new Map<string, StoredTicket>();

  async putNew(ticket: Ticket): Promise<boolean> {
    if (this.tickets.has(ticket.ticketId)) return false;
    this.tickets.set(ticket.ticketId, { ...structuredClone(ticket), version: 1 });
    return true;
  }

  async get(ticketId: string): Promise<StoredTicket | undefined> {
    const ticket = this.tickets.get(ticketId);
    return ticket === undefined ? undefined : structuredClone(ticket);
  }

  async queryByCustomer(customerId: string, limit: number): Promise<StoredTicket[]> {
    return [...this.tickets.values()]
      .filter((ticket) => ticket.customerId === customerId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((ticket) => structuredClone(ticket));
  }

  async save(expected: StoredTicket, ticket: Ticket): Promise<void> {
    const current = this.tickets.get(ticket.ticketId);
    if (!current || current.customerId !== ticket.customerId) {
      throw new TicketError(404, 'Ticket was not found');
    }
    if (current.version !== expected.version || current.customerId !== expected.customerId) {
      throw new TicketError(409, 'The ticket changed');
    }
    this.tickets.set(ticket.ticketId, { ...structuredClone(ticket), version: expected.version + 1 });
  }
}

function ids(...values: string[]): IdSource {
  const pending = [...values];
  return {
    next: () => {
      const value = pending.shift();
      if (!value) throw new Error('no more ids');
      return value;
    },
  };
}

const customer = 'profile-1';
const other = 'profile-2';
const contact = 'contact-1';

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    customerId: customer,
    category: 'pothole',
    subject: 'Hole on Main',
    description: 'Large hole near the library',
    channel: 'VOICE',
    contactId: contact,
    ...overrides,
  };
}

async function api(
  store: MemoryStore,
  method: string,
  resource: string,
  body?: unknown,
  query?: Record<string, string>,
  pathParameters?: Record<string, string>,
  source: IdSource = ids('HR-234567'),
) {
  const result = await handleTicketEvent({
    httpMethod: method,
    resource,
    body: body === undefined ? undefined : JSON.stringify(body),
    queryStringParameters: query,
    pathParameters,
  }, store, clock, source);
  if (!('statusCode' in result)) throw new Error('expected an API result');
  return { status: result.statusCode, body: JSON.parse(result.body) as Record<string, unknown> };
}

test('a contact UUID is a valid customer id', async () => {
  const contactUuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  expect(isCustomerId(contactUuid)).toBe(true);
  const store = new MemoryStore();
  const created = await api(store, 'POST', '/tickets', createBody({
    customerId: contactUuid,
    contactId: contactUuid,
    channel: 'CHAT',
  }));
  expect(created.status).toBe(201);
  expect(created.body.customerId).toBe(contactUuid);
  const contactResult = await handleTicketEvent({
    Details: {
      ContactData: {
        Channel: 'CHAT',
        ContactId: contactUuid,
        Attributes: {
          customerId: contactUuid,
          ticketSubject: 'After hours',
        },
      },
    },
  }, store, clock, ids('HR-CDEFGH'));
  expect(contactResult).toEqual({ ticketId: 'HR-CDEFGH' });
  expect(store.tickets.get('HR-CDEFGH')?.customerId).toBe(contactUuid);
});

test('ticket ids use an unambiguous alphabet and reject biased bytes', () => {
  expect(TICKET_ID_ALPHABET).toHaveLength(31);
  expect(TICKET_ID_ALPHABET).not.toMatch(/[01ILO]/);
  expect(ticketIdFromBytes(Uint8Array.from([0, 1, 2, 3, 4, 5]))).toBe('HR-234567');
  expect(() => ticketIdFromBytes(Uint8Array.from([31, 0, 0, 0, 0, 0]))).toThrow('out of range');

  const draws = [Uint8Array.from([255, 248, 0]), Uint8Array.from([1, 2, 3, 4, 5])];
  const id = randomTicketId(() => {
    const next = draws.shift();
    if (!next) throw new Error('random exhausted');
    return next;
  });
  expect(id).toBe('HR-234567');
  expect(draws).toHaveLength(0);
});

test('status transitions are one table and a closed ticket stays closed', () => {
  const table: Record<TicketStatus, readonly TicketStatus[]> = {
    open: ['closed'],
    closed: [],
  };
  for (const [from, next] of Object.entries(table) as Array<[TicketStatus, readonly TicketStatus[]]>) {
    for (const to of ['open', 'closed'] as const) {
      expect(canTransition(from, to)).toBe(next.includes(to));
    }
  }
  expect(transition('open', 'closed')).toBe('closed');
  expect(() => transition('closed', 'open')).toThrow(TicketError);
  try {
    transition('closed', 'open');
  } catch (error) {
    expect(error).toBeInstanceOf(TicketError);
    expect((error as TicketError).status).toBe(409);
  }
});

test('create, get, list, update, and close stay inside one customer', async () => {
  const store = new MemoryStore();
  const created = await api(store, 'POST', '/tickets', createBody());
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({
    ticketId: 'HR-234567',
    customerId: customer,
    status: 'open',
    notes: [],
    createdAt: clock.now(),
  });

  const listed = await api(store, 'GET', '/tickets', undefined, { customerId: customer });
  expect(listed.status).toBe(200);
  expect(listed.body.tickets).toEqual([created.body]);

  const read = await api(store, 'GET', '/tickets/{ticketId}', undefined, { customerId: customer }, { ticketId: 'HR-234567' });
  expect(read.status).toBe(200);
  expect(read.body.ticketId).toBe('HR-234567');

  const otherRead = await api(store, 'GET', '/tickets/{ticketId}', undefined, { customerId: other }, { ticketId: 'HR-234567' });
  expect(otherRead.status).toBe(404);

  const updated = await api(store, 'POST', '/tickets/{ticketId}', {
    customerId: customer,
    category: 'trash-pickup',
    note: 'Moved to the alley',
  }, undefined, { ticketId: 'HR-234567' }, ids());
  expect(updated.status).toBe(200);
  expect(updated.body).toMatchObject({
    category: 'trash-pickup',
    notes: [{ at: clock.now(), text: 'Moved to the alley' }],
  });

  const stolen = await api(store, 'POST', '/tickets/{ticketId}', {
    customerId: other,
    note: 'not mine',
  }, undefined, { ticketId: 'HR-234567' });
  expect(stolen.status).toBe(404);

  const closed = await api(store, 'POST', '/tickets/{ticketId}/close', { customerId: customer }, undefined, { ticketId: 'HR-234567' });
  expect(closed.status).toBe(200);
  expect(closed.body.status).toBe('closed');

  const again = await api(store, 'POST', '/tickets/{ticketId}/close', { customerId: customer }, undefined, { ticketId: 'HR-234567' });
  expect(again.status).toBe(409);
  const edited = await api(store, 'POST', '/tickets/{ticketId}', {
    customerId: customer,
    description: 'too late',
  }, undefined, { ticketId: 'HR-234567' });
  expect(edited.status).toBe(409);

  const missing = await api(store, 'GET', '/tickets/{ticketId}', undefined, { customerId: customer }, { ticketId: 'HR-999999' });
  expect(missing.status).toBe(404);
});

test('a colliding id is retried and then reported as a server error', async () => {
  const store = new MemoryStore();
  const first = await createTicket(store, {
    customerId: customer,
    category: 'other',
    subject: 'One',
    description: 'One',
    channel: 'CHAT',
    contactId: contact,
  }, clock, ids('HR-ABCDEF'));
  expect(first.ticketId).toBe('HR-ABCDEF');

  const second = await createTicket(store, {
    customerId: customer,
    category: 'other',
    subject: 'Two',
    description: 'Two',
    channel: 'CHAT',
    contactId: contact,
  }, later, ids('HR-ABCDEF', 'HR-BCDEFG'));
  expect(second.ticketId).toBe('HR-BCDEFG');

  await expect(createTicket(store, {
    customerId: customer,
    category: 'other',
    subject: 'Three',
    description: 'Three',
    channel: 'CHAT',
    contactId: contact,
  }, clock, ids('HR-ABCDEF', 'HR-ABCDEF', 'HR-ABCDEF', 'HR-ABCDEF', 'HR-ABCDEF'))).rejects.toThrow('Could not allocate a ticket id');
});

test('the handler validates the boundary and hides unexpected failures', async () => {
  const store = new MemoryStore();
  const bad = await api(store, 'POST', '/tickets', createBody({ category: 'sidewalk' }));
  expect(bad.status).toBe(400);

  const empty = await api(store, 'POST', '/tickets/{ticketId}', { customerId: customer }, undefined, { ticketId: 'HR-234567' });
  expect(empty.status).toBe(400);

  const mismatch = await api(store, 'POST', '/tickets/{ticketId}/close', { customerId: customer }, { customerId: other }, { ticketId: 'HR-234567' });
  expect(mismatch.status).toBe(400);

  const broken: TicketStore = {
    putNew: async () => { throw new Error('table down with secret'); },
    get: async () => undefined,
    queryByCustomer: async () => [],
    save: async () => undefined,
  };
  const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const result = await handleTicketEvent({
    httpMethod: 'POST',
    resource: '/tickets',
    body: JSON.stringify(createBody()),
  }, broken, clock, ids('HR-234567'));
  if (!('statusCode' in result)) throw new Error('expected an API result');
  expect(result.statusCode).toBe(500);
  expect(result.body).toBe(JSON.stringify({ message: 'Could not complete the request' }));
  expect(result.body).not.toContain('secret');
  expect(logged).toHaveBeenCalledWith('Error');
  logged.mockRestore();

  const contactResult = await handleTicketEvent({
    Details: {
      ContactData: {
        Channel: 'CHAT',
        ContactId: contact,
        Attributes: {
          customerId: customer,
          ticketSubject: '  After hours  ',
          escalationSummary: '',
        },
      },
    },
  }, store, clock, ids('HR-CDEFGH'));
  expect(contactResult).toEqual({ ticketId: 'HR-CDEFGH' });
  expect(store.tickets.get('HR-CDEFGH')).toMatchObject({
    subject: 'After hours',
    description: 'After hours',
    category: 'other',
    channel: 'CHAT',
  });

  await expect(handleTicketEvent({
    Details: { ContactData: { Channel: 'VOICE', ContactId: contact, Attributes: { ticketSubject: 'x' } } },
  }, store, clock, ids('HR-DEFGHI'))).rejects.toBeInstanceOf(TicketError);
});

test('notes stop at the limit and list returns the newest tickets', async () => {
  const store = new MemoryStore();
  await api(store, 'POST', '/tickets', createBody(), undefined, undefined, ids('HR-234567'));
  for (let index = 0; index < LIMITS.notes; index += 1) {
    const added = await api(store, 'POST', '/tickets/{ticketId}', {
      customerId: customer,
      note: `note ${index}`,
    }, undefined, { ticketId: 'HR-234567' });
    expect(added.status).toBe(200);
  }
  const overflow = await api(store, 'POST', '/tickets/{ticketId}', {
    customerId: customer,
    note: 'one more',
  }, undefined, { ticketId: 'HR-234567' });
  expect(overflow.status).toBe(409);

  await api(store, 'POST', '/tickets', createBody({ subject: 'Newer' }), undefined, undefined, ids('HR-345678'));
  store.tickets.set('HR-345678', { ...store.tickets.get('HR-345678')!, createdAt: '2026-10-24T15:00:00.000Z' });
  const listed = await api(store, 'GET', '/tickets', undefined, { customerId: customer });
  const tickets = listed.body.tickets as Array<{ ticketId: string }>;
  expect(tickets.map((ticket) => ticket.ticketId)).toEqual(['HR-345678', 'HR-234567']);
});

function callEvent(name: string, args: Record<string, unknown>) {
  return {
    mcp: {
      gatewayRequest: {
        body: {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name, arguments: args },
        },
      },
    },
  };
}

test('verifiedContact uses DescribeContact channel and ignores a contact attribute', () => {
  expect(verifiedContact({
    customerId: customer,
    identitySource: IDENTITY_SOURCE_ANI,
    contactChannel: 'CHAT',
  }, 'VOICE')).toEqual({
    customerId: customer,
    identitySource: IDENTITY_SOURCE_ANI,
    channel: 'VOICE',
  });
  expect(verifiedContact({
    customerId: '',
    identitySource: '',
  }, '')).toEqual({
    customerId: undefined,
    identitySource: undefined,
    channel: undefined,
  });
});

test('Q tool ids use the gateway id and security-profile permissions stay bare', () => {
  expect(ticketPermission('listMyTickets')).toBe('Tickets___listMyTickets');
  expect(ticketToolId('harborridge311tickets-dht3u2tcnh', 'listMyTickets'))
    .toBe('gateway_harborridge311tickets-dht3u2tcnh__Tickets___listMyTickets');
});

test('the interceptor accepts both tool name forms and logs only the raw name', async () => {
  const voice = {
    customerId: customer,
    identitySource: IDENTITY_SOURCE_ANI,
    channel: 'VOICE',
  };
  const args = {
    customerId: 'model-chose-this',
    contactId: contact,
    instanceId: 'instance-1',
    ticketId: 'HR-234567',
  };
  const qName = 'gateway_harborridge311tickets-dht3u2tcnh__Tickets___listMyTickets';
  const logged = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  const prefixed = await bindCustomer(callEvent(qName, args), async () => voice);
  expect(prefixed.mcp.transformedGatewayRequest?.body).toMatchObject({
    params: { arguments: { customerId: customer, contactId: contact } },
  });
  const bare = await bindCustomer(callEvent('Tickets___getTicket', args), async () => voice);
  expect(bare.mcp.transformedGatewayRequest?.body).toMatchObject({
    params: { arguments: { customerId: customer, ticketId: 'HR-234567' } },
  });
  const unknown = await bindCustomer(callEvent('gateway_harborridge311tickets-dht3u2tcnh__Tickets___dropTicket', args), async () => voice);
  expect(unknown.mcp.transformedGatewayResponse?.body).toMatchObject({
    error: { code: -32602, message: 'A verified customer profile is required.' },
  });
  const messages = logged.mock.calls.map((call) => call.map(String).join(' '));
  expect(messages).toEqual([
    `ticket tool ${qName}`,
    'ticket tool Tickets___getTicket',
    'ticket tool gateway_harborridge311tickets-dht3u2tcnh__Tickets___dropTicket',
  ]);
  expect(messages.join('\n')).not.toContain('model-chose-this');
  expect(messages.join('\n')).not.toContain(contact);
  expect(messages.join('\n')).not.toContain('HR-234567');
  logged.mockRestore();
});

test('the request interceptor overwrites customerId and blocks chat reads', async () => {
  const voice = {
    customerId: customer,
    identitySource: IDENTITY_SOURCE_ANI,
    channel: 'VOICE',
  };
  const chat = {
    customerId: 'chat-profile',
    identitySource: IDENTITY_SOURCE_CHAT,
    channel: 'CHAT',
  };
  const args = {
    customerId: 'model-chose-this',
    contactId: contact,
    instanceId: 'instance-1',
    ticketId: 'HR-234567',
    channel: 'VOICE',
  };
  const read = await bindCustomer(callEvent('Tickets___getTicket', args), async () => voice);
  expect(read.mcp.transformedGatewayRequest?.body).toMatchObject({
    params: { arguments: { customerId: customer, contactId: contact, ticketId: 'HR-234567' } },
  });
  const forwarded = read.mcp.transformedGatewayRequest?.body as { params: { arguments: Record<string, unknown> } };
  expect(forwarded.params.arguments.instanceId).toBeUndefined();

  const chatRead = await bindCustomer(callEvent('listMyTickets', args), async () => chat);
  expect(chatRead.mcp.transformedGatewayResponse?.body).toMatchObject({
    error: { code: -32602, message: 'Call from your phone to check or change a ticket.' },
  });

  const chatCreate = await bindCustomer(callEvent('createTicket', args), async () => chat);
  expect(chatCreate.mcp.transformedGatewayRequest?.body).toMatchObject({
    params: { arguments: { customerId: 'chat-profile', channel: 'CHAT' } },
  });

  const cleared = await bindCustomer(callEvent('createTicket', args), async () => ({
    customerId: '',
    identitySource: '',
    channel: '',
  }));
  expect(cleared.mcp.transformedGatewayResponse?.body).toMatchObject({
    error: { code: -32602, message: 'A verified customer profile is required.' },
  });

  const missing = await bindCustomer(callEvent('getTicket', args), async () => ({
    customerId: undefined,
    identitySource: undefined,
    channel: 'VOICE',
  }));
  expect(missing.mcp.transformedGatewayResponse?.body).toMatchObject({
    error: { code: -32602, message: 'A verified customer profile is required.' },
  });

  const lookupFailed = await bindCustomer(callEvent('createTicket', args), async () => {
    throw new Error('connect denied');
  });
  expect(lookupFailed.mcp.transformedGatewayResponse?.statusCode).toBe(200);

  const passthrough = await bindCustomer({
    mcp: { gatewayRequest: { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } },
  }, async () => voice);
  expect(passthrough.mcp.transformedGatewayRequest?.body).toMatchObject({ method: 'tools/list' });
});

test('a stale write cannot reopen a ticket that was closed', async () => {
  const store = new MemoryStore();
  await api(store, 'POST', '/tickets', createBody());
  const stale = await store.get('HR-234567');
  if (!stale) throw new Error('missing ticket');
  const closed = await api(store, 'POST', '/tickets/{ticketId}/close', { customerId: customer }, undefined, { ticketId: 'HR-234567' });
  expect(closed.status).toBe(200);
  await expect(store.save(stale, {
    ...stale,
    description: 'late update',
    status: 'open',
  })).rejects.toMatchObject({ status: 409 });
  expect(store.tickets.get('HR-234567')?.status).toBe('closed');
  expect(store.tickets.get('HR-234567')?.version).toBe(2);
});

test('the committed OpenAPI document matches the handlers', () => {
  const document = ticketOpenApiDocument();
  const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '../openapi/tickets.json'), 'utf8')) as unknown;
  expect(committed).toEqual(document);

  const paths = document.paths as Record<string, Record<string, { operationId: string }>>;
  const fromSpec = Object.entries(paths).flatMap(([resource, methods]) => (
    Object.entries(methods).map(([method, operation]) => ({
      method: method.toUpperCase(),
      resource,
      operationId: operation.operationId,
    }))
  ));
  const routeKey = (route: { method: string; resource: string; operationId: string }) =>
    `${route.method} ${route.resource} ${route.operationId}`;
  expect(fromSpec.map(routeKey).sort()).toEqual(API_ROUTES.map(routeKey).sort());
});
