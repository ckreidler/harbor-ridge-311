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

export interface CustomerQueueFlowProps {
  dataTableId: string;
  holdMusicPromptArn: string;
}

export const QUEUE_CHAT_TEXT = 'Thanks for waiting. You\'re in line and the next available person will join this chat shortly.';
export const QUEUE_VOICE_TEXT = 'Thanks for waiting. The next available person will be with you shortly.';

const CHAT_WAIT_SECONDS = '180';

function errorTo(nextAction: string): FlowError[] {
  return [{ ErrorType: 'NoMatchingError', NextAction: nextAction }];
}

function promptQuery(queryName: string) {
  return {
    QueryName: queryName,
    Attributes: ['Text'],
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: 'Queue' },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  };
}

function holdLoop(identifier: string, text: string, holdMusicPromptArn: string): FlowAction {
  return {
    Identifier: identifier,
    Type: 'MessageParticipantIteratively',
    Parameters: {
      Messages: [
        { Text: text },
        { PromptId: holdMusicPromptArn },
      ],
    },
    Transitions: {
      NextAction: identifier,
      Errors: [],
      Conditions: [],
    },
  };
}

export function customerQueueFlow(props: CustomerQueueFlowProps): ContactFlowContent {
  return {
    Version: '2019-10-30',
    StartAction: 'branch-channel',
    Metadata: {
      entryPointPosition: { x: 40, y: 40 },
      ActionMetadata: {
        'branch-channel': { position: { x: 160, y: 40 } },
        'lookup-queue-chat': { position: { x: 440, y: 40 } },
        'play-queue-chat': { position: { x: 720, y: 40 } },
        'wait-in-queue': { position: { x: 1000, y: 40 } },
        'play-queue-fallback': { position: { x: 720, y: 320 } },
        'lookup-queue-voice': { position: { x: 440, y: 600 } },
        'loop-hold': { position: { x: 720, y: 600 } },
        'loop-hold-fallback': { position: { x: 1000, y: 600 } },
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
          NextAction: 'lookup-queue-voice',
          Conditions: [
            {
              NextAction: 'lookup-queue-chat',
              Condition: { Operator: 'Equals', Operands: ['CHAT'] },
            },
          ],
          Errors: [{ ErrorType: 'NoMatchingCondition', NextAction: 'lookup-queue-voice' }],
        },
      },
      {
        Identifier: 'lookup-queue-chat',
        Type: 'EvaluateDataTableValues',
        Parameters: {
          DataTableId: props.dataTableId,
          Queries: [promptQuery('QueueChat')],
        },
        Transitions: {
          NextAction: 'play-queue-chat',
          Errors: errorTo('play-queue-fallback'),
          Conditions: [],
        },
      },
      {
        Identifier: 'play-queue-chat',
        Type: 'MessageParticipant',
        Parameters: {
          Text: '$.DataTables.QueueChat.Text',
        },
        Transitions: {
          NextAction: 'wait-in-queue',
          Errors: errorTo('play-queue-fallback'),
          Conditions: [],
        },
      },
      {
        Identifier: 'play-queue-fallback',
        Type: 'MessageParticipant',
        Parameters: {
          Text: QUEUE_CHAT_TEXT,
        },
        Transitions: {
          NextAction: 'wait-in-queue',
          Errors: errorTo('wait-in-queue'),
          Conditions: [],
        },
      },
      {
        Identifier: 'wait-in-queue',
        Type: 'Wait',
        Parameters: {
          TimeLimitSeconds: CHAT_WAIT_SECONDS,
        },
        Transitions: {
          NextAction: 'wait-in-queue',
          Conditions: [
            {
              NextAction: 'wait-in-queue',
              Condition: { Operator: 'Equals', Operands: ['WaitCompleted'] },
            },
          ],
          Errors: errorTo('wait-in-queue'),
        },
      },
      {
        Identifier: 'lookup-queue-voice',
        Type: 'EvaluateDataTableValues',
        Parameters: {
          DataTableId: props.dataTableId,
          Queries: [promptQuery('QueueVoice')],
        },
        Transitions: {
          NextAction: 'loop-hold',
          Errors: errorTo('loop-hold-fallback'),
          Conditions: [],
        },
      },
      holdLoop('loop-hold', '$.DataTables.QueueVoice.Text', props.holdMusicPromptArn),
      holdLoop('loop-hold-fallback', QUEUE_VOICE_TEXT, props.holdMusicPromptArn),
    ],
  };
}
