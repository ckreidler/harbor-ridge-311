import { diagramPage } from './mermaid';
import { MAIN_FLOW_NAME, mainFlow, type MainFlowProps } from '../flows/main-flow';

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
  ];
}
