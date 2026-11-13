import type { FlowContent } from './flow';
import { diagramPage } from './mermaid';
import { ESCALATION_GUIDE_FLOW_NAME, escalationGuideFlow } from '../flows/escalation-guide-flow';
import { MAIN_FLOW_NAME, mainFlow, type MainFlowProps } from '../flows/main-flow';
import {
  MAJOR_INCIDENT_FLOW_NAME,
  MAJOR_INCIDENT_QUEUE_FLOW_NAME,
  majorIncidentFlow,
  majorIncidentQueueFlow,
} from '../flows/major-incident-flow';
import { customerQueueFlow, QUEUE_FLOW_NAME } from '../flows/queue-flow';

const mainFlowProps: MainFlowProps = {
  dataTableId: 'table',
  outageDataTableId: 'outage-table',
  wisdomAssistantArn: 'assistant',
  lexBotAliasArn: 'alias',
  orchestratorLambdaArn: 'orchestrator',
  hoursOfOperationArn: 'hours',
  queueArn: 'queue',
  escalationGuideFlowArn: 'escalation-guide',
  customerQueueFlowArn: 'queue-flow',
  ticketLambdaArn: 'ticket-lambda',
};

export interface FlowPage {
  readonly name: string;
  readonly content: FlowContent;
  readonly body: string;
}

function page(name: string, content: FlowContent): FlowPage {
  return { name, content, body: diagramPage(name, content) };
}

export function flowPages(): FlowPage[] {
  return [
    page(MAIN_FLOW_NAME, mainFlow(mainFlowProps).content),
    page(QUEUE_FLOW_NAME, customerQueueFlow({
      dataTableId: 'table',
      holdMusicPromptArn: 'hold-music',
    }).content),
    page(ESCALATION_GUIDE_FLOW_NAME, escalationGuideFlow({
      detailViewArn: 'view',
    }).content),
    page(MAJOR_INCIDENT_FLOW_NAME, majorIncidentFlow({
      queueArn: 'queue',
      customerQueueFlowArn: 'queue-flow',
    }).content),
    page(MAJOR_INCIDENT_QUEUE_FLOW_NAME, majorIncidentQueueFlow().content),
  ];
}
