type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface FlowError {
  ErrorType: string;
  NextAction: string;
}

interface FlowCondition {
  NextAction: string;
  Condition: {
    Operator: 'Equals';
    Operands: [string];
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
  afterHoursFlowArn: string;
  queueArn: string;
  escalationGuideFlowArn: string;
  customerQueueFlowArn: string;
}

const VOICE_GREETING = 'Thank you for calling Harbor Ridge 3 1 1. This line is a demo.';
const VOICE_GOODBYE = 'Thank you for calling Harbor Ridge 3 1 1. Goodbye.';

function promptQuery(prompt: 'Greeting' | 'Goodbye' | 'Question') {
  return {
    QueryName: prompt,
    Attributes: ['Text'],
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: prompt },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  };
}

function errorTo(nextAction: string): FlowError[] {
  return [{ ErrorType: 'NoMatchingError', NextAction: nextAction }];
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
        'transfer-after-hours': { position: { x: 2960, y: 920 } },
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
              NextAction: 'transfer-after-hours',
              Condition: { Operator: 'Equals', Operands: ['False'] },
            },
          ],
          Errors: errorTo('transfer-after-hours'),
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
        Identifier: 'transfer-after-hours',
        Type: 'TransferToFlow',
        Parameters: {
          ContactFlowId: props.afterHoursFlowArn,
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
