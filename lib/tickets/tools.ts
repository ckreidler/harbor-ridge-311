export const TICKET_TARGET_NAME = 'Tickets';
export const TICKET_GATEWAY_NAME = 'HarborRidge311Tickets';
export const TICKET_API_STAGE = 'prod';

export const TICKET_OPERATIONS = [
  'createTicket',
  'getTicket',
  'listMyTickets',
  'updateTicket',
  'closeTicket',
] as const;

export type TicketOperation = (typeof TICKET_OPERATIONS)[number];

export function ticketToolId(operation: TicketOperation): string {
  return `${TICKET_TARGET_NAME}___${operation}`;
}
