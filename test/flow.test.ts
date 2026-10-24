import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { actionId, disconnectParticipant, flow, messageParticipant } from '../lib/flow';
import { mainFlow } from '../lib/flows/main-flow';

const flowProps = {
  dataTableId: 'table',
  wisdomAssistantArn: 'assistant',
  lexBotAliasArn: 'alias',
  orchestratorLambdaArn: 'orchestrator',
  hoursOfOperationArn: 'hours',
  queueArn: 'queue',
  escalationGuideFlowArn: 'escalation-guide',
  customerQueueFlowArn: 'queue-flow',
  caseTemplateId: 'template',
  requestCategoryFieldId: '137be1e8-7eac-4741-9a3b-18aedbdcf77b',
};

interface ComparableAction {
  Identifier: string;
  Type: string;
  Parameters: unknown;
  Transitions: {
    NextAction?: string;
    Conditions?: Array<{ NextAction: string; Condition: { Operator: string; Operands: string[] } }>;
    Errors?: Array<{ ErrorType: string; NextAction: string }>;
  };
}

interface ComparableFlow {
  Version: string;
  StartAction: string;
  Actions: ComparableAction[];
}

function outgoing(action: ComparableAction): string[] {
  return [
    ...(action.Transitions.NextAction === undefined ? [] : [action.Transitions.NextAction]),
    ...(action.Transitions.Conditions ?? []).map((branch) => branch.NextAction),
    ...(action.Transitions.Errors ?? []).map((branch) => branch.NextAction),
  ];
}

function normalize(content: ComparableFlow) {
  const byId = new Map(content.Actions.map((action) => [action.Identifier, action]));
  const names = new Map<string, string>();
  const pending = [content.StartAction];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const identifier = pending.shift();
    if (identifier === undefined || seen.has(identifier)) {
      continue;
    }
    seen.add(identifier);
    names.set(identifier, `action-${names.size}`);
    const action = byId.get(identifier);
    if (!action) {
      throw new Error(`dangling identifier ${identifier}`);
    }
    for (const next of outgoing(action)) {
      if (!seen.has(next)) {
        pending.push(next);
      }
    }
  }
  const rename = (identifier: string) => {
    const named = names.get(identifier);
    if (named === undefined) {
      throw new Error(`unmapped identifier ${identifier}`);
    }
    return named;
  };
  return {
    Version: content.Version,
    StartAction: rename(content.StartAction),
    Actions: content.Actions.map((action) => ({
      Identifier: rename(action.Identifier),
      Type: action.Type,
      Parameters: action.Parameters,
      Transitions: {
        ...(action.Transitions.NextAction === undefined ? {} : { NextAction: rename(action.Transitions.NextAction) }),
        ...(action.Transitions.Conditions === undefined ? {} : {
          Conditions: action.Transitions.Conditions.map((branch) => ({
            ...branch,
            NextAction: rename(branch.NextAction),
          })),
        }),
        ...(action.Transitions.Errors === undefined ? {} : {
          Errors: action.Transitions.Errors.map((branch) => ({
            ...branch,
            NextAction: rename(branch.NextAction),
          })),
        }),
      },
    })),
  };
}

test('builder MainFlow matches the hand-written flow once identifiers are mapped through the graph', () => {
  const handWritten = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures/main-flow-0966293.json'),
    'utf8',
  )) as ComparableFlow & { Metadata: unknown };
  const built = mainFlow(flowProps);

  expect(handWritten.Metadata).toBeDefined();
  expect(built).not.toHaveProperty('Metadata');
  expect(normalize(built)).toEqual(normalize(handWritten));
  expect(built.Actions).toHaveLength(handWritten.Actions.length);
});

test('action identifiers stay stable across compiles', () => {
  const definition = {
    name: 'Test',
    start: 'end',
    actions: [disconnectParticipant('end')],
  };
  const first = flow(definition);
  expect(flow(definition)).toEqual(first);
  expect(first.StartAction).toBe(actionId('Test', 'end'));
  expect(first.StartAction).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(actionId('Test', 'end')).not.toBe(actionId('Test', 'other'));
  expect(actionId('Test', 'end')).not.toBe(actionId('Other', 'end'));

  const main = mainFlow(flowProps);
  expect(mainFlow(flowProps)).toEqual(main);
  expect(main.StartAction).not.toBe('enable-flow-logging');
  expect(new Set(main.Actions.map((action) => action.Identifier)).size).toBe(main.Actions.length);
});

test('flow() rejects a dangling transition', () => {
  expect(() => flow({
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
    name: 'Test',
    start: 'missing',
    actions: [disconnectParticipant('end')],
  })).toThrow('start action "missing" is not defined');
});

test('flow() rejects a token flow name or action key', () => {
  const token = cdk.Fn.join('-', ['Harbor', 'Main']);
  expect(() => flow({
    name: token,
    start: 'end',
    actions: [disconnectParticipant('end')],
  })).toThrow('flow name must be a literal string, not a token');
  expect(() => flow({
    name: 'Test',
    start: token,
    actions: [disconnectParticipant(token)],
  })).toThrow('is a token');
});
