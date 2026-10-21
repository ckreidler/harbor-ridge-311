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

export interface AfterHoursFlowProps {
  dataTableId: string;
}

export const AFTER_HOURS_CHAT_TEXT = 'Harbor Ridge 311 is closed right now. Our team is available Monday to Friday, 8 a.m. to 5 p.m. Pacific. Please chat with us again then.';

const CLOSED_PROMPT = 'Thank you for calling Harbor Ridge 3 1 1. Our office is closed. Please leave a message after the tone, and hang up when you are finished.';
const CHAT_CLOSED_FALLBACK = 'Harbor Ridge 311 is closed right now.';

function errorTo(nextAction: string): FlowError[] {
  return [{ ErrorType: 'NoMatchingError', NextAction: nextAction }];
}

export function afterHoursFlow(props: AfterHoursFlowProps): ContactFlowContent {
  return {
    Version: '2019-10-30',
    StartAction: 'branch-channel',
    Metadata: {
      entryPointPosition: { x: 40, y: 40 },
      ActionMetadata: {
        'branch-channel': { position: { x: 160, y: 40 } },
        'set-voice': { position: { x: 440, y: 40 } },
        'set-voicemail': { position: { x: 720, y: 40 } },
        'play-closed': { position: { x: 1000, y: 40 } },
        'start-recording': { position: { x: 1280, y: 40 } },
        'leave-message': { position: { x: 1560, y: 40 } },
        disconnect: { position: { x: 1840, y: 40 } },
        'lookup-closed': { position: { x: 440, y: 320 } },
        'play-closed-chat': { position: { x: 720, y: 320 } },
        'play-closed-fallback': { position: { x: 1000, y: 320 } },
      },
    },
    Actions: [
      {
        Identifier: 'branch-channel',
        Type: 'Compare',
        Parameters: {
          ComparisonValue: '$.Channel',
        },
        Transitions: {
          NextAction: 'set-voice',
          Conditions: [
            {
              NextAction: 'lookup-closed',
              Condition: { Operator: 'Equals', Operands: ['CHAT'] },
            },
          ],
          Errors: [{ ErrorType: 'NoMatchingCondition', NextAction: 'set-voice' }],
        },
      },
      {
        Identifier: 'lookup-closed',
        Type: 'EvaluateDataTableValues',
        Parameters: {
          DataTableId: props.dataTableId,
          Queries: [
            {
              QueryName: 'AfterHours',
              Attributes: ['Text'],
              PrimaryValues: [
                { AttributeName: 'Prompt', Value: 'AfterHours' },
                { AttributeName: 'Channel', Value: '$.Channel' },
              ],
            },
          ],
        },
        Transitions: {
          NextAction: 'play-closed-chat',
          Errors: errorTo('play-closed-fallback'),
          Conditions: [],
        },
      },
      {
        Identifier: 'play-closed-chat',
        Type: 'MessageParticipant',
        Parameters: {
          Text: '$.DataTables.AfterHours.Text',
        },
        Transitions: {
          NextAction: 'disconnect',
          Errors: errorTo('play-closed-fallback'),
          Conditions: [],
        },
      },
      {
        Identifier: 'play-closed-fallback',
        Type: 'MessageParticipant',
        Parameters: {
          Text: CHAT_CLOSED_FALLBACK,
        },
        Transitions: {
          NextAction: 'disconnect',
          Errors: errorTo('disconnect'),
          Conditions: [],
        },
      },
      {
        Identifier: 'set-voice',
        Type: 'UpdateContactTextToSpeechVoice',
        Parameters: {
          TextToSpeechVoice: 'Joanna',
          TextToSpeechEngine: 'Neural',
        },
        Transitions: {
          NextAction: 'set-voicemail',
          Errors: errorTo('set-voicemail'),
          Conditions: [],
        },
      },
      {
        Identifier: 'set-voicemail',
        Type: 'UpdateContactAttributes',
        Parameters: {
          Attributes: { Voicemail: 'true' },
          TargetContact: 'Current',
        },
        Transitions: {
          NextAction: 'play-closed',
          Errors: errorTo('play-closed'),
          Conditions: [],
        },
      },
      {
        Identifier: 'play-closed',
        Type: 'MessageParticipant',
        Parameters: {
          Text: CLOSED_PROMPT,
        },
        Transitions: {
          NextAction: 'start-recording',
          Errors: errorTo('start-recording'),
          Conditions: [],
        },
      },
      {
        Identifier: 'start-recording',
        Type: 'UpdateContactRecordingBehavior',
        Parameters: {
          RecordingBehavior: {
            RecordedParticipants: [],
            IVRRecordingBehavior: 'Enabled',
          },
        },
        Transitions: {
          NextAction: 'leave-message',
          Errors: [],
          Conditions: [],
        },
      },
      {
        Identifier: 'leave-message',
        Type: 'GetParticipantInput',
        Parameters: {
          Text: ' ',
          StoreInput: 'False',
          InputTimeLimitSeconds: '60',
        },
        Transitions: {
          NextAction: 'disconnect',
          Errors: [
            { ErrorType: 'InputTimeLimitExceeded', NextAction: 'disconnect' },
            { ErrorType: 'NoMatchingCondition', NextAction: 'disconnect' },
            { ErrorType: 'NoMatchingError', NextAction: 'disconnect' },
          ],
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
