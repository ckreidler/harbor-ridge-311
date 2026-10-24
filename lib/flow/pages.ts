import { diagramPage } from './mermaid';
import { ESCALATION_GUIDE_FLOW_NAME, escalationGuideFlow } from '../flows/escalation-guide-flow';
import { MAIN_FLOW_NAME, mainFlow, type MainFlowProps } from '../flows/main-flow';
import { customerQueueFlow, QUEUE_FLOW_NAME } from '../flows/queue-flow';

const mainFlowProps: MainFlowProps = {
  dataTableId: 'table',
  wisdomAssistantArn: 'assistant',
  lexBotAliasArn: 'alias',
  orchestratorLambdaArn: 'orchestrator',
  hoursOfOperationArn: 'hours',
  queueArn: 'queue',
  escalationGuideFlowArn: 'escalation-guide',
  customerQueueFlowArn: 'queue-flow',
  caseTemplateId: 'template',
  requestCategoryFieldId: 'category',
};

export function flowPages(): Array<{ name: string; body: string }> {
  return [
    { name: MAIN_FLOW_NAME, body: diagramPage(MAIN_FLOW_NAME, mainFlow(mainFlowProps)) },
    {
      name: QUEUE_FLOW_NAME,
      body: diagramPage(QUEUE_FLOW_NAME, customerQueueFlow({
        dataTableId: 'table',
        holdMusicPromptArn: 'hold-music',
      })),
    },
    {
      name: ESCALATION_GUIDE_FLOW_NAME,
      body: diagramPage(ESCALATION_GUIDE_FLOW_NAME, escalationGuideFlow({
        detailViewArn: 'view',
      })),
    },
  ];
}
