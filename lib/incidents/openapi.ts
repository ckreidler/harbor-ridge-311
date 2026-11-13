import { LIMITS } from './model';

const idSchema = {
  type: 'string',
  minLength: 1,
  maxLength: LIMITS.id,
  pattern: '^[A-Za-z0-9-]{1,64}$',
} as const;

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: { message: { type: 'string' } },
} as const;

export function incidentOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Harbor Ridge 311 Major Incidents',
      version: '1.0.0',
      description: 'Reports a major incident. This does not open a ticket. Identity fields are filled from the contact.',
    },
    paths: {
      '/incidents': {
        post: {
          operationId: 'reportMajorIncident',
          summary: 'Report a major incident to the supervisor queue and the major-incident topic',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReportMajorIncident' },
              },
            },
          },
          responses: {
            '200': {
              description: 'The incident was reported',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ReportedIncident' },
                },
              },
            },
            '400': {
              description: 'Invalid input',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '500': {
              description: 'The incident could not be reported',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Error: errorSchema,
        ReportMajorIncident: {
          type: 'object',
          additionalProperties: false,
          required: ['issue', 'impact', 'impactedCount'],
          properties: {
            issue: { type: 'string', minLength: 1, maxLength: LIMITS.issue },
            impact: { type: 'string', minLength: 1, maxLength: LIMITS.impact },
            impactedCount: { type: 'integer', minimum: 1 },
            channel: { type: 'string', enum: ['VOICE', 'CHAT'] },
            contactId: idSchema,
            instanceId: idSchema,
            profileId: idSchema,
            phone: { type: 'string', minLength: 1, maxLength: LIMITS.phone },
            email: { type: 'string', minLength: 1, maxLength: LIMITS.email },
          },
        },
        ReportedIncident: {
          type: 'object',
          additionalProperties: false,
          required: ['reported', 'taskContactId'],
          properties: {
            reported: { type: 'boolean' },
            taskContactId: idSchema,
          },
        },
      },
    },
  };
}
