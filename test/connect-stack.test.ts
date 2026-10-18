import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { ConnectStack } from '../lib/connect-stack';

interface FlowAction {
  Identifier: string;
  Type: string;
  Parameters?: { Text?: string; TextToSpeechVoice?: string };
  Transitions?: {
    NextAction?: string;
    Errors?: Array<{ NextAction: string; ErrorType: string }>;
  };
}

interface FlowContent {
  Actions: FlowAction[];
}

test('ConnectStack plays a message, disconnects, and associates the sandbox number', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new ConnectStack(app, 'ConnectStack'));

  template.resourceCountIs('AWS::Connect::ContactFlow', 1);
  const flows = template.findResources('AWS::Connect::ContactFlow');
  const flow = Object.values(flows)[0] as {
    Properties: { Type: string; Content: string; Name: string };
  };
  expect(flow.Properties.Type).toBe('CONTACT_FLOW');
  expect(flow.Properties.Name).toBe('HarborRidge311-Main');

  const content = JSON.parse(flow.Properties.Content) as FlowContent;
  const voice = content.Actions.find((action) => action.Type === 'UpdateContactTextToSpeechVoice');
  const message = content.Actions.find((action) => action.Type === 'MessageParticipant');
  const disconnect = content.Actions.find((action) => action.Type === 'DisconnectParticipant');
  expect(voice?.Parameters?.TextToSpeechVoice).toBe('Joanna');
  expect(message?.Parameters?.Text).toContain('Harbor Ridge 3 1 1');
  expect(message?.Transitions?.NextAction).toBe(disconnect?.Identifier);
  expect(message?.Transitions?.Errors?.map((error) => error.NextAction)).toContain(disconnect?.Identifier);

  const customResources = template.findResources('Custom::AWS');
  const association = Object.values(customResources).map((resource) => JSON.stringify(resource));
  expect(association).toHaveLength(1);
  expect(association[0]).toContain('AssociatePhoneNumberContactFlow');
  expect(association[0]).toContain('DisassociatePhoneNumberContactFlow');

  const parameters = template.toJSON().Parameters as Record<string, { Type?: string; Default?: string }>;
  const ssmParameters = Object.values(parameters)
    .filter((parameter) => parameter.Type === 'AWS::SSM::Parameter::Value<String>')
    .map((parameter) => parameter.Default);
  expect(ssmParameters).toEqual(expect.arrayContaining([
    '/connect/sandbox/instance-arn',
    '/connect/sandbox/instance-id',
    '/connect/sandbox/phone-number-arn',
    '/connect/sandbox/phone-number',
  ]));

  const policies = template.findResources('AWS::IAM::Policy') as Record<string, {
    Properties: {
      PolicyDocument: {
        Statement: Array<{ Action: string | string[]; Resource: string | unknown[] }>;
      };
    };
  }>;
  const connectResources = Object.values(policies).flatMap((policy) =>
    policy.Properties.PolicyDocument.Statement.filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.some((action) => action.startsWith('connect:'));
    }).map((statement) => statement.Resource),
  );
  expect(connectResources).toHaveLength(2);
  expect(JSON.stringify(connectResources)).not.toContain('"*"');
});
