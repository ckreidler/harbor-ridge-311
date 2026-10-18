interface ContactFlowError {
  ErrorType: 'NoMatchingError';
  NextAction: string;
}

interface ContactFlowAction {
  Identifier: string;
  Type: string;
  Parameters: Record<string, string>;
  Transitions: {
    NextAction?: string;
    Errors?: ContactFlowError[];
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
  Actions: ContactFlowAction[];
}

export const mainFlow: ContactFlowContent = {
  Version: '2019-10-30',
  StartAction: 'set-voice',
  Metadata: {
    entryPointPosition: { x: 40, y: 40 },
    ActionMetadata: {
      'set-voice': { position: { x: 290, y: 40 } },
      'play-greeting': { position: { x: 540, y: 40 } },
      disconnect: { position: { x: 790, y: 40 } },
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
        NextAction: 'play-greeting',
        Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'disconnect' }],
        Conditions: [],
      },
    },
    {
      Identifier: 'play-greeting',
      Type: 'MessageParticipant',
      Parameters: {
        Text: 'Thank you for calling Harbor Ridge 3 1 1. This line is a demo. Goodbye.',
      },
      Transitions: {
        NextAction: 'disconnect',
        Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'disconnect' }],
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
