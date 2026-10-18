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
}

const ENGLISH_GREETING = 'Thank you for calling Harbor Ridge 3 1 1. This line is a demo.';
const ENGLISH_GOODBYE = 'Thank you for calling Harbor Ridge 3 1 1. Goodbye.';

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
        'set-en-attribute': { position: { x: 540, y: 40 } },
        'set-en-language': { position: { x: 790, y: 40 } },
        'set-en-voice': { position: { x: 1040, y: 40 } },
        'set-es-attribute': { position: { x: 540, y: 280 } },
        'set-es-language': { position: { x: 790, y: 280 } },
        'set-es-voice': { position: { x: 1040, y: 280 } },
        'lookup-prompts': { position: { x: 1290, y: 160 } },
        'play-greeting': { position: { x: 1540, y: 160 } },
        'play-goodbye': { position: { x: 1790, y: 160 } },
        disconnect: { position: { x: 2040, y: 160 } },
        'play-fallback': { position: { x: 1540, y: 400 } },
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
          NextAction: 'set-en-attribute',
          Conditions: [
            {
              NextAction: 'set-en-attribute',
              Condition: { Operator: 'Equals', Operands: ['1'] },
            },
            {
              NextAction: 'set-es-attribute',
              Condition: { Operator: 'Equals', Operands: ['2'] },
            },
          ],
          Errors: [
            { ErrorType: 'InputTimeLimitExceeded', NextAction: 'set-en-attribute' },
            { ErrorType: 'NoMatchingCondition', NextAction: 'set-en-attribute' },
            { ErrorType: 'NoMatchingError', NextAction: 'set-en-attribute' },
          ],
        },
      },
      {
        Identifier: 'set-en-attribute',
        Type: 'UpdateContactAttributes',
        Parameters: {
          Attributes: { language: 'en-US' },
          TargetContact: 'Current',
        },
        Transitions: {
          NextAction: 'set-en-language',
          Errors: errorTo('set-en-language'),
          Conditions: [],
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
        Identifier: 'set-es-attribute',
        Type: 'UpdateContactAttributes',
        Parameters: {
          Attributes: { language: 'es-US' },
          TargetContact: 'Current',
        },
        Transitions: {
          NextAction: 'set-es-language',
          Errors: errorTo('set-es-language'),
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
                { AttributeName: 'Language', Value: '$.Attributes.language' },
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
          NextAction: 'play-goodbye',
          Errors: errorTo('play-fallback'),
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
