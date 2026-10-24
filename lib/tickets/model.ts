export const TICKET_CATEGORIES = ['trash-pickup', 'pothole', 'parking-permit', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_CHANNELS = ['VOICE', 'CHAT'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const STATUS_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ['in_progress', 'resolved', 'closed'],
  in_progress: ['resolved', 'closed'],
  resolved: ['closed'],
  closed: [],
};

export const TICKET_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const TICKET_ID_PATTERN = `^HR-[${TICKET_ID_ALPHABET}]{6}$`;

export const LIMITS = {
  subject: 120,
  description: 4000,
  note: 1000,
  id: 64,
  notes: 20,
  list: 20,
} as const;

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export class TicketError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

export interface TicketNote {
  readonly at: string;
  readonly text: string;
}

export interface Ticket {
  readonly ticketId: string;
  readonly customerId: string;
  readonly category: TicketCategory;
  readonly subject: string;
  readonly description: string;
  readonly status: TicketStatus;
  readonly channel: TicketChannel;
  readonly contactId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly notes: readonly TicketNote[];
}

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return STATUS_TRANSITIONS[from].some((status) => status === to);
}

export function transition(from: TicketStatus, to: TicketStatus): TicketStatus {
  if (!canTransition(from, to)) {
    throw new TicketError(409, `A ${from} ticket cannot become ${to}`);
  }
  return to;
}

export function ticketIdFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 6) {
    throw new Error('ticket id needs 6 bytes');
  }
  let id = 'HR-';
  for (const byte of bytes) {
    const char = TICKET_ID_ALPHABET[byte];
    if (char === undefined) {
      throw new Error('ticket id byte is out of range');
    }
    id += char;
  }
  return id;
}

export function isTicketId(value: string): boolean {
  return new RegExp(TICKET_ID_PATTERN).test(value);
}

export function isCategory(value: string): value is TicketCategory {
  return TICKET_CATEGORIES.some((category) => category === value);
}

export function isChannel(value: string): value is TicketChannel {
  return TICKET_CHANNELS.some((channel) => channel === value);
}

export function isStatus(value: string): value is TicketStatus {
  return TICKET_STATUSES.some((status) => status === value);
}

export function isCustomerId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function note(value: unknown): TicketNote {
  if (!isRecord(value) || typeof value.at !== 'string' || typeof value.text !== 'string') {
    throw new Error('stored ticket note is invalid');
  }
  return { at: value.at, text: value.text };
}

export function storedTicket(value: unknown): Ticket {
  if (!isRecord(value)) {
    throw new Error('stored ticket is invalid');
  }
  const {
    ticketId, customerId, category, subject, description, status, channel, contactId, createdAt, updatedAt, notes,
  } = value;
  if (typeof ticketId !== 'string' || !isTicketId(ticketId)) throw new Error('stored ticket id is invalid');
  if (typeof customerId !== 'string' || !isCustomerId(customerId)) throw new Error('stored customer id is invalid');
  if (typeof category !== 'string' || !isCategory(category)) throw new Error('stored category is invalid');
  if (typeof subject !== 'string') throw new Error('stored subject is invalid');
  if (typeof description !== 'string') throw new Error('stored description is invalid');
  if (typeof status !== 'string' || !isStatus(status)) throw new Error('stored status is invalid');
  if (typeof channel !== 'string' || !isChannel(channel)) throw new Error('stored channel is invalid');
  if (typeof contactId !== 'string' || !isCustomerId(contactId)) throw new Error('stored contact id is invalid');
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') throw new Error('stored timestamp is invalid');
  if (!Array.isArray(notes)) throw new Error('stored notes are invalid');
  return {
    ticketId,
    customerId,
    category,
    subject,
    description,
    status,
    channel,
    contactId,
    createdAt,
    updatedAt,
    notes: notes.map(note),
  };
}
