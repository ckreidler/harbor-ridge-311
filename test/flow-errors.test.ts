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
  GetCustomerProfile: ['NoMatchingError', 'NoneFoundError', 'MultipleFoundError'],
  CreateCustomerProfile: ['NoMatchingError'],
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
  ticketLambdaArn: 'ticket-lambda',
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
    mainFlow(flowProps).content,
    customerQueueFlow(queueProps).content,
    escalationGuideFlow({ detailViewArn }).content,
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
    mainFlow(flowProps).content,
    customerQueueFlow(queueProps).content,
    escalationGuideFlow({ detailViewArn }).content,
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
  const flow = mainFlow(flowProps).content;
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
  expect(flow.Actions.some((action) => action.Identifier === 'clear-identity')).toBe(false);
  expect(block('play-greeting').Transitions).toMatchObject({
    NextAction: 'branch-identity',
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
  const flow = mainFlow(flowProps).content;
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
  expect(next('check-hours', 'False')).toBe('check-ticket-subject');
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

  const guide = escalationGuideFlow({ detailViewArn }).content;
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

test('phone callers are matched by ANI and chat does not use email', () => {
  const flow = mainFlow(flowProps).content;
  const block = (identifier: string) => {
    const found = flow.Actions.find((action) => action.Identifier === identifier);
    if (!found) throw new Error(`missing ${identifier}`);
    return found;
  };

  expect(block('branch-identity').Parameters.ComparisonValue).toBe('$.Channel');
  expect(block('branch-identity').Transitions.Conditions?.[0]).toMatchObject({
    NextAction: 'create-profile-chat',
    Condition: { Operator: 'Equals', Operands: ['CHAT'] },
  });
  expect(block('branch-identity').Transitions.NextAction).toBe('check-caller-phone');
  expect(flow.Actions.some((action) => action.Identifier === 'check-chat-email')).toBe(false);
  expect(flow.Actions.some((action) => action.Identifier === 'find-profile-email')).toBe(false);
  expect(JSON.stringify(flow)).not.toContain('_email');
  expect(JSON.stringify(flow)).not.toContain('Attributes.email');
  expect(block('create-profile-chat').Parameters.ProfileRequestData).toEqual({
    AccountNumber: '$.ContactId',
    FirstName: 'Resident',
  });
  expect(block('create-profile-chat').Transitions.Errors).toEqual([
    { ErrorType: 'NoMatchingError', NextAction: 'create-assistant-session' },
  ]);
  expect(JSON.stringify(block('set-chat-identity').Parameters)).toContain('"identitySource":"chat"');
  expect(JSON.stringify(block('set-chat-identity').Parameters)).not.toContain('contactChannel');
  expect(block('check-caller-phone').Parameters.ComparisonValue).toBe('$.CustomerEndpoint.Address');
  expect(block('find-profile-phone').Parameters.ProfileRequestData).toEqual({
    IdentifierName: '_phone',
    IdentifierValue: '$.CustomerEndpoint.Address',
  });
  expect(block('create-profile-phone').Parameters.ProfileRequestData).toEqual({
    PhoneNumber: '$.CustomerEndpoint.Address',
    FirstName: 'Resident',
  });
  expect(block('create-profile-phone').Transitions.Errors).toEqual([
    { ErrorType: 'NoMatchingError', NextAction: 'create-assistant-session' },
  ]);
  expect(JSON.stringify(block('set-customer-id').Parameters)).toContain('"customerId":"$.Customer.ProfileId"');
  expect(JSON.stringify(block('set-customer-id').Parameters)).toContain('"identitySource":"ani"');
  expect(JSON.stringify(block('set-customer-id').Parameters)).not.toContain('contactChannel');
  expect(block('set-customer-id').Transitions.NextAction).toBe('create-assistant-session');
  expect(block('set-customer-id').Transitions.Errors?.[0].NextAction).toBe('create-assistant-session');
  expect(JSON.stringify(block('select-orchestrator').Parameters)).toContain('"customerId":"$.Attributes.customerId"');
});

test('after-hours escalation creates a ticket, speaks the id, and disconnects', () => {
  const flow = mainFlow(flowProps).content;
  const block = (identifier: string) => {
    const found = flow.Actions.find((action) => action.Identifier === identifier);
    if (!found) throw new Error(`missing ${identifier}`);
    return found;
  };
  const closed = reachable(flow, 'check-ticket-subject');
  const open = reachable(flow, 'set-event-flow');

  expect(closed.has('disconnect')).toBe(true);
  expect(closed.has('play-closed')).toBe(true);
  expect(closed.has('create-ticket')).toBe(true);
  expect(closed.has('play-ticket-chat')).toBe(true);
  expect(closed.has('play-ticket-voice')).toBe(true);
  expect(closed.has('transfer-to-queue')).toBe(false);
  expect(closed.has('set-event-flow')).toBe(false);
  expect(open.has('check-ticket-subject')).toBe(false);
  expect(open.has('create-ticket')).toBe(false);
  expect(flow.Actions.some((action) => action.Type === 'Wait')).toBe(false);
  expect(JSON.stringify(flow)).not.toContain('CreateCase');
  expect(JSON.stringify(flow)).not.toContain('GetCase');

  expect(block('check-ticket-subject').Parameters.ComparisonValue).toBe('$.Attributes.customerIntent');
  expect(block('check-ticket-subject').Transitions.Conditions?.[0].Condition.Operands).toEqual([]);
  expect(JSON.stringify(block('set-ticket-subject').Parameters)).toContain('"ticketSubject":"$.Attributes.customerIntent"');
  expect(JSON.stringify(block('set-fallback-subject').Parameters)).toContain('"ticketSubject":"After-hours request"');
  expect(block('check-customer-id').Transitions.NextAction).toBe('play-closed');
  expect(block('check-customer-id').Transitions.Conditions?.[0]).toMatchObject({
    NextAction: 'create-ticket',
    Condition: { Operator: 'Exists', Operands: [] },
  });
  expect(block('create-ticket')).toMatchObject({
    Type: 'InvokeLambdaFunction',
    Parameters: { LambdaFunctionARN: 'ticket-lambda', InvocationTimeLimitSeconds: '8' },
    Transitions: {
      NextAction: 'check-ticket-id',
      Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'play-closed' }],
    },
  });
  expect(block('check-ticket-id').Parameters.ComparisonValue).toBe('$.External.ticketId');
  expect(block('lookup-after-hours-ticket').Parameters.Queries).toEqual([{
    QueryName: 'AfterHoursTicket',
    Attributes: ['Text', 'TextAfter'],
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: 'AfterHoursTicket' },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  }]);
  expect(block('check-ticket-prompt').Transitions.Conditions?.[0].Condition.Operator).toBe('Exists');
  expect(block('branch-ticket-channel').Transitions.Conditions?.[0]).toMatchObject({
    NextAction: 'play-ticket-chat',
    Condition: { Operator: 'Equals', Operands: ['CHAT'] },
  });
  expect(block('branch-ticket-channel').Transitions.NextAction).toBe('play-ticket-voice');
  expect(block('play-ticket-chat').Parameters).toEqual({
    Text: '$.DataTables.AfterHoursTicket.Text $.External.ticketId. $.DataTables.AfterHoursTicket.TextAfter',
  });
  expect(block('play-ticket-chat').Transitions.NextAction).toBe('disconnect');
  expect(block('play-ticket-voice').Parameters).toEqual({
    SSML: '<speak>$.DataTables.AfterHoursTicket.Text <say-as interpret-as="characters">$.External.ticketId</say-as>. $.DataTables.AfterHoursTicket.TextAfter</speak>',
  });
  expect(block('play-ticket-voice').Transitions.NextAction).toBe('disconnect');
  expect(block('play-ticket-voice').Transitions.Errors?.[0].NextAction).toBe('play-closed');
  expect(block('play-closed').Parameters.Text).toBe(AFTER_HOURS_CLOSED_TEXT);
  expect(block('play-closed').Transitions).toMatchObject({
    NextAction: 'disconnect',
    Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'disconnect' }],
  });
  expect(JSON.stringify(flow.Actions)).not.toContain('TransferToFlow');
  expect(JSON.stringify(flow.Actions)).not.toContain('UpdateContactRecordingBehavior');
});

test('customer queue flow covers chat and voice', () => {
  const flow = customerQueueFlow(queueProps).content;
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
    mainFlow(flowProps).content,
    customerQueueFlow(queueProps).content,
    escalationGuideFlow({ detailViewArn }).content,
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
  const queueWait = customerQueueFlow(queueProps).content.Actions.find((action) => action.Identifier === 'wait-in-queue');
  expect(queueWait?.Parameters.TimeLimitSeconds).toBe('180');
  expect(queueWait?.Transitions.NextAction).toBe('wait-in-queue');
  expect(queueWait?.Transitions.Conditions?.[0].NextAction).toBe('wait-in-queue');
});
