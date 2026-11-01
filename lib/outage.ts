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
export const OUTAGE_DATA_TABLE_ID_PLACEHOLDER = '__OUTAGE_DATA_TABLE_ID__';

// describe-view returned Actions: []. The CloudFormation registry schema for
// AWS::Connect::View requires the Actions property, caps the array at 1000,
// and sets minLength 1 on each string. It does not set minItems. The rendered
// doc line "Minimum: 1 / Maximum: 255 | 1000" is that string length plus the
// array cap. An empty list is the export, so that is what we send.
export const OUTAGE_VIEW_ACTIONS: readonly string[] = [];

interface OutageDataTableProps {
  DataTable: string;
  Mode: string;
  Display: string;
  Attributes: readonly unknown[];
  PrimaryValues: readonly (readonly { AttributeName: string; Value: string }[])[];
}

interface OutageViewComponent {
  _id: string;
  Type: string;
  Props: OutageDataTableProps;
  Content: readonly unknown[];
}

interface OutageViewTemplate {
  Head: {
    Configuration: { Layout: { Columns: readonly number[] } };
    Integrations: readonly unknown[];
    Title: string;
  };
  Body: OutageViewComponent[];
}

export function outageViewTemplate(dataTableId: string): {
  readonly actions: readonly string[];
  readonly template: OutageViewTemplate;
} {
  const file = path.join(__dirname, '../views/outage.json');
  const template = JSON.parse(fs.readFileSync(file, 'utf8')) as OutageViewTemplate;
  const [component, ...rest] = template.Body;
  const props = component?.Props;
  const primary = props?.PrimaryValues;
  if (
    rest.length > 0
    || component?.Type !== 'DataTable'
    || component._id !== 'DataTable_1793494978541'
    || Object.keys(props ?? {}).join(',') !== 'DataTable,Mode,Display,Attributes,PrimaryValues'
    || props?.DataTable !== OUTAGE_DATA_TABLE_ID_PLACEHOLDER
    || props.Mode !== 'ReadAndWrite'
    || props.Display !== 'Form'
    || props.Attributes.length !== 0
    || primary?.length !== 1
    || primary[0]?.length !== 1
    || primary[0][0]?.AttributeName !== OUTAGE_KEY_ATTRIBUTE
    || primary[0][0]?.Value !== OUTAGE_ROW_KEY
    || template.Head.Title !== 'HarborRidge311-OutageEditor'
    || template.Head.Integrations.length !== 0
  ) {
    throw new Error('views/outage.json does not match the describe-view outage template');
  }
  return {
    actions: OUTAGE_VIEW_ACTIONS,
    template: {
      ...template,
      Body: [{
        ...component,
        Props: {
          ...props,
          DataTable: dataTableId,
        },
      }],
    },
  };
}
