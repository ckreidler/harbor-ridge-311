import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { ConnectStack } from '../lib/connect-stack';

interface FlowCondition {
  NextAction: string;
  Condition: { Operator: string; Operands: string[] };
}

interface FlowAction {
  Identifier: string;
  Type: string;
  Parameters?: {
    Text?: string;
    TextToSpeechVoice?: string;
    InputTimeLimitSeconds?: string;
    Queries?: Array<{
      QueryName: string;
      Attributes: string[];
      PrimaryValues: Array<{ AttributeName: string; Value: string }>;
    }>;
  };
  Transitions?: {
    NextAction?: string;
    Errors?: Array<{ NextAction: string; ErrorType: string }>;
    Conditions?: FlowCondition[];
  };
}

interface FlowContent {
  Metadata: { ActionMetadata: Record<string, { position: { x: number; y: number } }> };
  Actions: FlowAction[];
}

function flowDocument(content: unknown): FlowContent {
  if (typeof content === 'string') {
    return JSON.parse(content) as FlowContent;
  }
  const joined = content as { 'Fn::Join'?: [string, unknown[]] };
  if (joined['Fn::Join']) {
    const [separator, parts] = joined['Fn::Join'];
    const text = parts.map((part) => (typeof part === 'string' ? part : 'token')).join(separator);
    return JSON.parse(text) as FlowContent;
  }
  throw new Error(`unexpected flow content: ${JSON.stringify(content)}`);
}

test('ConnectStack selects a language, looks up prompts, and associates the sandbox number', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new ConnectStack(app, 'ConnectStack'));

  template.resourceCountIs('AWS::Connect::ContactFlow', 1);
  template.resourceCountIs('AWS::Connect::DataTable', 1);
  template.resourceCountIs('AWS::Connect::DataTableAttribute', 3);
  template.resourceCountIs('AWS::Connect::DataTableRecord', 2);

  template.hasResourceProperties('AWS::Connect::DataTable', {
    Name: 'HarborRidge311-Prompts',
    Status: 'PUBLISHED',
  });
  template.hasResourceProperties('AWS::Connect::DataTableAttribute', {
    Name: 'Language',
    Primary: true,
    ValueType: 'TEXT',
  });

  const records = JSON.stringify(template.findResources('AWS::Connect::DataTableRecord'));
  expect(records).toContain('en-US');
  expect(records).toContain('Thank you for calling Harbor Ridge 3 1 1. This line is a demo.');
  expect(records).toContain('Thank you for calling Harbor Ridge 3 1 1. Goodbye.');
  expect(records).toContain('es-US');
  expect(records).toContain('Gracias por llamar a Harbor Ridge tres uno uno. Esta línea es una demostración.');
  expect(records).toContain('Gracias por llamar a Harbor Ridge tres uno uno. Adiós.');

  const flows = template.findResources('AWS::Connect::ContactFlow');
  const flow = Object.values(flows)[0] as { Properties: { Type: string; Content: unknown; Name: string } };
  expect(flow.Properties.Type).toBe('CONTACT_FLOW');
  expect(flow.Properties.Name).toBe('HarborRidge311-Main');

  const content = flowDocument(flow.Properties.Content);
  const menu = content.Actions.find((action) => action.Type === 'GetParticipantInput');
  const digits = menu?.Transitions?.Conditions?.map((branch) => branch.Condition.Operands[0]);
  expect(menu?.Parameters?.Text).toBe('For English, press 1. Para español, oprima 2.');
  expect(menu?.Parameters?.InputTimeLimitSeconds).toBe('5');
  expect(digits).toEqual(['1', '2']);
  expect(menu?.Transitions?.Conditions?.find((branch) => branch.Condition.Operands[0] === '1')?.NextAction)
    .toBe('set-en-attribute');
  expect(menu?.Transitions?.Conditions?.find((branch) => branch.Condition.Operands[0] === '2')?.NextAction)
    .toBe('set-es-attribute');
  expect(menu?.Transitions?.Errors?.map((error) => error.NextAction)).toEqual([
    'set-en-attribute',
    'set-en-attribute',
    'set-en-attribute',
  ]);

  expect(JSON.stringify(flow.Properties.Content)).toContain('Prompts');
  const lookup = content.Actions.find((action) => action.Type === 'EvaluateDataTableValues');
  expect(lookup?.Parameters?.Queries?.[0].QueryName).toBe('Prompts');
  expect(lookup?.Parameters?.Queries?.[0].Attributes).toEqual(['Greeting', 'Goodbye']);
  expect(lookup?.Parameters?.Queries?.[0].PrimaryValues).toEqual([
    { AttributeName: 'Language', Value: '$.Attributes.language' },
  ]);
  expect(lookup?.Transitions?.Errors?.[0].NextAction).toBe('play-fallback');

  const greeting = content.Actions.find((action) => action.Identifier === 'play-greeting');
  const goodbye = content.Actions.find((action) => action.Identifier === 'play-goodbye');
  expect(greeting?.Parameters?.Text).toBe('$.DataTables.Prompts.Greeting');
  expect(goodbye?.Parameters?.Text).toBe('$.DataTables.Prompts.Goodbye');
  expect(content.Actions.find((action) => action.Identifier === 'set-en-voice')?.Parameters?.TextToSpeechVoice)
    .toBe('Joanna');
  expect(content.Actions.find((action) => action.Identifier === 'set-es-voice')?.Parameters?.TextToSpeechVoice)
    .toBe('Lupe');
  expect(content.Actions.map((action) => action.Identifier).every((id) => content.Metadata.ActionMetadata[id]?.position))
    .toBe(true);

  const customResources = template.findResources('Custom::AWS');
  expect(Object.keys(customResources)).toHaveLength(1);
  const policies = template.findResources('AWS::IAM::Policy') as Record<string, {
    Properties: {
      PolicyDocument: {
        Statement: Array<{ Action: string | string[]; Resource?: string | unknown[] }>;
      };
    };
  }>;
  const customResourcePolicies = Object.values(policies).flatMap((policy) =>
    policy.Properties.PolicyDocument.Statement.filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.some((action) => action.startsWith('connect:'));
    }),
  );
  expect(customResourcePolicies.length).toBeGreaterThan(0);
  expect(JSON.stringify(customResourcePolicies)).not.toContain('"*"');
});
