import { afterHoursFlow } from '../lib/flows/after-hours-flow';
import { mainFlow } from '../lib/flows/main-flow';

const allowedErrors: Record<string, readonly string[]> = {
  UpdateFlowLoggingBehavior: [],
  CheckHoursOfOperation: ['NoMatchingError'],
  TransferToFlow: ['NoMatchingError'],
  GetParticipantInput: ['InputTimeLimitExceeded', 'NoMatchingCondition', 'NoMatchingError'],
  UpdateContactTextToSpeechVoice: ['NoMatchingError'],
  EvaluateDataTableValues: ['NoMatchingError'],
  MessageParticipant: ['NoMatchingError'],
  CreateWisdomSession: ['NoMatchingError'],
  Compare: ['NoMatchingCondition'],
  ConnectParticipantWithLexBot: ['InputTimeLimitExceeded', 'NoMatchingCondition', 'NoMatchingError'],
  InvokeLambdaFunction: ['NoMatchingError'],
  DisconnectParticipant: [],
  UpdateContactAttributes: ['NoMatchingError'],
  UpdateContactRecordingBehavior: [],
};

test('flow actions only use error branches their action type allows', () => {
  const flows = [
    mainFlow({
      dataTableId: 'table',
      wisdomAssistantArn: 'assistant',
      lexBotAliasArn: 'alias',
      orchestratorLambdaArn: 'orchestrator',
      hoursOfOperationArn: 'hours',
      afterHoursFlowArn: 'after-hours',
    }),
    afterHoursFlow(),
  ];

  for (const flow of flows) {
    const identifiers = new Set(flow.Actions.map((action) => action.Identifier));
    expect(identifiers.has(flow.StartAction)).toBe(true);
    for (const action of flow.Actions) {
      const allowed = allowedErrors[action.Type];
      expect(allowed).toBeDefined();
      const used = (action.Transitions.Errors ?? []).map((error) => error.ErrorType);
      expect(used.every((errorType) => allowed.includes(errorType))).toBe(true);
      if (action.Type !== 'DisconnectParticipant') {
        expect(action.Transitions.NextAction).toEqual(expect.any(String));
        expect(identifiers.has(action.Transitions.NextAction ?? '')).toBe(true);
      }
      for (const error of action.Transitions.Errors ?? []) {
        expect(identifiers.has(error.NextAction)).toBe(true);
      }
      for (const branch of action.Transitions.Conditions ?? []) {
        expect(identifiers.has(branch.NextAction)).toBe(true);
      }
    }
  }

  const recording = afterHoursFlow().Actions.find((action) => action.Type === 'UpdateContactRecordingBehavior');
  expect(recording?.Transitions).toEqual({
    NextAction: 'leave-message',
    Errors: [],
    Conditions: [],
  });
});

const flowProps = {
  dataTableId: 'table',
  wisdomAssistantArn: 'assistant',
  lexBotAliasArn: 'alias',
  orchestratorLambdaArn: 'orchestrator',
  hoursOfOperationArn: 'hours',
  afterHoursFlowArn: 'after-hours',
};

test('compare conditions do not use an empty-string operand', () => {
  const flows = [mainFlow(flowProps), afterHoursFlow()];
  for (const flow of flows) {
    for (const action of flow.Actions) {
      if (action.Type !== 'Compare') {
        continue;
      }
      for (const branch of action.Transitions.Conditions ?? []) {
        expect(branch.Condition.Operands).not.toContain('');
      }
    }
  }
});

test('main flow block positions leave space between every block', () => {
  const flow = mainFlow(flowProps);
  const mainPath = [
    'enable-flow-logging',
    'set-en-voice',
    'lookup-prompts',
    'play-greeting',
    'create-assistant-session',
    'select-orchestrator',
    'ask-en-question',
    'check-tool',
  ];
  const position = (id: string) => {
    const found = flow.Metadata.ActionMetadata[id]?.position;
    if (!found) {
      throw new Error(`missing position for ${id}`);
    }
    return found;
  };

  for (let index = 0; index < mainPath.length - 1; index += 1) {
    const left = position(mainPath[index]);
    const right = position(mainPath[index + 1]);
    expect(right.y).toBe(left.y);
    expect(right.x - left.x).toBeGreaterThanOrEqual(250);
    expect(right.x - left.x).toBeLessThanOrEqual(300);
  }

  const greeting = position('play-greeting');
  const fallback = position('play-fallback');
  expect(fallback.x).toBe(greeting.x);
  expect(fallback.y - greeting.y).toBeGreaterThanOrEqual(250);

  const ids = flow.Actions.map((action) => action.Identifier);
  expect(new Set(Object.keys(flow.Metadata.ActionMetadata))).toEqual(new Set(ids));
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const a = position(ids[left]);
      const b = position(ids[right]);
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      expect(dx >= 250 || dy >= 250).toBe(true);
    }
  }
});

test('main flow looks up prompt text by channel and plays the greeting on success', () => {
  const flow = mainFlow(flowProps);
  const block = (identifier: string) => {
    const found = flow.Actions.find((action) => action.Identifier === identifier);
    if (!found) {
      throw new Error(`missing ${identifier}`);
    }
    return found;
  };

  expect(flow.Actions.some((action) => action.Identifier === 'branch-channel')).toBe(false);
  expect(flow.Actions.some((action) => action.Identifier === 'set-chat-prompts')).toBe(false);
  expect(flow.Actions.some((action) => action.Identifier === 'set-voice-prompts')).toBe(false);
  expect(block('set-en-voice').Transitions).toMatchObject({
    NextAction: 'lookup-prompts',
    Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'lookup-prompts' }],
  });
  expect(block('lookup-prompts')).toMatchObject({
    Type: 'EvaluateDataTableValues',
    Parameters: {
      Queries: ['Greeting', 'Goodbye', 'Question'].map((prompt) => ({
        QueryName: prompt,
        Attributes: ['Text'],
        PrimaryValues: [
          { AttributeName: 'Prompt', Value: prompt },
          { AttributeName: 'Channel', Value: '$.Channel' },
        ],
      })),
    },
    Transitions: {
      NextAction: 'play-greeting',
      Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'play-fallback' }],
    },
  });
  expect(flow.Actions.some((action) => action.Identifier === 'check-prompt')).toBe(false);
  expect(flow.Actions.some((action) => action.Identifier === 'set-en-language')).toBe(false);
  expect(JSON.stringify(flow)).not.toContain('LanguageCode');
  expect(block('enable-flow-logging').Transitions.NextAction).toBe('set-en-voice');
  expect(block('play-greeting').Transitions).toMatchObject({
    NextAction: 'create-assistant-session',
    Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'play-fallback' }],
  });
  expect(block('play-greeting').Parameters.Text).toBe('$.DataTables.Greeting.Text');
  expect(block('play-goodbye').Parameters.Text).toBe('$.DataTables.Goodbye.Text');
  expect(block('ask-en-question').Parameters.Text).toBe('$.DataTables.Question.Text');
  expect(flow.Actions.filter((action) => action.Type === 'ConnectParticipantWithLexBot')).toHaveLength(1);
  expect(block('ask-en-question').Transitions.Errors).toEqual([
    { ErrorType: 'InputTimeLimitExceeded', NextAction: 'check-hours' },
    { ErrorType: 'NoMatchingCondition', NextAction: 'check-tool' },
    { ErrorType: 'NoMatchingError', NextAction: 'check-hours' },
  ]);
  expect(block('check-tool').Transitions).toMatchObject({
    NextAction: 'play-goodbye',
    Conditions: [
      { NextAction: 'play-goodbye', Condition: { Operator: 'Equals', Operands: ['Complete'] } },
      { NextAction: 'set-escalation', Condition: { Operator: 'Equals', Operands: ['Escalate'] } },
    ],
    Errors: [{ ErrorType: 'NoMatchingCondition', NextAction: 'check-hours' }],
  });
  expect(block('play-fallback').Parameters.Text).toBe(
    'Thank you for calling Harbor Ridge 3 1 1. This line is a demo. Thank you for calling Harbor Ridge 3 1 1. Goodbye.',
  );
  expect(block('select-orchestrator').Parameters.InvocationTimeLimitSeconds).toBe('8');
});
