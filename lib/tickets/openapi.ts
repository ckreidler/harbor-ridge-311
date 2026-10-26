import { LIMITS, TICKET_CATEGORIES, TICKET_CHANNELS, TICKET_ID_PATTERN, TICKET_STATUSES } from './model';

const idSchema = {
  type: 'string',
  minLength: 1,
  maxLength: LIMITS.id,
  pattern: '^[A-Za-z0-9-]{1,64}$',
} as const;

const ticketSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'ticketId', 'customerId', 'category', 'subject', 'description', 'status', 'channel', 'contactId', 'createdAt', 'updatedAt', 'notes',
  ],
  properties: {
    ticketId: { type: 'string', pattern: TICKET_ID_PATTERN },
    customerId: idSchema,
    category: { type: 'string', enum: [...TICKET_CATEGORIES] },
    subject: { type: 'string', minLength: 1, maxLength: LIMITS.subject },
    description: { type: 'string', minLength: 1, maxLength: LIMITS.description },
    status: { type: 'string', enum: [...TICKET_STATUSES] },
    channel: { type: 'string', enum: [...TICKET_CHANNELS] },
    contactId: idSchema,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    notes: {
      type: 'array',
      maxItems: LIMITS.notes,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['at', 'text'],
        properties: {
          at: { type: 'string', format: 'date-time' },
          text: { type: 'string', minLength: 1, maxLength: LIMITS.note },
        },
      },
    },
  },
} as const;

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: { message: { type: 'string' } },
} as const;

const customerQuery = {
  name: 'customerId',
  in: 'query',
  required: true,
  schema: idSchema,
} as const;

const ignoredQuery = (name: string) => ({
  name,
  in: 'query',
  required: false,
  schema: idSchema,
} as const);

const ticketParam = {
  name: 'ticketId',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: TICKET_ID_PATTERN },
} as const;

function jsonBody(schemaName: string, required: boolean) {
  return {
    required,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schemaName}` },
      },
    },
  };
}

function responses(success: string, status: string) {
  return {
    [status]: {
      description: 'Ticket',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Ticket' } } },
    },
    '400': {
      description: 'Invalid input',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
    '404': {
      description: 'The ticket does not exist for this customer',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
    '409': {
      description: success,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  };
}

export function ticketOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Harbor Ridge 311 Tickets',
      version: '1.0.0',
      description: 'Customer-scoped tickets. Every call includes customerId. A ticket owned by another customer is a 404.',
    },
    paths: {
      '/tickets': {
        get: {
          operationId: 'listMyTickets',
          summary: 'List the newest tickets for one customer',
          parameters: [customerQuery, ignoredQuery('contactId'), ignoredQuery('instanceId')],
          responses: {
            '200': {
              description: `Up to ${LIMITS.list} tickets, newest first`,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['tickets'],
                    properties: {
                      tickets: { type: 'array', maxItems: LIMITS.list, items: { $ref: '#/components/schemas/Ticket' } },
                    },
                  },
                },
              },
            },
            '400': responses('unused', '400')['400'],
          },
        },
        post: {
          operationId: 'createTicket',
          summary: 'Open a ticket',
          requestBody: jsonBody('CreateTicket', true),
          responses: {
            '201': responses('unused', '201')['201'],
            '400': responses('unused', '400')['400'],
          },
        },
      },
      '/tickets/{ticketId}': {
        get: {
          operationId: 'getTicket',
          summary: 'Read one ticket',
          parameters: [ticketParam, customerQuery, ignoredQuery('contactId'), ignoredQuery('instanceId')],
          responses: {
            '200': responses('unused', '200')['200'],
            '400': responses('unused', '400')['400'],
            '404': responses('unused', '404')['404'],
          },
        },
        post: {
          operationId: 'updateTicket',
          summary: 'Change the description or category, or add a note',
          parameters: [ticketParam, ignoredQuery('customerId'), ignoredQuery('contactId'), ignoredQuery('instanceId')],
          requestBody: jsonBody('UpdateTicket', true),
          responses: responses('The ticket is closed or has too many notes', '200'),
        },
      },
      '/tickets/{ticketId}/close': {
        post: {
          operationId: 'closeTicket',
          summary: 'Close a ticket',
          parameters: [ticketParam, ignoredQuery('customerId'), ignoredQuery('contactId'), ignoredQuery('instanceId')],
          requestBody: jsonBody('CloseTicket', true),
          responses: responses('The ticket cannot be closed', '200'),
        },
      },
    },
    components: {
      schemas: {
        Ticket: ticketSchema,
        Error: errorSchema,
        CreateTicket: {
          type: 'object',
          additionalProperties: false,
          required: ['customerId', 'category', 'subject', 'description', 'channel', 'contactId'],
          properties: {
            customerId: idSchema,
            category: { type: 'string', enum: [...TICKET_CATEGORIES] },
            subject: { type: 'string', minLength: 1, maxLength: LIMITS.subject },
            description: { type: 'string', minLength: 1, maxLength: LIMITS.description },
            channel: { type: 'string', enum: [...TICKET_CHANNELS] },
            contactId: idSchema,
            instanceId: idSchema,
          },
        },
        UpdateTicket: {
          type: 'object',
          additionalProperties: false,
          required: ['customerId'],
          properties: {
            customerId: idSchema,
            description: { type: 'string', minLength: 1, maxLength: LIMITS.description },
            category: { type: 'string', enum: [...TICKET_CATEGORIES] },
            note: { type: 'string', minLength: 1, maxLength: LIMITS.note },
            contactId: idSchema,
            instanceId: idSchema,
          },
        },
        CloseTicket: {
          type: 'object',
          additionalProperties: false,
          required: ['customerId'],
          properties: {
            customerId: idSchema,
            contactId: idSchema,
            instanceId: idSchema,
          },
        },
      },
    },
  };
}
