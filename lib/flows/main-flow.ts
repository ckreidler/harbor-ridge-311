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
    StartAction: 'select-language',
    Metadata: {
      entryPointPosition: { x: 40, y: 40 },
      ActionMetadata: {
        'select-language': { position: { x: 290, y: 160 } },
        'set-en-language': { position: { x: 540, y: 40 } },
        'set-en-voice': { position: { x: 790, y: 40 } },
        'set-es-language': { position: { x: 540, y: 280 } },
        'set-es-voice': { position: { x: 790, y: 280 } },
        'lookup-prompts': { position: { x: 1040, y: 160 } },
        'play-greeting': { position: { x: 1290, y: 160 } },
        'create-assistant-session': { position: { x: 1540, y: 160 } },
        'check-question-language': { position: { x: 1790, y: 160 } },
        'ask-en-question': { position: { x: 2040, y: 40 } },
        'ask-es-question': { position: { x: 2040, y: 280 } },
        'check-tool': { position: { x: 2290, y: 160 } },
        'play-goodbye': { position: { x: 2540, y: 160 } },
        disconnect: { position: { x: 2790, y: 160 } },
        'play-fallback': { position: { x: 1290, y: 400 } },
      },
    },
    Actions: [
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
        },
        Transitions: {
          NextAction: 'check-tool',
          Errors: [
            { ErrorType: 'InputTimeLimitExceeded', NextAction: 'play-goodbye' },
            { ErrorType: 'NoMatchingCondition', NextAction: 'play-goodbye' },
            { ErrorType: 'NoMatchingError', NextAction: 'play-goodbye' },
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
        },
        Transitions: {
          NextAction: 'check-tool',
          Errors: [
            { ErrorType: 'InputTimeLimitExceeded', NextAction: 'play-goodbye' },
            { ErrorType: 'NoMatchingCondition', NextAction: 'play-goodbye' },
            { ErrorType: 'NoMatchingError', NextAction: 'play-goodbye' },
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
          ],
          Errors: [
            { ErrorType: 'NoMatchingCondition', NextAction: 'play-goodbye' },
          ],
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
