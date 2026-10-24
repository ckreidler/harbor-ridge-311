import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import {
  CONTACT_FLOW,
  CUSTOMER_QUEUE,
  disconnectParticipant,
  flow,
  messageParticipant,
  type ConnectFlowType,
} from '../lib/flow';
import { escalationGuideFlow } from '../lib/flows/escalation-guide-flow';
import { mainFlow } from '../lib/flows/main-flow';
import { customerQueueFlow } from '../lib/flows/queue-flow';

const flowProps = {
  dataTableId: 'table',
  wisdomAssistantArn: 'assistant',
  lexBotAliasArn: 'alias',
  orchestratorLambdaArn: 'orchestrator',
  hoursOfOperationArn: 'hours',
  queueArn: 'queue',
  escalationGuideFlowArn: 'escalation-guide',
  customerQueueFlowArn: 'queue-flow',
  ticketLambdaArn: 'ticket-lambda',
};

function matchesFixture(built: unknown, fixture: string): void {
  const handWritten = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', fixture),
    'utf8',
  )) as { Metadata: unknown };
  const { Metadata, ...body } = handWritten;
  expect(Metadata).toBeDefined();
  expect(built).toEqual(body);
}

test('builder MainFlow matches the hand-written flow except Metadata', () => {
  matchesFixture(mainFlow(flowProps).content, 'main-flow-0966293.json');
});

test('builder customer queue flow matches the hand-written flow except Metadata', () => {
  matchesFixture(customerQueueFlow({
    dataTableId: 'table',
    holdMusicPromptArn: 'hold-music',
  }).content, 'queue-flow-0966293.json');
});

test('builder escalation guide matches the hand-written flow except Metadata', () => {
  matchesFixture(escalationGuideFlow({
    detailViewArn: 'arn:aws:connect:us-west-2:aws:view/detail:1',
  }).content, 'escalation-guide-flow-0966293.json');
});

test('action identifiers are the action keys and stay stable across compiles', () => {
  const actions = [disconnectParticipant('end')];
  const first = flow({ type: CONTACT_FLOW, name: 'Test', start: 'end', actions });
  expect(flow({ type: CONTACT_FLOW, name: 'Test', start: 'end', actions })).toEqual(first);
  expect(flow({ type: CONTACT_FLOW, name: 'Other', start: 'end', actions })).toEqual(first);
  expect(first.content.StartAction).toBe('end');
  expect(first.content.Actions.map((action) => action.Identifier)).toEqual(['end']);
  expect(first.type).toBe(CONTACT_FLOW);

  const main = mainFlow(flowProps);
  expect(mainFlow(flowProps)).toEqual(main);
  expect(main.type).toBe(CONTACT_FLOW);
  expect(main.content.StartAction).toBe('enable-flow-logging');
  expect(main.content.Actions.map((action) => action.Identifier)).toContain('disconnect');
});

test('flow() rejects a dangling transition', () => {
  expect(() => flow({
    type: CONTACT_FLOW,
    name: 'Test',
    start: 'greet',
    actions: [
      messageParticipant('greet', { Text: 'hi' }, { next: 'missing', error: 'end' }),
      disconnectParticipant('end'),
    ],
  })).toThrow('"greet" transitions to undefined action "missing"');
});

test('flow() rejects an unreachable action', () => {
  expect(() => flow({
    type: CONTACT_FLOW,
    name: 'Test',
    start: 'end',
    actions: [
      disconnectParticipant('end'),
      disconnectParticipant('orphan'),
    ],
  })).toThrow('action "orphan" is unreachable from "end"');
});

test('flow() rejects a duplicate action key', () => {
  expect(() => flow({
    type: CONTACT_FLOW,
    name: 'Test',
    start: 'end',
    actions: [
      disconnectParticipant('end'),
      disconnectParticipant('end'),
    ],
  })).toThrow('duplicate action key "end"');
});

test('flow() rejects a missing start action', () => {
  expect(() => flow({
    type: CONTACT_FLOW,
    name: 'Test',
    start: 'missing',
    actions: [disconnectParticipant('end')],
  })).toThrow('start action "missing" is not defined');
});

test('flow() rejects an action key that is not a valid Identifier', () => {
  const reject = (key: string) => expect(() => flow({
    type: CONTACT_FLOW,
    name: 'Test',
    start: key,
    actions: [disconnectParticipant(key)],
  })).toThrow(`action key "${key}" is not a valid Identifier`);

  reject('bad:key');
  reject('constructor');
  reject('a'.repeat(51));
  reject('');

  const limit = 'a'.repeat(50);
  expect(flow({
    type: CONTACT_FLOW,
    name: 'Test',
    start: limit,
    actions: [disconnectParticipant(limit)],
  }).content.StartAction).toBe(limit);
});

test('flow() rejects a token flow name or action key', () => {
  const token = cdk.Fn.join('-', ['Harbor', 'Main']);
  expect(() => flow({
    type: CONTACT_FLOW,
    name: token,
    start: 'end',
    actions: [disconnectParticipant('end')],
  })).toThrow('flow name must be a literal string, not a token');
  expect(() => flow({
    type: CONTACT_FLOW,
    name: 'Test',
    start: token,
    actions: [disconnectParticipant(token)],
  })).toThrow('is a token');
});

test('CUSTOMER_QUEUE rejects disconnectParticipant', () => {
  flow({
    name: 'Queue',
    type: CUSTOMER_QUEUE,
    start: 'end',
    actions: [
      // @ts-expect-error disconnectParticipant is not a customer queue action
      disconnectParticipant('end'),
    ],
  });
});

test('a widened flow type still rejects disconnectParticipant', () => {
  const type = CUSTOMER_QUEUE as ConnectFlowType;
  // @ts-expect-error ConnectFlowType matches neither flow definition
  flow({
    name: 'Queue',
    type,
    start: 'end',
    actions: [disconnectParticipant('end')],
  });
});
