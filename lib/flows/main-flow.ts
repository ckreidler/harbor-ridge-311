type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface FlowError {
  ErrorType: string;
  NextAction: string;
}

interface FlowCondition {
  NextAction: string;
  Condition: {
    Operator: 'Equals' | 'Exists';
    Operands: string[];
  };
}

interface FlowAction {
  Identifier: string;
  Type: string;
  Parameters: { [key: string]: Json };
  Transitions: {
    NextAction?: string;
    Errors?: FlowError[];
    Conditions?: FlowCondition[];
  };
}

interface ContactFlowContent {
  Version: '2019-10-30';
  StartAction: string;
  Metadata: {
    entryPointPosition: { x: number; y: number };
    ActionMetadata: Record<string, { position: { x: number; y: number } }>;
  };
  Actions: FlowAction[];
}

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
) {
  return {
    QueryName: prompt,
    Attributes: attributes,
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: prompt },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  };
}

function errorTo(nextAction: string): FlowError[] {
  return [{ ErrorType: 'NoMatchingError', NextAction: nextAction }];
}

function exists(nextAction: string): FlowCondition {
  return {
    NextAction: nextAction,
    Condition: { Operator: 'Exists', Operands: [] },
  };
}

export function mainFlow(props: MainFlowProps): ContactFlowContent {
  return {
    Version: '2019-10-30',
    StartAction: 'enable-flow-logging',
    Metadata: {
      entryPointPosition: { x: 40, y: 360 },
      ActionMetadata: {
        'enable-flow-logging': { position: { x: 160, y: 360 } },
        'set-en-voice': { position: { x: 440, y: 360 } },
        'lookup-prompts': { position: { x: 720, y: 360 } },
        'play-greeting': { position: { x: 1000, y: 360 } },
        'play-fallback': { position: { x: 1000, y: 640 } },
        'create-assistant-session': { position: { x: 1280, y: 360 } },
        'select-orchestrator': { position: { x: 1560, y: 360 } },
        'ask-en-question': { position: { x: 1840, y: 360 } },
        'check-tool': { position: { x: 2120, y: 360 } },
        'play-goodbye': { position: { x: 2400, y: 80 } },
        'set-escalation': { position: { x: 2400, y: 640 } },
        'check-hours': { position: { x: 2680, y: 640 } },
        'set-event-flow': { position: { x: 2960, y: 640 } },
        'set-working-queue': { position: { x: 3240, y: 640 } },
        'set-customer-queue': { position: { x: 3520, y: 640 } },
        'transfer-to-queue': { position: { x: 3800, y: 640 } },
        'check-case-title': { position: { x: 3240, y: 920 } },
        'set-case-title': { position: { x: 3520, y: 920 } },
        'set-fallback-title': { position: { x: 3520, y: 1200 } },
        'create-case': { position: { x: 3800, y: 920 } },
        'create-case-other': { position: { x: 3800, y: 1200 } },
        'get-case': { position: { x: 4080, y: 920 } },
        'branch-case-hold': { position: { x: 4080, y: 1200 } },
        'play-case-hold-chat': { position: { x: 4360, y: 1200 } },
        'wait-case': { position: { x: 4640, y: 1200 } },
        'get-case-retry': { position: { x: 4920, y: 1200 } },
        'play-case-hold-voice': { position: { x: 4360, y: 1480 } },
        'lookup-after-hours-case': { position: { x: 4360, y: 920 } },
        'check-case-prompt': { position: { x: 4640, y: 920 } },
        'check-reference': { position: { x: 4920, y: 920 } },
        'branch-case-channel': { position: { x: 5200, y: 920 } },
        'play-case-chat': { position: { x: 5480, y: 920 } },
        'play-case-voice': { position: { x: 5480, y: 1200 } },
        'play-closed': { position: { x: 3240, y: 1200 } },
        disconnect: { position: { x: 3240, y: 360 } },
      },
    },
    Actions: [
      {
        Identifier: 'enable-flow-logging',
        Type: 'UpdateFlowLoggingBehavior',
        Parameters: {
          FlowLoggingBehavior: 'Enabled',
        },
        Transitions: {
          NextAction: 'set-en-voice',
        },
      },
      {
        Identifier: 'set-en-voice',
        Type: 'UpdateContactTextToSpeechVoice',
        Parameters: {
          TextToSpeechVoice: 'Joanna',
          TextToSpeechEngine: 'Neural',
        },
        Transitions: {
          NextAction: 'lookup-prompts',
          Errors: errorTo('lookup-prompts'),
          Conditions: [],
        },
      },
      {
        Identifier: 'lookup-prompts',
        Type: 'EvaluateDataTableValues',
        Parameters: {
          DataTableId: props.dataTableId,
          Queries: [
            promptQuery('Greeting'),
            promptQuery('Goodbye'),
            promptQuery('Question'),
          ],
        },
        Transitions: {
          NextAction: 'play-greeting',
          Errors: errorTo('play-fallback'),
          Conditions: [],
        },
      },
      {
        Identifier: 'play-greeting',
        Type: 'MessageParticipant',
        Parameters: {
          Text: '$.DataTables.Greeting.Text',
        },
        Transitions: {
          NextAction: 'create-assistant-session',
          Errors: errorTo('play-fallback'),
          Conditions: [],
        },
      },
      {
        Identifier: 'create-assistant-session',
        Type: 'CreateWisdomSession',
        Parameters: {
          WisdomAssistantArn: props.wisdomAssistantArn,
        },
        Transitions: {
          NextAction: 'select-orchestrator',
          Errors: errorTo('play-goodbye'),
          Conditions: [],
        },
      },
      {
        Identifier: 'select-orchestrator',
        Type: 'InvokeLambdaFunction',
        Parameters: {
          LambdaFunctionARN: props.orchestratorLambdaArn,
          InvocationTimeLimitSeconds: '8',
          LambdaInvocationAttributes: {
            sessionArn: '$.Wisdom.SessionArn',
          },
        },
        Transitions: {
          NextAction: 'ask-en-question',
          Errors: errorTo('ask-en-question'),
          Conditions: [],
        },
      },
      {
        Identifier: 'ask-en-question',
        Type: 'ConnectParticipantWithLexBot',
        Parameters: {
          Text: '$.DataTables.Question.Text',
          LexV2Bot: {
            AliasArn: props.lexBotAliasArn,
          },
          LexSessionAttributes: {
            'x-amz-lex:q-in-connect:session-arn': '$.Wisdom.SessionArn',
          },
        },
        Transitions: {
          NextAction: 'check-hours',
          Errors: [
            { ErrorType: 'InputTimeLimitExceeded', NextAction: 'check-hours' },
            { ErrorType: 'NoMatchingCondition', NextAction: 'check-tool' },
            { ErrorType: 'NoMatchingError', NextAction: 'check-hours' },
          ],
          Conditions: [],
        },
      },
      {
        Identifier: 'check-tool',
        Type: 'Compare',
        Parameters: {
          ComparisonValue: '$.Lex.SessionAttributes.Tool',
        },
        Transitions: {
          NextAction: 'play-goodbye',
          Conditions: [
            {
              NextAction: 'play-goodbye',
              Condition: { Operator: 'Equals', Operands: ['Complete'] },
            },
            {
              NextAction: 'set-escalation',
              Condition: { Operator: 'Equals', Operands: ['Escalate'] },
            },
          ],
          Errors: [
            { ErrorType: 'NoMatchingCondition', NextAction: 'check-hours' },
          ],
        },
      },
      {
        Identifier: 'set-escalation',
        Type: 'UpdateContactAttributes',
        Parameters: {
          Attributes: {
            escalationReason: '$.Lex.SessionAttributes.escalationReason',
            escalationSummary: '$.Lex.SessionAttributes.escalationSummary',
            customerIntent: '$.Lex.SessionAttributes.customerIntent',
            sentiment: '$.Lex.SessionAttributes.sentiment',
          },
          TargetContact: 'Current',
        },
        Transitions: {
          NextAction: 'check-hours',
          Errors: errorTo('check-hours'),
          Conditions: [],
        },
      },
      {
        Identifier: 'check-hours',
        Type: 'CheckHoursOfOperation',
        Parameters: {
          HoursOfOperationId: props.hoursOfOperationArn,
        },
        Transitions: {
          NextAction: 'set-event-flow',
          Conditions: [
            {
              NextAction: 'set-event-flow',
              Condition: { Operator: 'Equals', Operands: ['True'] },
            },
            {
              NextAction: 'check-case-title',
              Condition: { Operator: 'Equals', Operands: ['False'] },
            },
          ],
          Errors: errorTo('check-case-title'),
        },
      },
      {
        Identifier: 'set-event-flow',
        Type: 'UpdateContactEventHooks',
        Parameters: {
          EventHooks: {
            DefaultAgentUI: props.escalationGuideFlowArn,
          },
        },
        Transitions: {
          NextAction: 'set-working-queue',
          Errors: errorTo('play-goodbye'),
          Conditions: [],
        },
      },
      {
        Identifier: 'set-working-queue',
        Type: 'UpdateContactTargetQueue',
        Parameters: {
          QueueId: props.queueArn,
        },
        Transitions: {
          NextAction: 'set-customer-queue',
          Errors: errorTo('play-goodbye'),
          Conditions: [],
        },
      },
      {
        Identifier: 'set-customer-queue',
        Type: 'UpdateContactEventHooks',
        Parameters: {
          EventHooks: {
            CustomerQueue: props.customerQueueFlowArn,
          },
        },
        Transitions: {
          NextAction: 'transfer-to-queue',
          Errors: errorTo('transfer-to-queue'),
          Conditions: [],
        },
      },
      {
        Identifier: 'transfer-to-queue',
        Type: 'TransferContactToQueue',
        Parameters: {},
        Transitions: {
          NextAction: 'play-goodbye',
          Errors: [
            { ErrorType: 'QueueAtCapacity', NextAction: 'play-goodbye' },
            { ErrorType: 'NoMatchingError', NextAction: 'play-goodbye' },
          ],
          Conditions: [],
        },
      },
      {
        Identifier: 'check-case-title',
        Type: 'Compare',
        Parameters: {
          ComparisonValue: '$.Attributes.customerIntent',
        },
        Transitions: {
          NextAction: 'set-fallback-title',
          Conditions: [exists('set-case-title')],
          Errors: [
            { ErrorType: 'NoMatchingCondition', NextAction: 'set-fallback-title' },
          ],
        },
      },
      {
        Identifier: 'set-case-title',
        Type: 'UpdateContactAttributes',
        Parameters: {
          Attributes: {
            caseTitle: '$.Attributes.customerIntent',
          },
          TargetContact: 'Current',
        },
        Transitions: {
          NextAction: 'create-case',
          Errors: errorTo('set-fallback-title'),
          Conditions: [],
        },
      },
      {
        Identifier: 'set-fallback-title',
        Type: 'UpdateContactAttributes',
        Parameters: {
          Attributes: {
            caseTitle: FALLBACK_CASE_TITLE,
          },
          TargetContact: 'Current',
        },
        Transitions: {
          NextAction: 'create-case',
          Errors: errorTo('play-closed'),
          Conditions: [],
        },
      },
      {
        Identifier: 'create-case',
        Type: 'CreateCase',
        Parameters: {
          LinkContactToCase: 'true',
          CaseTemplateId: props.caseTemplateId,
          CaseRequestFields: {
            title: '$.Attributes.caseTitle',
            summary: '$.Attributes.escalationSummary',
            case_reason: '$.Attributes.escalationReason',
            [props.requestCategoryFieldId]: 'other',
            status: 'open',
          },
        },
        Transitions: {
          NextAction: 'get-case',
          Errors: [
            { ErrorType: 'ContactNotLinked', NextAction: 'get-case' },
            { ErrorType: 'NoMatchingError', NextAction: 'create-case-other' },
          ],
          Conditions: [],
        },
      },
      {
        Identifier: 'create-case-other',
        Type: 'CreateCase',
        Parameters: {
          LinkContactToCase: 'true',
          CaseTemplateId: props.caseTemplateId,
          CaseRequestFields: {
            title: '$.Attributes.caseTitle',
            summary: '$.Attributes.escalationSummary',
            case_reason: 'other',
            [props.requestCategoryFieldId]: 'other',
            status: 'open',
          },
        },
        Transitions: {
          NextAction: 'get-case',
          Errors: [
            { ErrorType: 'ContactNotLinked', NextAction: 'get-case' },
            { ErrorType: 'NoMatchingError', NextAction: 'play-closed' },
          ],
          Conditions: [],
        },
      },
      {
        Identifier: 'get-case',
        Type: 'GetCase',
        Parameters: {
          LinkContactToCase: 'false',
          GetLastUpdatedCase: 'true',
          CaseRequestFields: {
            case_id: '$.Case.case_id',
          },
          CaseResponseFields: ['reference_number'],
        },
        Transitions: {
          NextAction: 'lookup-after-hours-case',
          Errors: [
            { ErrorType: 'NoMatchingError', NextAction: 'branch-case-hold' },
            { ErrorType: 'NoneFound', NextAction: 'branch-case-hold' },
            { ErrorType: 'MultipleFound', NextAction: 'branch-case-hold' },
          ],
          Conditions: [],
        },
      },
      {
        Identifier: 'branch-case-hold',
        Type: 'Compare',
        Parameters: {
          ComparisonValue: '$.Channel',
        },
        Transitions: {
          NextAction: 'play-case-hold-voice',
          Conditions: [
            {
              NextAction: 'play-case-hold-chat',
              Condition: { Operator: 'Equals', Operands: ['CHAT'] },
            },
          ],
          Errors: [
            { ErrorType: 'NoMatchingCondition', NextAction: 'play-case-hold-voice' },
          ],
        },
      },
      {
        Identifier: 'play-case-hold-chat',
        Type: 'MessageParticipant',
        Parameters: {
          Text: CASE_HOLD_TEXT,
        },
        Transitions: {
          NextAction: 'wait-case',
          Errors: errorTo('wait-case'),
          Conditions: [],
        },
      },
      {
        Identifier: 'wait-case',
        Type: 'Wait',
        Parameters: {
          TimeLimitSeconds: '3',
        },
        Transitions: {
          NextAction: 'get-case-retry',
          Conditions: [
            {
              NextAction: 'get-case-retry',
              Condition: { Operator: 'Equals', Operands: ['WaitCompleted'] },
            },
          ],
          Errors: errorTo('get-case-retry'),
        },
      },
      {
        Identifier: 'play-case-hold-voice',
        Type: 'MessageParticipant',
        Parameters: {
          SSML: CASE_HOLD_VOICE_SSML,
        },
        Transitions: {
          NextAction: 'get-case-retry',
          Errors: errorTo('get-case-retry'),
          Conditions: [],
        },
      },
      {
        Identifier: 'get-case-retry',
        Type: 'GetCase',
        Parameters: {
          LinkContactToCase: 'false',
          GetLastUpdatedCase: 'true',
          CaseRequestFields: {
            case_id: '$.Case.case_id',
          },
          CaseResponseFields: ['reference_number'],
        },
        Transitions: {
          NextAction: 'lookup-after-hours-case',
          Errors: [
            { ErrorType: 'NoMatchingError', NextAction: 'play-closed' },
            { ErrorType: 'NoneFound', NextAction: 'play-closed' },
            { ErrorType: 'MultipleFound', NextAction: 'play-closed' },
          ],
          Conditions: [],
        },
      },
      {
        Identifier: 'lookup-after-hours-case',
        Type: 'EvaluateDataTableValues',
        Parameters: {
          DataTableId: props.dataTableId,
          Queries: [promptQuery('AfterHoursCase', ['Text', 'TextAfter'])],
        },
        Transitions: {
          NextAction: 'check-case-prompt',
          Errors: errorTo('play-closed'),
          Conditions: [],
        },
      },
      {
        Identifier: 'check-case-prompt',
        Type: 'Compare',
        Parameters: {
          ComparisonValue: '$.DataTables.AfterHoursCase.Text',
        },
        Transitions: {
          NextAction: 'play-closed',
          Conditions: [exists('check-reference')],
          Errors: [
            { ErrorType: 'NoMatchingCondition', NextAction: 'play-closed' },
          ],
        },
      },
      {
        Identifier: 'check-reference',
        Type: 'Compare',
        Parameters: {
          ComparisonValue: CASE_REFERENCE_ATTRIBUTE,
        },
        Transitions: {
          NextAction: 'play-closed',
          Conditions: [exists('branch-case-channel')],
          Errors: [
            { ErrorType: 'NoMatchingCondition', NextAction: 'play-closed' },
          ],
        },
      },
      {
        Identifier: 'branch-case-channel',
        Type: 'Compare',
        Parameters: {
          ComparisonValue: '$.Channel',
        },
        Transitions: {
          NextAction: 'play-case-voice',
          Conditions: [
            {
              NextAction: 'play-case-chat',
              Condition: { Operator: 'Equals', Operands: ['CHAT'] },
            },
          ],
          Errors: [
            { ErrorType: 'NoMatchingCondition', NextAction: 'play-case-voice' },
          ],
        },
      },
      {
        Identifier: 'play-case-chat',
        Type: 'MessageParticipant',
        Parameters: {
          Text: AFTER_HOURS_CASE_PLAY_TEXT,
        },
        Transitions: {
          NextAction: 'disconnect',
          Errors: errorTo('play-closed'),
          Conditions: [],
        },
      },
      {
        Identifier: 'play-case-voice',
        Type: 'MessageParticipant',
        Parameters: {
          SSML: AFTER_HOURS_CASE_VOICE_SSML,
        },
        Transitions: {
          NextAction: 'disconnect',
          Errors: errorTo('play-closed'),
          Conditions: [],
        },
      },
      {
        Identifier: 'play-closed',
        Type: 'MessageParticipant',
        Parameters: {
          Text: AFTER_HOURS_CLOSED_TEXT,
        },
        Transitions: {
          NextAction: 'disconnect',
          Errors: errorTo('disconnect'),
          Conditions: [],
        },
      },
      {
        Identifier: 'play-goodbye',
        Type: 'MessageParticipant',
        Parameters: {
          Text: '$.DataTables.Goodbye.Text',
        },
        Transitions: {
          NextAction: 'disconnect',
          Errors: errorTo('disconnect'),
          Conditions: [],
        },
      },
      {
        Identifier: 'play-fallback',
        Type: 'MessageParticipant',
        Parameters: {
          Text: `${VOICE_GREETING} ${VOICE_GOODBYE}`,
        },
        Transitions: {
          NextAction: 'disconnect',
          Errors: errorTo('disconnect'),
          Conditions: [],
        },
      },
      {
        Identifier: 'disconnect',
        Type: 'DisconnectParticipant',
        Parameters: {},
        Transitions: {},
      },
    ],
  };
}
