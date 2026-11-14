import { ConnectClient, StartTaskContactCommand } from '@aws-sdk/client-connect';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { IncidentError, incidentDispatch, parseReport } from './model';

export const API_ROUTES = [
  { method: 'POST', resource: '/incidents', operationId: 'reportMajorIncident' },
] as const;

export interface ApiResult {
  readonly statusCode: number;
  readonly headers: { readonly 'Content-Type': 'application/json' };
  readonly body: string;
}

export interface IncidentConfig {
  readonly instanceId: string;
  readonly contactFlowId: string;
  readonly topicArn: string;
}

export interface StartTaskInput {
  readonly instanceId: string;
  readonly contactFlowId: string;
  readonly name: string;
  readonly description: string;
  readonly attributes: Record<string, string>;
}

export interface IncidentPorts {
  startTask(input: StartTaskInput): Promise<string>;
  publish(topicArn: string, message: string): Promise<void>;
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
  if (error instanceof IncidentError) {
    return apiResult(error.status, { message: error.message });
  }
  console.error(error instanceof Error ? error.name : 'Error');
  return apiResult(500, { message: 'Could not report the incident' });
}

function jsonBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'string' || body.length === 0) {
    throw new IncidentError(400, 'Request body is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new IncidentError(400, 'Request body is invalid');
  }
  if (!isRecord(parsed)) throw new IncidentError(400, 'Request body is invalid');
  return parsed;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function handleIncidentEvent(
  event: unknown,
  config: IncidentConfig,
  ports: IncidentPorts,
): Promise<ApiResult> {
  if (!isRecord(event) || typeof event.httpMethod !== 'string') {
    return apiResult(400, { message: 'Unrecognized request' });
  }
  const route = API_ROUTES.find((candidate) => (
    candidate.method === event.httpMethod && candidate.resource === event.resource
  ));
  if (!route) return apiResult(404, { message: 'Not found' });
  try {
    const report = parseReport(jsonBody(event.body));
    const dispatch = incidentDispatch(report);
    await ports.publish(config.topicArn, dispatch.description);
    const taskContactId = await ports.startTask({
      instanceId: config.instanceId,
      contactFlowId: config.contactFlowId,
      name: dispatch.name,
      description: dispatch.description,
      attributes: dispatch.attributes,
    });
    return apiResult(200, { reported: true, taskContactId });
  } catch (error) {
    return errorResult(error);
  }
}

export async function handler(event: unknown): Promise<ApiResult> {
  const config = {
    instanceId: requiredEnv('CONNECT_INSTANCE_ID'),
    contactFlowId: requiredEnv('CONTACT_FLOW_ID'),
    topicArn: requiredEnv('INCIDENT_TOPIC_ARN'),
  };
  const connect = new ConnectClient({});
  const sns = new SNSClient({});
  return handleIncidentEvent(event, config, {
    async startTask(input) {
      const result = await connect.send(new StartTaskContactCommand({
        InstanceId: input.instanceId,
        ContactFlowId: input.contactFlowId,
        Name: input.name,
        Description: input.description,
        Attributes: input.attributes,
      }));
      if (!result.ContactId) throw new Error('StartTaskContact returned no contact id');
      return result.ContactId;
    },
    async publish(topicArn, message) {
      await sns.send(new PublishCommand({ TopicArn: topicArn, Message: message }));
    },
  });
}
