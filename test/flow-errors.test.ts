import { AFTER_HOURS_CHAT_TEXT, afterHoursFlow } from '../lib/flows/after-hours-flow';
import { escalationGuideFlow } from '../lib/flows/escalation-guide-flow';
import { mainFlow } from '../lib/flows/main-flow';
import { customerQueueFlow, QUEUE_CHAT_TEXT, QUEUE_VOICE_TEXT } from '../lib/flows/queue-flow';

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
  UpdateContactEventHooks: ['NoMatchingError'],
  UpdateContactTargetQueue: ['NoMatchingError'],
  TransferContactToQueue: ['QueueAtCapacity', 'NoMatchingError'],
  ShowView: ['NoMatchingError', 'NoMatchingCondition', 'TimeLimitExceeded'],
  Wait: ['NoMatchingError'],
  MessageParticipantIteratively: ['NoMatchingError'],
};

const flowProps = {
  dataTableId: 'table',
  wisdomAssistantArn: 'assistant',
  lexBotAliasArn: 'alias',
  orchestratorLambdaArn: 'orchestrator',
  hoursOfOperationArn: 'hours',
  afterHoursFlowArn: 'after-hours',
  queueArn: 'queue',
  escalationGuideFlowArn: 'escalation-guide',
  customerQueueFlowArn: 'queue-flow',
};

const afterHoursProps = { dataTableId: 'table' };
const queueProps = { dataTableId: 'table' };

function reachable(flow: ReturnType<typeof mainFlow>, start: string): Set<string> {
  const seen = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const identifier = pending.pop();
    if (!identifier || seen.has(identifier)) {
      continue;
    }
    seen.add(identifier);
    const action = flow.Actions.find((candidate) => candidate.Identifier === identifier);
    if (!action) {
      continue;
    }
    if (action.Transitions.NextAction) {
      pending.push(action.Transitions.NextAction);
    }
    for (const error of action.Transitions.Errors ?? []) {
      pending.push(error.NextAction);
    }
    for (const branch of action.Transitions.Conditions ?? []) {
      pending.push(branch.NextAction);
    }
  }
  return seen;
}

const detailViewArn = 'arn:aws:connect:us-west-2:aws:view/detail:1';

test('flow actions only use error branches their action type allows', () => {
  const flows = [
    mainFlow(flowProps),
    afterHoursFlow(afterHoursProps),
    customerQueueFlow(queueProps),
    escalationGuideFlow({ detailViewArn }),
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

  const recording = afterHoursFlow(afterHoursProps).Actions.find((action) => action.Type === 'UpdateContactRecordingBehavior');
  expect(recording?.Transitions).toEqual({
    NextAction: 'leave-message',
    Errors: [],
    Conditions: [],
  });
});

test('compare conditions do not use an empty-string operand', () => {
  const flows = [
    mainFlow(flowProps),
    afterHoursFlow(afterHoursProps),
    customerQueueFlow(queueProps),
    escalationGuideFlow({ detailViewArn }),
  ];
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

test('in-hours escalation sets the agent guide before transferring to the queue', () => {
  const flow = mainFlow(flowProps);
  const block = (identifier: string) => {
    const found = flow.Actions.find((action) => action.Identifier === identifier);
    if (!found) {
      throw new Error(`missing ${identifier}`);
    }
    return found;
  };
  const next = (identifier: string, operand: string) =>
    block(identifier).Transitions.Conditions?.find((branch) => branch.Condition.Operands[0] === operand)?.NextAction;

  expect(flow.Actions.some((action) => action.Identifier === 'play-agent-placeholder')).toBe(false);
  expect(JSON.stringify(flow)).not.toContain('play-agent-placeholder');
  expect(JSON.stringify(flow)).not.toContain('This is where we would escalate to an agent.');
  expect(block('check-hours').Parameters.HoursOfOperationId).toBe('hours');
  expect(block('check-hours').Transitions.NextAction).toBe('set-event-flow');
  expect(next('check-hours', 'True')).toBe('set-event-flow');
  expect(next('check-hours', 'False')).toBe('transfer-after-hours');
  expect(block('set-escalation').Transitions.NextAction).toBe('check-hours');
  expect(next('check-tool', 'Escalate')).toBe('set-escalation');
  expect(block('set-event-flow')).toMatchObject({
    Type: 'UpdateContactEventHooks',
    Parameters: { EventHooks: { DefaultAgentUI: 'escalation-guide' } },
    Transitions: {
      NextAction: 'set-working-queue',
      Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'play-goodbye' }],
    },
  });
  expect(block('set-working-queue')).toMatchObject({
    Type: 'UpdateContactTargetQueue',
    Parameters: { QueueId: 'queue' },
    Transitions: {
      NextAction: 'set-customer-queue',
      Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'play-goodbye' }],
    },
  });
  expect(block('set-customer-queue')).toMatchObject({
    Type: 'UpdateContactEventHooks',
    Parameters: { EventHooks: { CustomerQueue: 'queue-flow' } },
    Transitions: {
      NextAction: 'transfer-to-queue',
      Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'transfer-to-queue' }],
    },
  });
  expect(JSON.stringify(block('set-event-flow').Parameters)).not.toContain('CustomerQueue');
  expect(JSON.stringify(block('set-customer-queue').Parameters)).not.toContain('DefaultAgentUI');
  expect(block('transfer-to-queue')).toMatchObject({
    Type: 'TransferContactToQueue',
    Parameters: {},
    Transitions: {
      NextAction: 'play-goodbye',
      Errors: [
        { ErrorType: 'QueueAtCapacity', NextAction: 'play-goodbye' },
        { ErrorType: 'NoMatchingError', NextAction: 'play-goodbye' },
      ],
    },
  });
  expect(flow.Actions.filter((action) => action.Type === 'CreateWisdomSession')).toHaveLength(1);
  expect(block('create-assistant-session').Transitions.NextAction).toBe('select-orchestrator');

  const guide = escalationGuideFlow({ detailViewArn });
  const show = guide.Actions.find((action) => action.Identifier === 'show-escalation');
  const view = JSON.stringify(show);
  expect(show?.Type).toBe('ShowView');
  expect(view).toContain(detailViewArn);
  expect(view).toContain('Harbor Ridge 311 escalation');
  expect(view).not.toContain('TemplateString');
  expect(view).not.toContain('"Sections"');
  for (const [label, attribute] of [
    ['Reason', 'escalationReason'],
    ['Summary', 'escalationSummary'],
    ['Customer intent', 'customerIntent'],
    ['Sentiment', 'sentiment'],
  ]) {
    expect(view).toContain(`"Label":"${label}"`);
    expect(view.split(`$.Attributes.${attribute}`).length - 1).toBe(1);
  }
});

const VOICE_CLOSED_PROMPT = 'Thank you for calling Harbor Ridge 3 1 1. Our office is closed. Please leave a message after the tone, and hang up when you are finished.';

test('chat after hours never reaches a recording block and voice after hours is unchanged', () => {
  const flow = afterHoursFlow(afterHoursProps);
  const block = (identifier: string) => {
    const found = flow.Actions.find((action) => action.Identifier === identifier);
    if (!found) {
      throw new Error(`missing ${identifier}`);
    }
    return found;
  };
  const chat = reachable(flow, 'lookup-closed');
  const voice = reachable(flow, 'set-voice');

  expect(flow.StartAction).toBe('branch-channel');
  expect(flow.Actions.filter((action) => action.Type === 'Compare')).toHaveLength(1);
  expect(block('branch-channel')).toMatchObject({
    Parameters: { ComparisonValue: '$.Channel' },
    Transitions: {
      NextAction: 'set-voice',
      Conditions: [
        { NextAction: 'lookup-closed', Condition: { Operator: 'Equals', Operands: ['CHAT'] } },
      ],
      Errors: [{ ErrorType: 'NoMatchingCondition', NextAction: 'set-voice' }],
    },
  });
  expect(chat.has('start-recording')).toBe(false);
  expect(chat.has('leave-message')).toBe(false);
  expect(chat.has('set-voicemail')).toBe(false);
  expect(chat.has('set-voice')).toBe(false);
  expect(chat.has('play-closed')).toBe(false);
  expect([...chat].sort()).toEqual(['disconnect', 'lookup-closed', 'play-closed-chat', 'play-closed-fallback']);
  expect(block('lookup-closed')).toMatchObject({
    Type: 'EvaluateDataTableValues',
    Parameters: {
      DataTableId: 'table',
      Queries: [{
        QueryName: 'AfterHours',
        Attributes: ['Text'],
        PrimaryValues: [
          { AttributeName: 'Prompt', Value: 'AfterHours' },
          { AttributeName: 'Channel', Value: '$.Channel' },
        ],
      }],
    },
    Transitions: {
      NextAction: 'play-closed-chat',
      Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'play-closed-fallback' }],
    },
  });
  expect(block('play-closed-chat').Parameters.Text).toBe('$.DataTables.AfterHours.Text');
  expect(block('play-closed-chat').Transitions.NextAction).toBe('disconnect');
  expect(block('play-closed-fallback').Parameters.Text).toBe('Harbor Ridge 311 is closed right now.');
  expect(block('play-closed-fallback').Transitions.NextAction).toBe('disconnect');
  expect(JSON.stringify(flow)).not.toContain(AFTER_HOURS_CHAT_TEXT);

  expect(voice.has('lookup-closed')).toBe(false);
  expect(voice.has('play-closed-chat')).toBe(false);
  expect(block('set-voice').Transitions.NextAction).toBe('set-voicemail');
  expect(block('set-voicemail').Transitions.NextAction).toBe('play-closed');
  expect(block('play-closed').Parameters.Text).toBe(VOICE_CLOSED_PROMPT);
  expect(block('play-closed').Transitions.NextAction).toBe('start-recording');
  expect(block('start-recording').Transitions.NextAction).toBe('leave-message');
  expect(block('leave-message').Parameters.InputTimeLimitSeconds).toBe('60');
  expect(block('leave-message').Transitions.NextAction).toBe('disconnect');
  expect(JSON.stringify(block('set-voicemail').Parameters)).toContain('"Voicemail":"true"');
});

test('customer queue flow covers chat and voice', () => {
  const flow = customerQueueFlow(queueProps);
  const block = (identifier: string) => {
    const found = flow.Actions.find((action) => action.Identifier === identifier);
    if (!found) {
      throw new Error(`missing ${identifier}`);
    }
    return found;
  };
  const chat = reachable(flow, 'lookup-queue-chat');
  const voice = reachable(flow, 'lookup-queue-voice');

  expect(flow.StartAction).toBe('branch-channel');
  expect(block('branch-channel').Transitions.NextAction).toBe('lookup-queue-voice');
  expect(block('branch-channel').Transitions.Conditions?.[0]).toMatchObject({
    NextAction: 'lookup-queue-chat',
    Condition: { Operator: 'Equals', Operands: ['CHAT'] },
  });
  expect(chat.has('loop-hold')).toBe(false);
  expect(chat.has('loop-hold-fallback')).toBe(false);
  expect(voice.has('play-queue-chat')).toBe(false);
  expect(voice.has('wait-in-queue')).toBe(false);
  expect(block('play-queue-chat').Parameters.Text).toBe('$.DataTables.QueueChat.Text');
  expect(block('play-queue-chat').Transitions.NextAction).toBe('wait-in-queue');
  expect(block('wait-in-queue')).toMatchObject({
    Type: 'Wait',
    Parameters: { TimeoutSeconds: '180' },
    Transitions: { NextAction: 'wait-in-queue' },
  });
  expect(block('wait-in-queue').Transitions.NextAction).not.toBe('play-queue-chat');
  expect(block('lookup-queue-chat').Parameters.Queries).toEqual([{
    QueryName: 'QueueChat',
    Attributes: ['Text'],
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: 'Queue' },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  }]);
  expect(block('lookup-queue-voice').Parameters.Queries).toEqual([{
    QueryName: 'QueueVoice',
    Attributes: ['Text'],
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: 'Queue' },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  }]);
  expect(block('loop-hold')).toMatchObject({
    Type: 'MessageParticipantIteratively',
    Transitions: { NextAction: 'loop-hold' },
  });
  const messages = block('loop-hold').Parameters.Messages as Array<{ Text?: string; SSML?: string; PromptId?: string }>;
  expect(messages[0]?.Text).toBe('$.DataTables.QueueVoice.Text');
  expect(messages[1]?.SSML).toContain('<break time="10s"/>');
  expect(messages.some((message) => message.PromptId)).toBe(false);
  expect(block('loop-hold-fallback').Parameters.Messages).toEqual([
    { Text: QUEUE_VOICE_TEXT },
    { SSML: messages[1]?.SSML },
  ]);
  expect(block('play-queue-fallback').Parameters.Text).toBe(QUEUE_CHAT_TEXT);
  expect(JSON.stringify(flow)).not.toContain('Thank you for calling');
});

test('queue and after-hours blocks sit on a 280 pixel grid', () => {
  for (const flow of [afterHoursFlow(afterHoursProps), customerQueueFlow(queueProps)]) {
    const ids = flow.Actions.map((action) => action.Identifier);
    expect(new Set(Object.keys(flow.Metadata.ActionMetadata))).toEqual(new Set(ids));
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const a = flow.Metadata.ActionMetadata[ids[left]].position;
        const b = flow.Metadata.ActionMetadata[ids[right]].position;
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        expect(dx >= 280 || dy >= 280).toBe(true);
      }
    }
  }
});
