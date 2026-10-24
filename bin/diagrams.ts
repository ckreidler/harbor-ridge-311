import * as fs from 'node:fs';
import * as path from 'node:path';
import { diagramPage } from '../lib/flow';
import { MAIN_FLOW_NAME, mainFlow, type MainFlowProps } from '../lib/flows/main-flow';

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

export function writeFlowPages(directory = path.join(process.cwd(), 'docs/flows')): void {
  fs.mkdirSync(directory, { recursive: true });
  for (const page of flowPages()) {
    fs.writeFileSync(path.join(directory, `${page.name}.md`), page.body);
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith(`${path.sep}diagrams.ts`) || entry.endsWith(`${path.sep}diagrams.js`)) {
  writeFlowPages();
}
