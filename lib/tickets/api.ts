import { randomBytes } from 'node:crypto';
import {
  LIMITS,
  TICKET_ID_ALPHABET,
  TicketError,
  isCategory,
  isChannel,
  isCustomerId,
  isTicketId,
  ticketIdFromBytes,
  transition,
  type Ticket,
  type TicketCategory,
  type TicketChannel,
} from './model';
import type { StoredTicket, TicketStore } from './store';

export interface Clock {
  now(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export interface IdSource {
  next(): string;
}

export function randomTicketId(random: (size: number) => Uint8Array = (size) => randomBytes(size)): string {
  const alphabet = TICKET_ID_ALPHABET.length;
  const limit = Math.floor(256 / alphabet) * alphabet;
  const indexes: number[] = [];
  while (indexes.length < 6) {
    for (const byte of random(6)) {
      if (byte < limit && indexes.length < 6) {
        indexes.push(byte % alphabet);
      }
    }
  }
  return ticketIdFromBytes(Uint8Array.from(indexes));
}

export const randomIds: IdSource = {
  next: () => randomTicketId(),
};

export interface CreateTicketInput {
  readonly customerId: string;
  readonly category: TicketCategory;
  readonly subject: string;
  readonly description: string;
  readonly channel: TicketChannel;
  readonly contactId: string;
}

export interface UpdateTicketInput {
  readonly customerId: string;
  readonly ticketId: string;
  readonly description?: string;
  readonly category?: TicketCategory;
  readonly note?: string;
}

export interface TicketScope {
  readonly customerId: string;
  readonly ticketId: string;
}

function visible(ticket: StoredTicket): Ticket {
  const { version, ...rest } = ticket;
  void version;
  return rest;
}

function owned(ticket: StoredTicket | undefined, customerId: string): StoredTicket {
  if (!ticket || ticket.customerId !== customerId) {
    throw new TicketError(404, 'Ticket was not found');
  }
  return ticket;
}

export async function createTicket(
  store: TicketStore,
  input: CreateTicketInput,
  clock: Clock,
  ids: IdSource,
): Promise<Ticket> {
  const createdAt = clock.now();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ticket: Ticket = {
      ticketId: ids.next(),
      customerId: input.customerId,
      category: input.category,
      subject: input.subject,
      description: input.description,
      status: 'open',
      channel: input.channel,
      contactId: input.contactId,
      createdAt,
      updatedAt: createdAt,
      notes: [],
    };
    if (await store.putNew(ticket)) return ticket;
  }
  throw new Error('Could not allocate a ticket id');
}

export async function getTicket(store: TicketStore, scope: TicketScope): Promise<Ticket> {
  return visible(owned(await store.get(scope.ticketId), scope.customerId));
}

export async function listMyTickets(store: TicketStore, customerId: string): Promise<Ticket[]> {
  const tickets = await store.queryByCustomer(customerId, LIMITS.list);
  return tickets.filter((ticket) => ticket.customerId === customerId).map(visible);
}

export async function updateTicket(store: TicketStore, input: UpdateTicketInput, clock: Clock): Promise<Ticket> {
  const current = owned(await store.get(input.ticketId), input.customerId);
  if (current.status === 'closed') {
    throw new TicketError(409, 'A closed ticket cannot be updated');
  }
  const notes = input.note === undefined
    ? current.notes
    : [...current.notes, { at: clock.now(), text: input.note }];
  if (notes.length > LIMITS.notes) {
    throw new TicketError(409, 'This ticket has too many notes');
  }
  const updated: Ticket = {
    ticketId: current.ticketId,
    customerId: current.customerId,
    category: input.category ?? current.category,
    subject: current.subject,
    description: input.description ?? current.description,
    status: current.status,
    channel: current.channel,
    contactId: current.contactId,
    createdAt: current.createdAt,
    notes,
    updatedAt: clock.now(),
  };
  await store.save(current, updated);
  return updated;
}

export async function closeTicket(store: TicketStore, scope: TicketScope, clock: Clock): Promise<Ticket> {
  const current = owned(await store.get(scope.ticketId), scope.customerId);
  const updated: Ticket = {
    ticketId: current.ticketId,
    customerId: current.customerId,
    category: current.category,
    subject: current.subject,
    description: current.description,
    status: transition(current.status, 'closed'),
    channel: current.channel,
    contactId: current.contactId,
    createdAt: current.createdAt,
    notes: current.notes,
    updatedAt: clock.now(),
  };
  await store.save(current, updated);
  return updated;
}

export function requireCustomerId(value: unknown): string {
  if (typeof value !== 'string' || !isCustomerId(value)) {
    throw new TicketError(400, 'customerId is invalid');
  }
  return value;
}

export function requireContactId(value: unknown): string {
  if (typeof value !== 'string' || !isCustomerId(value)) {
    throw new TicketError(400, 'contactId is invalid');
  }
  return value;
}

export function requireTicketId(value: unknown): string {
  if (typeof value !== 'string' || !isTicketId(value)) {
    throw new TicketError(400, 'ticketId is invalid');
  }
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new TicketError(400, `${field} is invalid`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || trimmed.includes('\u0000')) {
    throw new TicketError(400, `${field} is invalid`);
  }
  return trimmed;
}

export function parseCreate(value: Record<string, unknown>): CreateTicketInput {
  const allowed = new Set(['customerId', 'category', 'subject', 'description', 'channel', 'contactId', 'instanceId']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TicketError(400, 'Unexpected field');
  }
  if (typeof value.category !== 'string' || !isCategory(value.category)) {
    throw new TicketError(400, 'category is invalid');
  }
  if (typeof value.channel !== 'string' || !isChannel(value.channel)) {
    throw new TicketError(400, 'channel is invalid');
  }
  return {
    customerId: requireCustomerId(value.customerId),
    category: value.category,
    subject: text(value.subject, 'subject', LIMITS.subject),
    description: text(value.description, 'description', LIMITS.description),
    channel: value.channel,
    contactId: requireContactId(value.contactId),
  };
}

export function parseClose(value: Record<string, unknown>): string {
  const allowed = new Set(['customerId', 'contactId', 'instanceId']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TicketError(400, 'Unexpected field');
  }
  return requireCustomerId(value.customerId);
}

export function parseUpdate(value: Record<string, unknown>, ticketId: string): UpdateTicketInput {
  const allowed = new Set(['customerId', 'description', 'category', 'note', 'contactId', 'instanceId']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TicketError(400, 'Unexpected field');
  }
  const description = value.description === undefined ? undefined : text(value.description, 'description', LIMITS.description);
  const note = value.note === undefined ? undefined : text(value.note, 'note', LIMITS.note);
  let category: TicketCategory | undefined;
  if (value.category !== undefined) {
    if (typeof value.category !== 'string' || !isCategory(value.category)) {
      throw new TicketError(400, 'category is invalid');
    }
    category = value.category;
  }
  if (description === undefined && category === undefined && note === undefined) {
    throw new TicketError(400, 'Nothing to update');
  }
  return {
    customerId: requireCustomerId(value.customerId),
    ticketId,
    description,
    category,
    note,
  };
}
