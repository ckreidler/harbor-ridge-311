import {
  CUSTOMER_QUEUE,
  compare,
  equals,
  evaluateDataTableValues,
  flow,
  messageParticipant,
  messageParticipantIteratively,
  wait,
  type DataTableQuery,
  type FlowContent,
} from '../flow';

export interface CustomerQueueFlowProps {
  dataTableId: string;
  holdMusicPromptArn: string;
}

export const QUEUE_FLOW_NAME = 'HarborRidge311-Queue';
export const QUEUE_CHAT_TEXT = 'Thanks for waiting. You\'re in line and the next available person will join this chat shortly.';
export const QUEUE_VOICE_TEXT = 'Thanks for waiting. The next available person will be with you shortly.';

const CHAT_WAIT_SECONDS = '180';

function promptQuery(queryName: string): DataTableQuery {
  return {
    QueryName: queryName,
    Attributes: ['Text'],
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: 'Queue' },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  };
}

export function customerQueueFlow(props: CustomerQueueFlowProps): FlowContent {
  return flow({
    name: QUEUE_FLOW_NAME,
    type: CUSTOMER_QUEUE,
    start: 'branch-channel',
    actions: [
      compare('branch-channel', {
        ComparisonValue: '$.Channel',
      }, {
        next: 'lookup-queue-voice',
        conditions: [equals('CHAT', 'lookup-queue-chat')],
        noMatch: 'lookup-queue-voice',
      }),
      evaluateDataTableValues('lookup-queue-chat', {
        DataTableId: props.dataTableId,
        Queries: [promptQuery('QueueChat')],
      }, { next: 'play-queue-chat', error: 'play-queue-fallback' }),
      messageParticipant('play-queue-chat', {
        Text: '$.DataTables.QueueChat.Text',
      }, { next: 'wait-in-queue', error: 'play-queue-fallback' }),
      messageParticipant('play-queue-fallback', {
        Text: QUEUE_CHAT_TEXT,
      }, { next: 'wait-in-queue', error: 'wait-in-queue' }),
      wait('wait-in-queue', {
        TimeLimitSeconds: CHAT_WAIT_SECONDS,
      }, { next: 'wait-in-queue', completed: 'wait-in-queue', error: 'wait-in-queue' }),
      evaluateDataTableValues('lookup-queue-voice', {
        DataTableId: props.dataTableId,
        Queries: [promptQuery('QueueVoice')],
      }, { next: 'loop-hold', error: 'loop-hold-fallback' }),
      messageParticipantIteratively('loop-hold', {
        Messages: [
          { Text: '$.DataTables.QueueVoice.Text' },
          { PromptId: props.holdMusicPromptArn },
      ],
    }, { next: 'loop-hold' }),
    messageParticipantIteratively('loop-hold-fallback', {
      Messages: [
        { Text: QUEUE_VOICE_TEXT },
        { PromptId: props.holdMusicPromptArn },
      ],
    }, { next: 'loop-hold-fallback' }),
    ],
  });
}
