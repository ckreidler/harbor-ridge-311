type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface FlowError {
  ErrorType: string;
  NextAction: string;
}

interface FlowAction {
  Identifier: string;
  Type: string;
  Parameters: { [key: string]: Json };
  Transitions: {
    NextAction?: string;
    Errors?: FlowError[];
    Conditions?: [];
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

const CLOSED_PROMPT = 'Thank you for calling Harbor Ridge 3 1 1. Our office is closed. Please leave a message after the tone, and hang up when you are finished.';

function errorTo(nextAction: string): FlowError[] {
  return [{ ErrorType: 'NoMatchingError', NextAction: nextAction }];
}

export function afterHoursFlow(): ContactFlowContent {
  return {
    Version: '2019-10-30',
    StartAction: 'set-voice',
    Metadata: {
      entryPointPosition: { x: 40, y: 40 },
      ActionMetadata: {
        'set-voice': { position: { x: 180, y: 180 } },
        'set-voicemail': { position: { x: 430, y: 180 } },
        'play-closed': { position: { x: 680, y: 180 } },
        'start-recording': { position: { x: 930, y: 180 } },
        'leave-message': { position: { x: 1180, y: 180 } },
        disconnect: { position: { x: 1430, y: 180 } },
      },
    },
    Actions: [
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
