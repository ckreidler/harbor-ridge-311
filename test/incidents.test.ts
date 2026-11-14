import * as fs from 'node:fs';
import * as path from 'node:path';
import { API_ROUTES, handleIncidentEvent, handler, type IncidentPorts } from '../lib/incidents/handler';
import {
  LIMITS,
  incidentDispatch,
  incidentTaskName,
  parseReport,
} from '../lib/incidents/model';
import { incidentOpenApiDocument } from '../lib/incidents/openapi';
import { incidentPermission, incidentToolId } from '../lib/incidents/tools';
import { majorIncidentFlow, majorIncidentQueueFlow } from '../lib/flows/major-incident-flow';

const config = {
  instanceId: 'instance-1',
  contactFlowId: 'flow-1',
  topicArn: 'arn:aws:sns:us-west-2:123456789012:HarborRidge311-MajorIncidents',
};

function reportBody(overrides: Record<string, unknown> = {}) {
  return {
    issue: 'Water main break on 4th',
    impact: 'Homes on the block have no water',
    impactedCount: 40,
    channel: 'VOICE',
    contactId: 'contact-1',
    ...overrides,
  };
}

async function post(
  body: unknown,
  ports: IncidentPorts,
  resource = '/incidents',
  method = 'POST',
) {
  return handleIncidentEvent({
    httpMethod: method,
    resource,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, config, ports);
}

test('a confirmed report publishes the summary before it starts one task', async () => {
  const started: unknown[] = [];
  const published: unknown[] = [];
  const order: string[] = [];
  const ports: IncidentPorts = {
    async startTask(input) {
      order.push('task');
      started.push(input);
      return 'task-contact-1';
    },
    async publish(topicArn, message) {
      order.push('publish');
      published.push({ topicArn, message });
    },
  };
  const result = await post(reportBody({
    profileId: 'profile-1',
    phone: '+12065550100',
    instanceId: 'instance-1',
  }), ports);
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ reported: true, taskContactId: 'task-contact-1' });
  expect(started).toEqual([{
    instanceId: 'instance-1',
    contactFlowId: 'flow-1',
    name: 'Major incident: Water main break on 4th',
    description: [
      'Major incident',
      'Issue: Water main break on 4th',
      'Impact: Homes on the block have no water',
      'People impacted: 40',
      'Channel: VOICE',
      'Contact: contact-1',
      'Profile: profile-1',
      'Phone: +12065550100',
    ].join('\n'),
    attributes: {
      issue: 'Water main break on 4th',
      impact: 'Homes on the block have no water',
      impactedCount: '40',
      channel: 'VOICE',
      contactId: 'contact-1',
      profileId: 'profile-1',
      phone: '+12065550100',
    },
  }]);
  expect(published).toEqual([{ topicArn: config.topicArn, message: (started[0] as { description: string }).description }]);
  expect(order).toEqual(['publish', 'task']);
});

test('chat identity can be a profile id without a phone or email', async () => {
  let attributes: Record<string, string> = {};
  const result = await post(reportBody({
    channel: 'CHAT',
    contactId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    profileId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    email: 'resident@example.com',
  }), {
    async startTask(input) {
      attributes = input.attributes;
      return 'task-contact-2';
    },
    async publish() {
      return undefined;
    },
  });
  expect(result.statusCode).toBe(200);
  expect(attributes).toEqual({
    issue: 'Water main break on 4th',
    impact: 'Homes on the block have no water',
    impactedCount: '40',
    channel: 'CHAT',
    contactId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    profileId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    email: 'resident@example.com',
  });
  expect(attributes.phone).toBeUndefined();
});

test('invalid reports do not start a task or publish', async () => {
  const ports: IncidentPorts = {
    async startTask() {
      throw new Error('startTask should not be called');
    },
    async publish() {
      throw new Error('publish should not be called');
    },
  };
  const cases = [
    reportBody({ impactedCount: 0 }),
    reportBody({ impactedCount: -3 }),
    reportBody({ impactedCount: 1.5 }),
    reportBody({ impactedCount: '4' }),
    reportBody({ issue: '   ' }),
    reportBody({ impact: 'x'.repeat(LIMITS.impact + 1) }),
    reportBody({ channel: 'TASK' }),
    reportBody({ contactId: 'not a contact' }),
    reportBody({ ticketId: 'HR-234567' }),
    reportBody({ phone: '' }),
  ];
  for (const body of cases) {
    const result = await post(body, ports);
    expect(result.statusCode).toBe(400);
  }
  expect((await post(undefined, ports)).statusCode).toBe(400);
  expect((await post(reportBody(), ports, '/tickets')).statusCode).toBe(404);
  expect((await handleIncidentEvent({ httpMethod: 'GET', resource: '/incidents' }, config, ports)).statusCode).toBe(404);
});

test('a failed publish does not start a task', async () => {
  let started = false;
  const result = await post(reportBody(), {
    async startTask() {
      started = true;
      return 'task-contact-1';
    },
    async publish() {
      throw new Error('sns denied');
    },
  });
  expect(result.statusCode).toBe(500);
  expect(JSON.parse(result.body)).toEqual({ message: 'Could not report the incident' });
  expect(started).toBe(false);
});

test('a failed task returns an error after the summary was published', async () => {
  let published = false;
  const result = await post(reportBody(), {
    async startTask() {
      throw new Error('connect denied');
    },
    async publish() {
      published = true;
    },
  });
  expect(result.statusCode).toBe(500);
  expect(published).toBe(true);
});

test('the task name keeps a short single line of the issue', () => {
  const issue = `Water\nmain   ${'x'.repeat(200)}`;
  const parsed = parseReport(reportBody({ issue }));
  expect(incidentTaskName(parsed.issue).startsWith('Major incident: Water main x')).toBe(true);
  expect(incidentTaskName(parsed.issue).length).toBe('Major incident: '.length + LIMITS.nameIssue);
  const dispatch = incidentDispatch(parsed);
  expect(dispatch.description).toContain(`Issue: ${parsed.issue}`);
  expect(dispatch.description.length).toBeLessThanOrEqual(4096);
  expect(dispatch.name).not.toContain('\n');
});

test('tool ids use the gateway id and the Incidents target', () => {
  expect(incidentPermission()).toBe('Incidents___reportMajorIncident');
  expect(incidentToolId('harborridge311tickets-dht3u2tcnh'))
    .toBe('gateway_harborridge311tickets-dht3u2tcnh__Incidents___reportMajorIncident');
});

test('the committed OpenAPI document matches the handler', () => {
  const document = incidentOpenApiDocument();
  const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '../openapi/incidents.json'), 'utf8')) as unknown;
  expect(committed).toEqual(document);
  const schema = (document.components as {
    schemas: { ReportMajorIncident: { required: string[]; properties: Record<string, { minimum?: number }> } };
  }).schemas.ReportMajorIncident;
  expect(schema.required).toEqual(['issue', 'impact', 'impactedCount']);
  expect(schema.properties.impactedCount.minimum).toBe(1);
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

test('handler requires its environment before calling AWS', async () => {
  const previous = {
    CONNECT_INSTANCE_ID: process.env.CONNECT_INSTANCE_ID,
    CONTACT_FLOW_ID: process.env.CONTACT_FLOW_ID,
    INCIDENT_TOPIC_ARN: process.env.INCIDENT_TOPIC_ARN,
  };
  try {
    delete process.env.CONNECT_INSTANCE_ID;
    delete process.env.CONTACT_FLOW_ID;
    delete process.env.INCIDENT_TOPIC_ARN;
    await expect(handler({})).rejects.toThrow('CONNECT_INSTANCE_ID is not set');
    process.env.CONNECT_INSTANCE_ID = 'instance-1';
    await expect(handler({})).rejects.toThrow('CONTACT_FLOW_ID is not set');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the task flow queues the contact and the queue flow only waits', () => {
  const task = majorIncidentFlow({ queueArn: 'major-queue', customerQueueFlowArn: 'major-queue-flow' });
  expect(task.type).toBe('CONTACT_FLOW');
  expect(task.content.StartAction).toBe('set-working-queue');
  const queueAction = task.content.Actions.find((action) => action.Identifier === 'set-working-queue');
  expect(queueAction?.Parameters.QueueId).toBe('major-queue');
  const hook = task.content.Actions.find((action) => action.Identifier === 'set-customer-queue');
  expect(hook?.Parameters.EventHooks).toEqual({ CustomerQueue: 'major-queue-flow' });
  expect(task.content.Actions.some((action) => action.Type === 'TransferContactToQueue')).toBe(true);
  const waiting = majorIncidentQueueFlow();
  expect(waiting.type).toBe('CUSTOMER_QUEUE');
  expect(waiting.content.Actions.map((action) => action.Type)).toEqual(['Wait']);
  expect(waiting.content.Actions[0]?.Transitions.NextAction).toBe('wait-for-supervisor');
  expect(waiting.content.Actions[0]?.Transitions.Errors).toEqual([
    { ErrorType: 'NoMatchingError', NextAction: 'wait-for-supervisor' },
  ]);
});
