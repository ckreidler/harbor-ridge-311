import {
  checkHoursOfOperation,
  compare,
  connectParticipantWithLexBot,
  createCase,
  createWisdomSession,
  disconnectParticipant,
  equals,
  evaluateDataTableValues,
  exists,
  flow,
  getCase,
  invokeLambdaFunction,
  messageParticipant,
  transferContactToQueue,
  updateContactAttributes,
  updateContactEventHooks,
  updateContactTargetQueue,
  updateContactTextToSpeechVoice,
  updateFlowLoggingBehavior,
  wait,
  type DataTableQuery,
  type FlowContent,
  type InboundContactAction,
} from '../flow';

export interface MainFlowProps {
  dataTableId: string;
  wisdomAssistantArn: string;
  lexBotAliasArn: string;
  orchestratorLambdaArn: string;
  hoursOfOperationArn: string;
  queueArn: string;
  escalationGuideFlowArn: string;
  customerQueueFlowArn: string;
  caseTemplateId: string;
  requestCategoryFieldId: string;
}

export const MAIN_FLOW_NAME = 'HarborRidge311-Main';

const VOICE_GREETING = 'Thank you for calling Harbor Ridge 3 1 1. This line is a demo.';
const VOICE_GOODBYE = 'Thank you for calling Harbor Ridge 3 1 1. Goodbye.';

export const AFTER_HOURS_CASE_CHAT_TEXT = "Harbor Ridge 311 is closed right now, so we've logged your request. Your reference number is";
export const AFTER_HOURS_CASE_VOICE_TEXT = 'Harbor Ridge 3 1 1 is closed right now, so we have logged your request. Your reference number is';
export const AFTER_HOURS_CASE_TEXT_AFTER = 'Our team works Monday to Friday, 8 a.m. to 5 p.m. Pacific and will follow up then.';
export const AFTER_HOURS_CLOSED_TEXT = 'Harbor Ridge 311 is closed right now. Our team is available Monday to Friday, 8 a.m. to 5 p.m. Pacific.';
const CASE_REFERENCE_ATTRIBUTE = '$.Case.reference_number';
const AFTER_HOURS_CASE_PLAY_TEXT = `$.DataTables.AfterHoursCase.Text ${CASE_REFERENCE_ATTRIBUTE}. $.DataTables.AfterHoursCase.TextAfter`;
const AFTER_HOURS_CASE_VOICE_SSML = `<speak>$.DataTables.AfterHoursCase.Text <say-as interpret-as="digits">${CASE_REFERENCE_ATTRIBUTE}</say-as>. $.DataTables.AfterHoursCase.TextAfter</speak>`;
const CASE_HOLD_TEXT = 'One moment while we log your request.';
const CASE_HOLD_VOICE_SSML = `<speak>${CASE_HOLD_TEXT}<break time="2s"/></speak>`;
const FALLBACK_CASE_TITLE = 'After-hours escalation';

function promptQuery(
  prompt: 'Greeting' | 'Goodbye' | 'Question' | 'AfterHoursCase',
  attributes: string[] = ['Text'],
): DataTableQuery {
  return {
    QueryName: prompt,
    Attributes: attributes,
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: prompt },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  };
}

const getCaseParameters = {
  LinkContactToCase: 'false',
  GetLastUpdatedCase: 'true',
  CaseRequestFields: {
    case_id: '$.Case.case_id',
  },
  CaseResponseFields: ['reference_number'],
} as const;

export function mainFlow(props: MainFlowProps): FlowContent {
  const caseFields = (caseReason: string) => ({
    title: '$.Attributes.caseTitle',
    summary: '$.Attributes.escalationSummary',
    case_reason: caseReason,
    [props.requestCategoryFieldId]: 'other',
    status: 'open',
  });

  return flow({
    name: MAIN_FLOW_NAME,
    start: 'enable-flow-logging',
    actions: [
      updateFlowLoggingBehavior('enable-flow-logging', {
        FlowLoggingBehavior: 'Enabled',
      }, { next: 'set-en-voice' }),
      updateContactTextToSpeechVoice('set-en-voice', {
        TextToSpeechVoice: 'Joanna',
        TextToSpeechEngine: 'Neural',
      }, { next: 'lookup-prompts', error: 'lookup-prompts' }),
      evaluateDataTableValues('lookup-prompts', {
        DataTableId: props.dataTableId,
        Queries: [
          promptQuery('Greeting'),
          promptQuery('Goodbye'),
          promptQuery('Question'),
        ],
      }, { next: 'play-greeting', error: 'play-fallback' }),
      messageParticipant('play-greeting', {
        Text: '$.DataTables.Greeting.Text',
      }, { next: 'create-assistant-session', error: 'play-fallback' }),
      createWisdomSession('create-assistant-session', {
        WisdomAssistantArn: props.wisdomAssistantArn,
      }, { next: 'select-orchestrator', error: 'play-goodbye' }),
      invokeLambdaFunction('select-orchestrator', {
        LambdaFunctionARN: props.orchestratorLambdaArn,
        InvocationTimeLimitSeconds: '8',
        LambdaInvocationAttributes: {
          sessionArn: '$.Wisdom.SessionArn',
        },
      }, { next: 'ask-en-question', error: 'ask-en-question' }),
      connectParticipantWithLexBot('ask-en-question', {
        Text: '$.DataTables.Question.Text',
        LexV2Bot: {
          AliasArn: props.lexBotAliasArn,
        },
        LexSessionAttributes: {
          'x-amz-lex:q-in-connect:session-arn': '$.Wisdom.SessionArn',
        },
      }, {
        next: 'check-hours',
        timeout: 'check-hours',
        noMatch: 'check-tool',
        error: 'check-hours',
      }),
      compare('check-tool', {
        ComparisonValue: '$.Lex.SessionAttributes.Tool',
      }, {
        next: 'play-goodbye',
        conditions: [
          equals('Complete', 'play-goodbye'),
          equals('Escalate', 'set-escalation'),
        ],
        noMatch: 'check-hours',
      }),
      updateContactAttributes('set-escalation', {
        Attributes: {
          escalationReason: '$.Lex.SessionAttributes.escalationReason',
          escalationSummary: '$.Lex.SessionAttributes.escalationSummary',
          customerIntent: '$.Lex.SessionAttributes.customerIntent',
          sentiment: '$.Lex.SessionAttributes.sentiment',
        },
        TargetContact: 'Current',
      }, { next: 'check-hours', error: 'check-hours' }),
      checkHoursOfOperation('check-hours', {
        HoursOfOperationId: props.hoursOfOperationArn,
      }, {
        next: 'set-event-flow',
        inHours: 'set-event-flow',
        outOfHours: 'check-case-title',
        error: 'check-case-title',
      }),
      updateContactEventHooks('set-event-flow', {
        EventHooks: {
          DefaultAgentUI: props.escalationGuideFlowArn,
        },
      }, { next: 'set-working-queue', error: 'play-goodbye' }),
      updateContactTargetQueue('set-working-queue', {
        QueueId: props.queueArn,
      }, { next: 'set-customer-queue', error: 'play-goodbye' }),
      updateContactEventHooks('set-customer-queue', {
        EventHooks: {
          CustomerQueue: props.customerQueueFlowArn,
        },
      }, { next: 'transfer-to-queue', error: 'transfer-to-queue' }),
      transferContactToQueue('transfer-to-queue', {
        next: 'play-goodbye',
        atCapacity: 'play-goodbye',
        error: 'play-goodbye',
      }),
      compare('check-case-title', {
        ComparisonValue: '$.Attributes.customerIntent',
      }, {
        next: 'set-fallback-title',
        conditions: [exists('set-case-title')],
        noMatch: 'set-fallback-title',
      }),
      updateContactAttributes('set-case-title', {
        Attributes: {
          caseTitle: '$.Attributes.customerIntent',
        },
        TargetContact: 'Current',
      }, { next: 'create-case', error: 'set-fallback-title' }),
      updateContactAttributes('set-fallback-title', {
        Attributes: {
          caseTitle: FALLBACK_CASE_TITLE,
        },
        TargetContact: 'Current',
      }, { next: 'create-case', error: 'play-closed' }),
      createCase('create-case', {
        LinkContactToCase: 'true',
        CaseTemplateId: props.caseTemplateId,
        CaseRequestFields: caseFields('$.Attributes.escalationReason'),
      }, { next: 'get-case', notLinked: 'get-case', error: 'create-case-other' }),
      createCase('create-case-other', {
        LinkContactToCase: 'true',
        CaseTemplateId: props.caseTemplateId,
        CaseRequestFields: caseFields('other'),
      }, { next: 'get-case', notLinked: 'get-case', error: 'play-closed' }),
      getCase('get-case', getCaseParameters, {
        next: 'lookup-after-hours-case',
        error: 'branch-case-hold',
        noneFound: 'branch-case-hold',
        multipleFound: 'branch-case-hold',
      }),
      compare('branch-case-hold', {
        ComparisonValue: '$.Channel',
      }, {
        next: 'play-case-hold-voice',
        conditions: [equals('CHAT', 'play-case-hold-chat')],
        noMatch: 'play-case-hold-voice',
      }),
      messageParticipant('play-case-hold-chat', {
        Text: CASE_HOLD_TEXT,
      }, { next: 'wait-case', error: 'wait-case' }),
      wait('wait-case', {
        TimeLimitSeconds: '3',
      }, { next: 'get-case-retry', completed: 'get-case-retry', error: 'get-case-retry' }),
      messageParticipant('play-case-hold-voice', {
        SSML: CASE_HOLD_VOICE_SSML,
      }, { next: 'get-case-retry', error: 'get-case-retry' }),
      getCase('get-case-retry', getCaseParameters, {
        next: 'lookup-after-hours-case',
        error: 'play-closed',
        noneFound: 'play-closed',
        multipleFound: 'play-closed',
      }),
      evaluateDataTableValues('lookup-after-hours-case', {
        DataTableId: props.dataTableId,
        Queries: [promptQuery('AfterHoursCase', ['Text', 'TextAfter'])],
      }, { next: 'check-case-prompt', error: 'play-closed' }),
      compare('check-case-prompt', {
        ComparisonValue: '$.DataTables.AfterHoursCase.Text',
      }, {
        next: 'play-closed',
        conditions: [exists('check-reference')],
        noMatch: 'play-closed',
      }),
      compare('check-reference', {
        ComparisonValue: CASE_REFERENCE_ATTRIBUTE,
      }, {
        next: 'play-closed',
        conditions: [exists('branch-case-channel')],
        noMatch: 'play-closed',
      }),
      compare('branch-case-channel', {
        ComparisonValue: '$.Channel',
      }, {
        next: 'play-case-voice',
        conditions: [equals('CHAT', 'play-case-chat')],
        noMatch: 'play-case-voice',
      }),
      messageParticipant('play-case-chat', {
        Text: AFTER_HOURS_CASE_PLAY_TEXT,
      }, { next: 'disconnect', error: 'play-closed' }),
      messageParticipant('play-case-voice', {
        SSML: AFTER_HOURS_CASE_VOICE_SSML,
      }, { next: 'disconnect', error: 'play-closed' }),
      messageParticipant('play-closed', {
        Text: AFTER_HOURS_CLOSED_TEXT,
      }, { next: 'disconnect', error: 'disconnect' }),
      messageParticipant('play-goodbye', {
        Text: '$.DataTables.Goodbye.Text',
      }, { next: 'disconnect', error: 'disconnect' }),
      messageParticipant('play-fallback', {
        Text: `${VOICE_GREETING} ${VOICE_GOODBYE}`,
      }, { next: 'disconnect', error: 'disconnect' }),
      disconnectParticipant('disconnect'),
    ] satisfies readonly InboundContactAction[],
  });
}
