import * as fs from 'node:fs';
import * as path from 'node:path';

export const OUTAGE_TABLE_NAME = 'HarborRidge311-Outage';
export const OUTAGE_KEY_ATTRIBUTE = 'key';
export const OUTAGE_ROW_KEY = 'outage';
export const OUTAGE_ACTIVE_ATTRIBUTE = 'active';
export const OUTAGE_MESSAGE_ATTRIBUTE = 'message';
export const OUTAGE_QUERY_NAME = 'Outage';
export const OUTAGE_ACTIVE_VALUE = 'true';
export const OUTAGE_INACTIVE_VALUE = 'false';
export const OUTAGE_MESSAGE_MAX_LENGTH = 280;
export const OUTAGE_PLACEHOLDER_MESSAGE = 'Harbor Ridge 3 1 1 has a service outage. You can still ask a question or leave a request.';
export const OUTAGE_DATA_TABLE_ARN_PLACEHOLDER = '__OUTAGE_DATA_TABLE_ARN__';
export const OUTAGE_VIEW_ACTION = 'Save';

export interface OutageViewComponent {
  readonly _id: string;
  readonly Type: string;
  readonly Props: {
    readonly Id: string;
    DataTableArn: string;
  };
  readonly Content: readonly unknown[];
}

export interface OutageViewTemplate {
  readonly Head: {
    readonly Title: string;
    readonly Configuration: {
      readonly Layout: { readonly Columns: readonly string[] };
    };
  };
  readonly Body: readonly OutageViewComponent[];
}

export interface OutageViewDocument {
  readonly Actions: readonly string[];
  readonly Template: OutageViewTemplate;
}

export function outageViewDocument(): OutageViewDocument {
  const file = path.join(__dirname, '../views/outage.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as OutageViewDocument;
}

export function outageViewTemplate(dataTableArn: string): {
  readonly actions: string[];
  readonly template: OutageViewTemplate;
} {
  const document = outageViewDocument();
  const [component, ...rest] = document.Template.Body;
  if (
    rest.length > 0
    || component === undefined
    || component.Type !== 'DataTable'
    || component.Props.DataTableArn !== OUTAGE_DATA_TABLE_ARN_PLACEHOLDER
    || document.Actions.length !== 1
    || document.Actions[0] !== OUTAGE_VIEW_ACTION
  ) {
    throw new Error('views/outage.json does not match the outage view contract');
  }
  return {
    actions: [...document.Actions],
    template: {
      ...document.Template,
      Body: [{
        ...component,
        Props: {
          ...component.Props,
          DataTableArn: dataTableArn,
        },
      }],
    },
  };
}
