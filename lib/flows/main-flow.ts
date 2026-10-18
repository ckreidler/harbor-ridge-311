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
  hoursOfOperationArn: string;
  afterHoursFlowArn: string;
}

const ENGLISH_GREETING = 'Thank you for calling Harbor Ridge 3 1 1. This line is a demo.';
const ENGLISH_GOODBYE = 'Thank you for calling Harbor Ridge 3 1 1. Goodbye.';
const ENGLISH_QUESTION = 'What can I help you with? You can ask about trash pickup, potholes, parking permits, or office hours. Say agent if you would rather talk to a person.';
const SPANISH_QUESTION = '¿En qué puedo ayudarle? Puede preguntar sobre la recolección de basura, los baches, los permisos de estacionamiento o el horario. Diga agente si prefiere hablar con una persona.';

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
        'select-language': { position: { x: 420, y: 200 } },
        'set-en-language': { position: { x: 680, y: 40 } },
        'set-en-voice': { position: { x: 940, y: 40 } },
        'set-es-language': { position: { x: 680, y: 360 } },
        'set-es-voice': { position: { x: 940, y: 360 } },
        'lookup-prompts': { position: { x: 1200, y: 200 } },
        'play-greeting': { position: { x: 1460, y: 200 } },
        'play-fallback': { position: { x: 1460, y: 480 } },
        'create-assistant-session': { position: { x: 1720, y: 200 } },
        'check-question-language': { position: { x: 1980, y: 200 } },
        'ask-en-question': { position: { x: 2240, y: 40 } },
        'ask-es-question': { position: { x: 2240, y: 360 } },
        'check-tool': { position: { x: 2500, y: 200 } },
        'play-goodbye': { position: { x: 2760, y: 40 } },
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
          NextAction: 'select-language',
        },
      },
      {
        Identifier: 'select-language',
        Type: 'GetParticipantInput',
        Parameters: {
          Text: 'For English, press 1. Para español, oprima 2.',
          StoreInput: 'False',
          InputTimeLimitSeconds: '5',
        },
        Transitions: {
          NextAction: 'set-en-language',
          Conditions: [
            {
              NextAction: 'set-en-language',
              Condition: { Operator: 'Equals', Operands: ['1'] },
            },
            {
              NextAction: 'set-es-language',
              Condition: { Operator: 'Equals', Operands: ['2'] },
            },
          ],
          Errors: [
            { ErrorType: 'InputTimeLimitExceeded', NextAction: 'set-en-language' },
            { ErrorType: 'NoMatchingCondition', NextAction: 'set-en-language' },
            { ErrorType: 'NoMatchingError', NextAction: 'set-en-language' },
          ],
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
        Identifier: 'set-es-language',
        Type: 'UpdateContactData',
        Parameters: {
          LanguageCode: 'es-US',
          TargetContact: 'Current',
        },
        Transitions: {
          NextAction: 'set-es-voice',
          Errors: errorTo('set-es-voice'),
          Conditions: [],
        },
      },
      {
        Identifier: 'set-es-voice',
        Type: 'UpdateContactTextToSpeechVoice',
        Parameters: {
          TextToSpeechVoice: 'Lupe',
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
            {
              QueryName: 'Prompts',
              Attributes: ['Greeting', 'Goodbye'],
              PrimaryValues: [
                { AttributeName: 'Language', Value: '$.LanguageCode' },
              ],
            },
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
          Text: '$.DataTables.Prompts.Greeting',
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
          NextAction: 'check-question-language',
          Errors: errorTo('play-goodbye'),
          Conditions: [],
        },
      },
      {
        Identifier: 'check-question-language',
        Type: 'Compare',
        Parameters: {
          ComparisonValue: '$.LanguageCode',
        },
        Transitions: {
          NextAction: 'ask-en-question',
          Conditions: [
            {
              NextAction: 'ask-en-question',
              Condition: { Operator: 'Equals', Operands: ['en-US'] },
            },
            {
              NextAction: 'ask-es-question',
              Condition: { Operator: 'Equals', Operands: ['es-US'] },
            },
          ],
          Errors: [
            { ErrorType: 'NoMatchingCondition', NextAction: 'ask-en-question' },
          ],
        },
      },
      {
        Identifier: 'ask-en-question',
        Type: 'ConnectParticipantWithLexBot',
        Parameters: {
          Text: ENGLISH_QUESTION,
          LexV2Bot: {
            AliasArn: props.lexBotAliasArn,
          },
          LexSessionAttributes: {
            'x-amz-lex:q-in-connect:session-arn': '$.Wisdom.SessionArn',
          },
        },
        Transitions: {
          NextAction: 'check-tool',
          Errors: [
            { ErrorType: 'InputTimeLimitExceeded', NextAction: 'check-hours' },
            { ErrorType: 'NoMatchingCondition', NextAction: 'check-hours' },
            { ErrorType: 'NoMatchingError', NextAction: 'check-hours' },
          ],
          Conditions: [],
        },
      },
      {
        Identifier: 'ask-es-question',
        Type: 'ConnectParticipantWithLexBot',
        Parameters: {
          Text: SPANISH_QUESTION,
          LexV2Bot: {
            AliasArn: props.lexBotAliasArn,
          },
          LexSessionAttributes: {
            'x-amz-lex:q-in-connect:session-arn': '$.Wisdom.SessionArn',
          },
        },
        Transitions: {
          NextAction: 'check-tool',
          Errors: [
            { ErrorType: 'InputTimeLimitExceeded', NextAction: 'check-hours' },
            { ErrorType: 'NoMatchingCondition', NextAction: 'check-hours' },
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
              Condition: { Operator: 'Equals', Operands: ['COMPLETE'] },
            },
            {
              NextAction: 'check-hours',
              Condition: { Operator: 'Equals', Operands: ['ESCALATION'] },
            },
          ],
          Errors: [
            { ErrorType: 'NoMatchingCondition', NextAction: 'check-hours' },
          ],
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
          Text: '$.DataTables.Prompts.Goodbye',
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
          Text: `${ENGLISH_GREETING} ${ENGLISH_GOODBYE}`,
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
