import { escalationGuideFlow } from '../lib/flows/escalation-guide-flow';
import { AFTER_HOURS_CLOSED_TEXT, mainFlow } from '../lib/flows/main-flow';
import { customerQueueFlow, QUEUE_CHAT_TEXT, QUEUE_VOICE_TEXT } from '../lib/flows/queue-flow';

const allowedErrors: Record<string, readonly string[]> = {
  UpdateFlowLoggingBehavior: [],
  CheckHoursOfOperation: ['NoMatchingError'],
  UpdateContactTextToSpeechVoice: ['NoMatchingError'],
  EvaluateDataTableValues: ['NoMatchingError'],
  MessageParticipant: ['NoMatchingError'],
  CreateWisdomSession: ['NoMatchingError'],
  Compare: ['NoMatchingCondition'],
  ConnectParticipantWithLexBot: ['InputTimeLimitExceeded', 'NoMatchingCondition', 'NoMatchingError'],
  InvokeLambdaFunction: ['NoMatchingError'],
  DisconnectParticipant: [],
  UpdateContactAttributes: ['NoMatchingError'],
  UpdateContactEventHooks: ['NoMatchingError'],
  UpdateContactTargetQueue: ['NoMatchingError'],
  TransferContactToQueue: ['QueueAtCapacity', 'NoMatchingError'],
  ShowView: ['NoMatchingError', 'NoMatchingCondition', 'TimeLimitExceeded'],
  Wait: ['NoMatchingError'],
  MessageParticipantIteratively: ['NoMatchingError'],
  CreateCase: ['ContactNotLinked', 'NoMatchingError'],
  GetCase: ['NoMatchingError', 'NoneFound', 'MultipleFound', 'ContactNotLinked'],
};

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

const queueProps = { dataTableId: 'table', holdMusicPromptArn: 'hold-music' };

function reachable(flow: {
  Actions: Array<{
    Identifier: string;
    Transitions: {
      NextAction?: string;
      Errors?: Array<{ NextAction: string }>;
      Conditions?: Array<{ NextAction: string }>;
    };
  }>;
}, start: string): Set<string> {
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
});

test('compare conditions do not use an empty-string operand', () => {
  const flows = [
    mainFlow(flowProps),
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
  expect(next('check-hours', 'False')).toBe('check-case-title');
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

test('after-hours escalation creates a case, speaks the reference, and disconnects', () => {
  const flow = mainFlow(flowProps);
  const block = (identifier: string) => {
    const found = flow.Actions.find((action) => action.Identifier === identifier);
    if (!found) {
      throw new Error(`missing ${identifier}`);
    }
    return found;
  };
  const closed = reachable(flow, 'check-case-title');
  const open = reachable(flow, 'set-event-flow');

  expect(closed.has('disconnect')).toBe(true);
  expect(closed.has('play-closed')).toBe(true);
  expect(closed.has('create-case')).toBe(true);
  expect(closed.has('create-case-other')).toBe(true);
  expect(closed.has('get-case')).toBe(true);
  expect(closed.has('get-case-retry')).toBe(true);
  expect(closed.has('wait-case')).toBe(true);
  expect(closed.has('play-case-hold-chat')).toBe(true);
  expect(closed.has('play-case-hold-voice')).toBe(true);
  expect(closed.has('check-reference')).toBe(true);
  expect(closed.has('play-case-chat')).toBe(true);
  expect(closed.has('play-case-voice')).toBe(true);
  expect(closed.has('transfer-to-queue')).toBe(false);
  expect(closed.has('set-event-flow')).toBe(false);
  expect(open.has('check-case-title')).toBe(false);
  expect(open.has('create-case')).toBe(false);
  expect(flow.Actions.some((action) => action.Identifier === 'create-profile')).toBe(false);

  expect(block('create-case').Parameters).toEqual({
    LinkContactToCase: 'true',
    CaseTemplateId: 'template',
    CaseRequestFields: {
      title: '$.Attributes.caseTitle',
      summary: '$.Attributes.escalationSummary',
      case_reason: '$.Attributes.escalationReason',
      '137be1e8-7eac-4741-9a3b-18aedbdcf77b': 'other',
      status: 'open',
    },
  });
  expect(block('create-case').Transitions.Errors).toEqual([
    { ErrorType: 'ContactNotLinked', NextAction: 'get-case' },
    { ErrorType: 'NoMatchingError', NextAction: 'create-case-other' },
  ]);
  expect(block('create-case-other').Parameters).toEqual({
    LinkContactToCase: 'true',
    CaseTemplateId: 'template',
    CaseRequestFields: {
      title: '$.Attributes.caseTitle',
      summary: '$.Attributes.escalationSummary',
      case_reason: 'other',
      '137be1e8-7eac-4741-9a3b-18aedbdcf77b': 'other',
      status: 'open',
    },
  });
  expect(block('create-case-other').Transitions.NextAction).toBe('get-case');
  expect(block('create-case-other').Transitions.Errors).toEqual([
    { ErrorType: 'ContactNotLinked', NextAction: 'get-case' },
    { ErrorType: 'NoMatchingError', NextAction: 'play-closed' },
  ]);
  const getCaseParameters = {
    LinkContactToCase: 'false',
    GetLastUpdatedCase: 'true',
    CaseRequestFields: { case_id: '$.Case.case_id' },
    CaseResponseFields: ['reference_number'],
  };
  expect(block('get-case').Parameters).toEqual(getCaseParameters);
  expect(block('get-case').Transitions.Errors).toEqual([
    { ErrorType: 'NoMatchingError', NextAction: 'branch-case-hold' },
    { ErrorType: 'NoneFound', NextAction: 'branch-case-hold' },
    { ErrorType: 'MultipleFound', NextAction: 'branch-case-hold' },
  ]);
  expect(block('branch-case-hold').Transitions.Conditions?.[0]).toMatchObject({
    NextAction: 'play-case-hold-chat',
    Condition: { Operator: 'Equals', Operands: ['CHAT'] },
  });
  expect(block('branch-case-hold').Transitions.NextAction).toBe('play-case-hold-voice');
  expect(block('play-case-hold-chat').Parameters).toEqual({
    Text: 'One moment while we log your request.',
  });
  expect(block('play-case-hold-chat').Transitions.NextAction).toBe('wait-case');
  expect(block('wait-case')).toMatchObject({
    Type: 'Wait',
    Parameters: { TimeLimitSeconds: '3' },
    Transitions: {
      NextAction: 'get-case-retry',
      Conditions: [
        {
          NextAction: 'get-case-retry',
          Condition: { Operator: 'Equals', Operands: ['WaitCompleted'] },
        },
      ],
    },
  });
  expect(block('play-case-hold-voice').Parameters).toEqual({
    SSML: '<speak>One moment while we log your request.<break time="2s"/></speak>',
  });
  expect(block('play-case-hold-voice').Transitions.NextAction).toBe('get-case-retry');
  expect(reachable(flow, 'play-case-hold-voice').has('wait-case')).toBe(false);
  expect(block('get-case-retry').Parameters).toEqual(getCaseParameters);
  expect(block('get-case-retry').Transitions.NextAction).toBe('lookup-after-hours-case');
  expect(block('get-case-retry').Transitions.Errors).toEqual([
    { ErrorType: 'NoMatchingError', NextAction: 'play-closed' },
    { ErrorType: 'NoneFound', NextAction: 'play-closed' },
    { ErrorType: 'MultipleFound', NextAction: 'play-closed' },
  ]);
  expect(block('lookup-after-hours-case').Parameters.Queries).toEqual([{
    QueryName: 'AfterHoursCase',
    Attributes: ['Text', 'TextAfter'],
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: 'AfterHoursCase' },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  }]);
  expect(block('check-reference').Parameters.ComparisonValue).toBe('$.Case.reference_number');
  expect(block('check-reference').Transitions.Conditions?.[0]).toMatchObject({
    NextAction: 'branch-case-channel',
    Condition: { Operator: 'Exists', Operands: [] },
  });
  expect(block('check-reference').Transitions.NextAction).toBe('play-closed');
  expect(block('branch-case-channel').Transitions.Conditions?.[0]).toMatchObject({
    NextAction: 'play-case-chat',
    Condition: { Operator: 'Equals', Operands: ['CHAT'] },
  });
  expect(block('branch-case-channel').Transitions.NextAction).toBe('play-case-voice');
  expect(block('play-case-chat').Parameters).toEqual({
    Text: '$.DataTables.AfterHoursCase.Text $.Case.reference_number. $.DataTables.AfterHoursCase.TextAfter',
  });
  expect(block('play-case-chat').Transitions.NextAction).toBe('disconnect');
  expect(block('play-case-voice').Parameters).toEqual({
    SSML: '<speak>$.DataTables.AfterHoursCase.Text <say-as interpret-as="digits">$.Case.reference_number</say-as>. $.DataTables.AfterHoursCase.TextAfter</speak>',
  });
  expect(block('play-case-voice').Transitions.NextAction).toBe('disconnect');
  expect(block('play-case-voice').Transitions.Errors?.[0].NextAction).toBe('play-closed');
  expect(block('play-closed').Parameters.Text).toBe(AFTER_HOURS_CLOSED_TEXT);
  expect(block('play-closed').Transitions).toMatchObject({
    NextAction: 'disconnect',
    Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'disconnect' }],
  });
  expect(block('check-case-title').Transitions.Conditions?.[0].Condition.Operands).toEqual([]);
  expect(block('check-case-prompt').Transitions.Conditions?.[0].Condition.Operator).toBe('Exists');
  expect(JSON.stringify(flow.Actions)).not.toContain('TransferToFlow');
  expect(JSON.stringify(flow.Actions)).not.toContain('UpdateContactRecordingBehavior');
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
    Parameters: { TimeLimitSeconds: '180' },
    Transitions: {
      NextAction: 'wait-in-queue',
      Conditions: [
        {
          NextAction: 'wait-in-queue',
          Condition: { Operator: 'Equals', Operands: ['WaitCompleted'] },
        },
      ],
    },
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
  expect(block('loop-hold').Parameters.Messages).toEqual([
    { Text: '$.DataTables.QueueVoice.Text' },
    { PromptId: 'hold-music' },
  ]);
  expect(block('loop-hold-fallback').Parameters.Messages).toEqual([
    { Text: QUEUE_VOICE_TEXT },
    { PromptId: 'hold-music' },
  ]);
  expect(JSON.stringify(flow)).not.toContain('SSML');
  expect(JSON.stringify(flow)).not.toContain('666650f7-db8f-435f-bc27-77644f59f6bb');
  expect(block('play-queue-fallback').Parameters.Text).toBe(QUEUE_CHAT_TEXT);
  expect(JSON.stringify(flow)).not.toContain('Thank you for calling');
});

test('wait actions use TimeLimitSeconds', () => {
  const flows = [
    mainFlow(flowProps),
    customerQueueFlow(queueProps),
    escalationGuideFlow({ detailViewArn }),
  ];
  const waits = flows.flatMap((flow) => flow.Actions.filter((action) => action.Type === 'Wait'));
  expect(waits.length).toBeGreaterThan(0);
  for (const wait of waits) {
    expect(typeof wait.Parameters.TimeLimitSeconds).toBe('string');
    expect(wait.Parameters.TimeLimitSeconds).not.toBe('');
    expect(Object.keys(wait.Parameters)).toEqual(['TimeLimitSeconds']);
    expect(JSON.stringify(wait)).not.toContain('TimeoutSeconds');
    expect(wait.Transitions.Conditions).toEqual([
      {
        NextAction: expect.any(String),
        Condition: { Operator: 'Equals', Operands: ['WaitCompleted'] },
      },
    ]);
  }
  const queueWait = customerQueueFlow(queueProps).Actions.find((action) => action.Identifier === 'wait-in-queue');
  expect(queueWait?.Parameters.TimeLimitSeconds).toBe('180');
  expect(queueWait?.Transitions.NextAction).toBe('wait-in-queue');
  expect(queueWait?.Transitions.Conditions?.[0].NextAction).toBe('wait-in-queue');
});
