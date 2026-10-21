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
  } | {
    Operator: 'Exists';
    Operands: [];
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
      entryPointPosition: { x: 40, y: 40 },
      ActionMetadata: {
        'enable-flow-logging': { position: { x: 160, y: 200 } },
        'set-en-language': { position: { x: 420, y: 200 } },
        'set-en-voice': { position: { x: 680, y: 200 } },
        'lookup-prompts': { position: { x: 940, y: 200 } },
        'check-prompt': { position: { x: 1070, y: 200 } },
        'play-greeting': { position: { x: 1200, y: 200 } },
        'play-fallback': { position: { x: 1200, y: 480 } },
        'create-assistant-session': { position: { x: 1460, y: 200 } },
        'select-orchestrator': { position: { x: 1720, y: 200 } },
        'ask-en-question': { position: { x: 1980, y: 200 } },
        'check-tool': { position: { x: 2240, y: 200 } },
        'play-goodbye': { position: { x: 2500, y: 40 } },
        'set-escalation': { position: { x: 2500, y: 280 } },
        'check-hours': { position: { x: 2760, y: 360 } },
        'play-agent-placeholder': { position: { x: 3020, y: 280 } },
        'transfer-after-hours': { position: { x: 3020, y: 520 } },
        disconnect: { position: { x: 3280, y: 200 } },
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
          NextAction: 'set-en-language',
        },
      },
      {
        Identifier: 'set-en-language',
        Type: 'UpdateContactData',
        Parameters: {
          LanguageCode: 'en-US',
          TargetContact: 'Current',
        },
        Transitions: {
          NextAction: 'set-en-voice',
          Errors: errorTo('set-en-voice'),
          Conditions: [],
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
          NextAction: 'check-prompt',
          Errors: errorTo('play-fallback'),
          Conditions: [],
        },
      },
      {
        Identifier: 'check-prompt',
        Type: 'Compare',
        Parameters: {
          ComparisonValue: '$.DataTables.Greeting.Text',
        },
        Transitions: {
          NextAction: 'play-fallback',
          Conditions: [
            {
              NextAction: 'play-greeting',
              Condition: { Operator: 'Exists', Operands: [] },
            },
          ],
          Errors: [
            { ErrorType: 'NoMatchingCondition', NextAction: 'play-fallback' },
          ],
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
          NextAction: 'play-agent-placeholder',
          Conditions: [
            {
              NextAction: 'play-agent-placeholder',
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
        Identifier: 'play-agent-placeholder',
        Type: 'MessageParticipant',
        Parameters: {
          Text: 'This is where we would escalate to an agent.',
        },
        Transitions: {
          NextAction: 'disconnect',
          Errors: errorTo('disconnect'),
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
