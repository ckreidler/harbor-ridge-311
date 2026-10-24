import * as fs from 'node:fs';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { ConnectStack, CUSTOMER_QUEUE_PROMPT_ID } from '../lib/connect-stack';
import { ticketOpenApiDocument } from '../lib/tickets/openapi';
import {
  AFTER_HOURS_CLOSED_TEXT,
  AFTER_HOURS_TICKET_CHAT_TEXT,
  AFTER_HOURS_TICKET_TEXT_AFTER,
  AFTER_HOURS_TICKET_VOICE_TEXT,
} from '../lib/flows/main-flow';
import { QUEUE_CHAT_TEXT, QUEUE_VOICE_TEXT } from '../lib/flows/queue-flow';

interface FlowCondition {
  NextAction: string;
  Condition: { Operator: string; Operands: string[] };
}

interface FlowAction {
  Identifier: string;
  Type: string;
  Parameters?: {
    Text?: string;
    SSML?: string;
    TextToSpeechVoice?: string;
    InputTimeLimitSeconds?: string;
    WisdomAssistantArn?: string;
    ComparisonValue?: string;
    LexV2Bot?: { AliasArn?: string };
    InvocationTimeLimitSeconds?: string;
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
  StartAction: string;
  Metadata?: { ActionMetadata: Record<string, { position: { x: number; y: number } }> };
  Actions: FlowAction[];
}

function mainDocument(content: unknown): FlowContent {
  const document = flowDocument(content);
  expect(document.Metadata).toBeUndefined();
  return document;
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

function bundledHandler(template: Template, functionName: string, assetOutdir: string): string {
  const functions = template.findResources('AWS::Lambda::Function') as Record<string, {
    Properties: { FunctionName?: string; Code?: { S3Key?: string } };
  }>;
  const resource = Object.values(functions).find((candidate) => candidate.Properties.FunctionName === functionName);
  const key = resource?.Properties.Code?.S3Key;
  if (!key) {
    throw new Error(`missing code asset for ${functionName}`);
  }
  return fs.readFileSync(path.join(assetOutdir, `asset.${key.replace(/\.zip$/, '')}`, 'index.js'), 'utf8');
}

function contactFlow(template: Template, name: string) {
  const flows = template.findResources('AWS::Connect::ContactFlow');
  const flow = Object.values(flows).find((resource) => (
    resource as { Properties: { Name: string } }
  ).Properties.Name === name);
  if (!flow) {
    throw new Error(`missing flow ${name}`);
  }
  return flow as {
    DependsOn?: string | string[];
    Properties: { Type: string; Content: unknown; Name: string };
  };
}

test('ConnectStack looks up the English prompts and associates the sandbox number', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new ConnectStack(app, 'ConnectStack'));

  template.resourceCountIs('AWS::Connect::ContactFlow', 3);
  template.resourceCountIs('AWS::Connect::DataTable', 1);
  template.resourceCountIs('AWS::Connect::DataTableAttribute', 4);
  template.resourceCountIs('AWS::Connect::DataTableRecord', 10);

  template.hasResourceProperties('AWS::Connect::DataTable', {
    Name: 'HarborRidge311-PromptsByChannel',
    Status: 'PUBLISHED',
  });
  expect(Object.keys(template.findResources('AWS::Connect::DataTable'))).toEqual(['PromptsByChannel']);
  const tableChildren = JSON.stringify({
    ...template.findResources('AWS::Connect::DataTableAttribute'),
    ...template.findResources('AWS::Connect::DataTableRecord'),
  });
  expect(tableChildren).toContain('PromptsByChannel');
  expect(tableChildren).not.toContain('"Prompts"');
  const parameters = JSON.stringify(template.findResources('AWS::SSM::Parameter'));
  expect(parameters).not.toContain('Prompts');
  expect(parameters).not.toContain('DataTable');
  const attributes = template.findResources('AWS::Connect::DataTableAttribute') as Record<string, {
    Properties: { Name: string; Primary?: boolean; ValueType: string };
  }>;
  const attributeByName = Object.fromEntries(Object.values(attributes).map((attribute) => [
    attribute.Properties.Name,
    attribute.Properties,
  ]));
  expect(attributeByName.Prompt).toMatchObject({ Primary: true, ValueType: 'TEXT' });
  expect(attributeByName.Channel).toMatchObject({ Primary: true, ValueType: 'TEXT' });
  expect(attributeByName.Text).toMatchObject({ ValueType: 'TEXT' });
  expect(attributeByName.Text.Primary).toBeUndefined();
  expect(attributeByName.TextAfter).toMatchObject({ ValueType: 'TEXT' });
  expect(attributeByName.TextAfter.Primary).toBeUndefined();
  expect(attributeByName.Language).toBeUndefined();

  const recordResources = template.findResources('AWS::Connect::DataTableRecord') as Record<string, {
    Properties: {
      DataTableRecord: {
        PrimaryValues: Array<{ AttributeValue: string }>;
        Values: Array<{ AttributeValue: string }>;
      };
    };
  }>;
  const rows = Object.values(recordResources).map((record) => ({
    key: record.Properties.DataTableRecord.PrimaryValues.map((value) => value.AttributeValue).sort(),
    text: record.Properties.DataTableRecord.Values.map((value) => value.AttributeValue),
  }));
  expect(rows).toEqual(expect.arrayContaining([
    { key: ['Greeting', 'VOICE'], text: ['Thank you for calling Harbor Ridge 3 1 1. This line is a demo.'] },
    { key: ['CHAT', 'Greeting'], text: ['Welcome to Harbor Ridge 311 chat. This is a demo.'] },
    { key: ['Goodbye', 'VOICE'], text: ['Thank you for calling Harbor Ridge 3 1 1. Goodbye.'] },
    { key: ['CHAT', 'Goodbye'], text: ['Thanks for chatting with Harbor Ridge 311. Goodbye.'] },
    {
      key: ['Question', 'VOICE'],
      text: ['What can I help you with? You can ask about trash pickup, potholes, parking permits, or office hours. Say agent if you would rather talk to a person.'],
    },
    {
      key: ['CHAT', 'Question'],
      text: ['What can I help you with? You can ask about trash pickup, potholes, parking permits, or office hours, or type agent to reach a person.'],
    },
    { key: ['AfterHoursTicket', 'CHAT'], text: [AFTER_HOURS_TICKET_CHAT_TEXT, AFTER_HOURS_TICKET_TEXT_AFTER] },
    { key: ['AfterHoursTicket', 'VOICE'], text: [AFTER_HOURS_TICKET_VOICE_TEXT, AFTER_HOURS_TICKET_TEXT_AFTER] },
    { key: ['CHAT', 'Queue'], text: [QUEUE_CHAT_TEXT] },
    { key: ['Queue', 'VOICE'], text: [QUEUE_VOICE_TEXT] },
  ]));
  expect(rows).toHaveLength(10);
  expect(rows.some((row) => row.key.includes('AfterHours') && !row.key.includes('AfterHoursTicket'))).toBe(false);
  const records = JSON.stringify(recordResources);
  expect(records).not.toContain('en-US');
  expect(records).not.toContain('es-US');
  expect(records).not.toContain('Gracias');

  const flow = contactFlow(template, 'HarborRidge311-Main');
  expect(flow.Properties.Type).toBe('CONTACT_FLOW');

  const content = mainDocument(flow.Properties.Content);
  expect(content.Actions.some((action) => action.Type === 'GetParticipantInput')).toBe(false);
  expect(content.Actions.some((action) => action.Identifier === 'set-es-language')).toBe(false);
  expect(content.Actions.some((action) => action.Identifier === 'set-es-voice')).toBe(false);
  expect(JSON.stringify(content)).not.toContain('español');
  expect(JSON.stringify(content)).not.toContain('$.Attributes.language');

  expect(JSON.stringify(flow.Properties.Content)).toContain('PromptsByChannel');
  expect(JSON.stringify(flow.Properties.Content)).toContain('$.Channel');
  const lookup = content.Actions.find((action) => action.Type === 'EvaluateDataTableValues');
  expect(lookup?.Parameters?.Queries).toEqual(['Greeting', 'Goodbye', 'Question'].map((prompt) => ({
    QueryName: prompt,
    Attributes: ['Text'],
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: prompt },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  })));
  expect(lookup?.Transitions?.NextAction).toBe('play-greeting');
  expect(lookup?.Transitions?.Errors?.[0].NextAction).toBe('play-fallback');

  const greeting = content.Actions.find((action) => action.Identifier === 'play-greeting');
  const goodbye = content.Actions.find((action) => action.Identifier === 'play-goodbye');
  expect(greeting?.Parameters?.Text).toBe('$.DataTables.Greeting.Text');
  expect(greeting?.Transitions?.Errors?.[0].NextAction).toBe('play-fallback');
  expect(goodbye?.Parameters?.Text).toBe('$.DataTables.Goodbye.Text');
  expect(content.Actions.some((action) => action.Identifier === 'check-prompt')).toBe(false);
  expect(content.Actions.some((action) => action.Identifier === 'set-en-language')).toBe(false);
  expect(JSON.stringify(content)).not.toContain('LanguageCode');
  expect(content.Actions.some((action) => action.Identifier === 'branch-channel')).toBe(false);
  expect(content.Actions.some((action) => action.Identifier === 'set-chat-prompts')).toBe(false);
  expect(content.Actions.find((action) => action.Identifier === 'set-en-voice')?.Transitions?.NextAction)
    .toBe('lookup-prompts');
  const synthesized = JSON.stringify(content);
  expect(synthesized).not.toContain('Welcome to Harbor Ridge 311 chat');
  expect(synthesized).not.toContain('Say agent');
  expect(synthesized).not.toContain('$.Attributes.greeting');
  expect(synthesized).toContain('Thank you for calling Harbor Ridge 3 1 1. This line is a demo.');
  expect(content.Actions.find((action) => action.Identifier === 'set-en-voice')?.Parameters?.TextToSpeechVoice)
    .toBe('Joanna');
  expect(content.Actions.find((action) => action.Identifier === 'enable-flow-logging')?.Transitions?.NextAction)
    .toBe('set-en-voice');
  expect(content.Metadata).toBeUndefined();
  const recordIds = Object.keys(template.findResources('AWS::Connect::DataTableRecord'));
  const dependsOn = [flow.DependsOn].flat();
  expect(dependsOn).toEqual(expect.arrayContaining([...recordIds, 'LexBotIntegration', 'OrchestratorLambdaIntegration']));

  const customResources = template.findResources('Custom::AWS');
  expect(JSON.stringify(customResources)).toContain('AssociatePhoneNumberContactFlow');
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

interface PolicyStatement {
  Action: string | string[];
  Resource?: unknown;
}

function contractApi(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(contractApi);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === 'security' || key.startsWith('x-amazon-apigateway-')) continue;
    next[key] = contractApi(child);
  }
  if (next.components && typeof next.components === 'object') {
    const components = { ...(next.components as Record<string, unknown>) };
    delete components.securitySchemes;
    next.components = components;
  }
  return next;
}

function policyStatements(template: Template): PolicyStatement[] {
  const policies = template.findResources('AWS::IAM::Policy') as Record<string, {
    Properties: { PolicyDocument: { Statement: PolicyStatement[] } };
  }>;
  return Object.values(policies).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

function joinReferencesVersionNumber(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(joinReferencesVersionNumber);
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  const join = record['Fn::Join'];
  if (join !== undefined && JSON.stringify(join).includes('VersionNumber')) {
    return true;
  }
  return Object.values(record).some(joinReferencesVersionNumber);
}

function resourceValues(resource: unknown): string[] {
  const values = Array.isArray(resource) ? resource : [resource];
  return values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value)));
}

const NUMERIC_JSON_SCHEMA_KEYWORDS = new Set([
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'maxItems',
  'minItems',
  'maxProperties',
  'minProperties',
  'maxContains',
  'minContains',
]);

function numericJsonSchemaKeywords(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== 'object') {
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      numericJsonSchemaKeywords(item, found);
    }
    return found;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (NUMERIC_JSON_SCHEMA_KEYWORDS.has(key)) {
      found.push(key);
    }
    numericJsonSchemaKeywords(child, found);
  }
  return found;
}

test('ConnectStack answers city questions from Q in Connect and falls back to goodbye', () => {
  const app = new cdk.App();
  const stack = new ConnectStack(app, 'ConnectStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.resourceCountIs('AWS::KMS::Key', 1);
  template.resourceCountIs('AWS::AppIntegrations::DataIntegration', 1);
  template.resourceCountIs('AWS::Wisdom::Assistant', 0);
  template.resourceCountIs('AWS::Wisdom::KnowledgeBase', 1);
  template.resourceCountIs('AWS::Wisdom::AssistantAssociation', 1);
  template.resourceCountIs('AWS::Wisdom::AIGuardrail', 1);
  template.resourceCountIs('AWS::Wisdom::AIGuardrailVersion', 1);
  template.resourceCountIs('AWS::Wisdom::AIAgent', 2);
  template.resourceCountIs('AWS::Wisdom::AIAgentVersion', 2);
  template.resourceCountIs('AWS::Wisdom::AIPrompt', 2);
  template.resourceCountIs('AWS::Wisdom::AIPromptVersion', 2);
  template.resourceCountIs('AWS::Connect::SecurityProfile', 2);
  template.resourceCountIs('AWS::Lex::Bot', 1);
  template.resourceCountIs('AWS::Lex::BotVersion', 1);
  template.resourceCountIs('AWS::Lex::BotAlias', 1);
  template.resourceCountIs('AWS::Connect::IntegrationAssociation', 5);
  template.resourceCountIs('Custom::AWS', 8);

  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  const bucketPolicy = JSON.stringify(template.findResources('AWS::S3::BucketPolicy'));
  expect(bucketPolicy).toContain('app-integrations.amazonaws.com');
  expect(bucketPolicy).toContain('s3:GetObject');
  expect(bucketPolicy).toContain('s3:ListBucket');
  expect(bucketPolicy).toContain('s3:GetBucketLocation');
  expect(bucketPolicy).toContain('aws:SecureTransport');

  template.hasResourceProperties('AWS::AppIntegrations::DataIntegration', {
    Name: 'HarborRidge311-Faqs',
  });
  const dataIntegration = JSON.stringify(template.findResources('AWS::AppIntegrations::DataIntegration'));
  expect(dataIntegration).toContain('s3://');
  expect(dataIntegration).toContain('FaqBucket');
  template.hasResourceProperties('AWS::Wisdom::KnowledgeBase', {
    Name: 'HarborRidge311-Faqs',
    KnowledgeBaseType: 'EXTERNAL',
  });
  template.hasResourceProperties('AWS::Wisdom::AssistantAssociation', {
    AssociationType: 'KNOWLEDGE_BASE',
  });
  template.hasResourceProperties('AWS::Wisdom::AIAgent', {
    Name: 'HarborRidge311-VoiceOrchestration',
    Type: 'ORCHESTRATION',
  });
  template.hasResourceProperties('AWS::Wisdom::AIAgent', {
    Name: 'HarborRidge311-ChatOrchestration',
    Type: 'ORCHESTRATION',
  });
  template.hasResourceProperties('AWS::Wisdom::AIPrompt', {
    Name: 'HarborRidge311-VoiceOrchestration',
    Type: 'ORCHESTRATION',
    ApiFormat: 'MESSAGES',
    TemplateType: 'TEXT',
    ModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  });
  template.hasResourceProperties('AWS::Wisdom::AIPrompt', {
    Name: 'HarborRidge311-ChatOrchestration',
    Type: 'ORCHESTRATION',
    ApiFormat: 'MESSAGES',
    TemplateType: 'TEXT',
    ModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  });
  template.hasResourceProperties('AWS::Connect::SecurityProfile', {
    SecurityProfileName: 'HarborRidge311-Orchestration',
    Permissions: ['Wisdom.View'],
  });
  const agent = JSON.stringify(template.findResources('AWS::Wisdom::AIAgent'));
  expect(agent).toContain('OrchestrationAIGuardrailId');
  expect(agent).toContain('OrchestrationAIPromptId');
  expect(agent).toContain('AIGuardrailVersionId');
  expect(agent).toContain('AIPromptVersionId');
  expect(agent).toContain('"Locale":"en_US"');
  expect(agent).toContain('ConnectInstanceArn');
  expect(agent).not.toContain('SELF_SERVICE');
  expect(agent).not.toContain('SelfServiceAIGuardrailId');
  expect(agent).toContain('"ToolName":"Complete"');
  expect(agent).toContain('"ToolName":"Escalate"');
  expect(agent).toContain('"ToolName":"Retrieve"');
  expect(agent).toContain('"ToolType":"RETURN_TO_CONTROL"');
  expect(agent).toContain('"ToolType":"MODEL_CONTEXT_PROTOCOL"');
  expect(agent).toContain('aws_service__qconnect_Retrieve');
  expect(agent).toContain('{{$.assistantId}}');
  expect(agent).toContain('{{$.knowledgeBaseAssistantAssociationIds}}');
  expect(agent).toContain('"JsonPath":"$.assistantId"');
  expect(agent).toContain('"Type":"JSON_STRING","Value":"{{$.knowledgeBaseAssistantAssociationIds}}"');
  expect(agent).toContain('"Type":"STRING","Value":"{{$.assistantId}}"');
  expect(agent).toContain('escalationReason');
  expect(agent).toContain('complex_request');
  expect(agent).toContain('customer_frustration');
  expect(agent).toContain('policy_exception');
  expect(agent).toContain('out_of_scope');
  const prompts = JSON.stringify(template.findResources('AWS::Wisdom::AIPrompt'));
  for (const variable of [
    '<message>',
    '<thinking>',
    '{{$.toolConfigurationList}}',
    '{{$.conversationHistory}}',
    '{{$.locale}}',
    '{{$.contactId}}',
    '{{$.instanceId}}',
    '{{$.sessionId}}',
    '{{$.assistantId}}',
    '{{$.dateTime}}',
  ]) {
    expect(prompts).toContain(variable);
  }
  expect(prompts).toContain('spoken aloud');
  expect(prompts).toContain('Do not use markdown');
  expect(prompts).toContain('simple lists');
  expect(prompts).not.toContain('es_US');
  const agentProperties = new Set([
    'AssistantId', 'Configuration', 'Description', 'Name', 'Tags', 'Type',
  ]);
  const orchestrationProperties = new Set([
    'ConnectInstanceArn', 'Locale', 'OrchestrationAIGuardrailId', 'OrchestrationAIPromptId', 'ToolConfigurations',
  ]);
  const toolProperties = new Set([
    'Annotations', 'Description', 'InputSchema', 'Instruction', 'OutputFilters', 'OutputSchema',
    'OverrideInputValues', 'Title', 'ToolId', 'ToolName', 'ToolType', 'UserInteractionConfiguration',
  ]);
  const promptProperties = new Set([
    'ApiFormat', 'AssistantId', 'Description', 'ModelId', 'Name', 'Tags',
    'TemplateConfiguration', 'TemplateType', 'Type',
  ]);
  for (const resource of Object.values(template.findResources('AWS::Wisdom::AIAgent')) as Array<{
    Properties: Record<string, unknown> & {
      Configuration?: { OrchestrationAIAgentConfiguration?: Record<string, unknown> & {
        ToolConfigurations?: Array<Record<string, unknown>>;
      } };
    };
  }>) {
    expect(Object.keys(resource.Properties).every((key) => agentProperties.has(key))).toBe(true);
    const configuration = resource.Properties.Configuration?.OrchestrationAIAgentConfiguration;
    expect(configuration).toBeDefined();
    expect(Object.keys(configuration ?? {}).every((key) => orchestrationProperties.has(key))).toBe(true);
    for (const tool of configuration?.ToolConfigurations ?? []) {
      expect(Object.keys(tool).every((key) => toolProperties.has(key))).toBe(true);
      expect(['MODEL_CONTEXT_PROTOCOL', 'RETURN_TO_CONTROL', 'CONSTANT']).toContain(tool.ToolType);
      expect(numericJsonSchemaKeywords(tool.InputSchema)).toEqual([]);
    }
  }
  for (const resource of Object.values(template.findResources('AWS::Wisdom::AIPrompt')) as Array<{
    Properties: Record<string, unknown>;
  }>) {
    expect(Object.keys(resource.Properties).every((key) => promptProperties.has(key))).toBe(true);
    expect(resource.Properties.ApiFormat).toBe('MESSAGES');
    expect(resource.Properties.TemplateType).toBe('TEXT');
    expect(resource.Properties.Type).toBe('ORCHESTRATION');
  }
  expect(JSON.stringify(template.findResources('Custom::AWS'))).toContain('AIAgentVersionId');
  expect(joinReferencesVersionNumber(template.toJSON())).toBe(false);
  expect(JSON.stringify(template.findResources('AWS::Wisdom::AIGuardrailVersion'))).toContain('ModifiedTimeSeconds');
  expect(JSON.stringify(template.findResources('AWS::Wisdom::AIAgentVersion'))).toContain('ModifiedTimeSeconds');

  const guardrail = JSON.stringify(template.findResources('AWS::Wisdom::AIGuardrail'));
  expect(guardrail).not.toContain('TopicPolicyConfig');
  expect(guardrail).not.toContain('Off topic');
  expect(guardrail).toContain('I can only help with Harbor Ridge city services');
  expect(guardrail).toContain('I cannot share that');
  expect(guardrail).not.toContain('ADDRESS');
  for (const pii of ['EMAIL', 'PHONE', 'NAME', 'US_SOCIAL_SECURITY_NUMBER', 'CREDIT_DEBIT_CARD_NUMBER']) {
    expect(guardrail).toContain(pii);
  }
  expect(guardrail).toContain('BLOCK');
  const guardrailResources = template.findResources('AWS::Wisdom::AIGuardrail') as Record<string, {
    Properties: {
      SensitiveInformationPolicyConfig?: {
        RegexesConfig?: unknown[];
      };
    };
  }>;
  const regexes = Object.values(guardrailResources).flatMap((resource) =>
    resource.Properties.SensitiveInformationPolicyConfig?.RegexesConfig ?? []);
  expect(regexes.length).toBeGreaterThan(0);
  expect(JSON.stringify(regexes)).toContain('AccountNumber');
  expect(JSON.stringify(regexes)).toContain('\\\\b\\\\d{10,12}\\\\b');

  const integrations = template.findResources('AWS::Connect::IntegrationAssociation');
  const integrationTypes = Object.values(integrations).map((resource) => (
    resource as { Properties: { IntegrationType: string } }
  ).Properties.IntegrationType);
  expect(integrationTypes.sort()).toEqual([
    'APPLICATION',
    'LAMBDA_FUNCTION',
    'LAMBDA_FUNCTION',
    'LEX_BOT',
    'WISDOM_KNOWLEDGE_BASE',
  ]);
  const lambdaIntegrations = Object.values(integrations).filter((resource) => (
    resource as { Properties: { IntegrationType: string } }
  ).Properties.IntegrationType === 'LAMBDA_FUNCTION');
  expect(lambdaIntegrations).toHaveLength(2);

  const parameters = template.toJSON().Parameters as Record<string, { Default?: string }>;
  const instanceArnParameter = Object.entries(parameters).find(([, parameter]) => (
    parameter.Default === '/connect/sandbox/instance-arn'
  ))?.[0];
  const connectPermissions = Object.values(template.findResources('AWS::Lambda::Permission') as Record<string, {
    Properties: { Action?: string; Principal?: string; SourceArn?: { Ref?: string } };
  }>).filter((permission) => permission.Properties.Principal === 'connect.amazonaws.com');
  expect(connectPermissions).toHaveLength(2);
  for (const permission of connectPermissions) {
    expect(permission.Properties.Action).toBe('lambda:InvokeFunction');
    expect(permission.Properties.SourceArn).toEqual({ Ref: instanceArnParameter });
  }

  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'HarborRidge311-SelectOrchestrator',
    Timeout: 8,
    Runtime: 'nodejs22.x',
  });
  const selectOrchestratorBundle = bundledHandler(template, 'HarborRidge311-SelectOrchestrator', app.assetOutdir);
  expect(selectOrchestratorBundle).toContain('var UpdateSessionRequest$ = [');
  expect(selectOrchestratorBundle).toContain('var _oCL = "orchestratorConfigurationList"');
  expect(selectOrchestratorBundle).toContain('_oCL, _rOCL]');
  expect(selectOrchestratorBundle).toContain('() => OrchestratorConfigurationList');
  expect(selectOrchestratorBundle).not.toMatch(/require\(["']@aws-sdk\/client-qconnect["']\)/);
  expect(Object.values(template.findResources('AWS::Lambda::Function')).some((resource) => (
    (resource as { Properties: { FunctionName?: string } }).Properties.FunctionName === 'HarborRidge311-VoicemailIndexer'
  ))).toBe(false);

  const parameterDefaults = Object.values(template.toJSON().Parameters as Record<string, { Default?: string }>)
    .map((parameter) => parameter.Default);
  expect(parameterDefaults).toEqual(expect.arrayContaining([
    '/connect/sandbox/assistant-arn',
    '/connect/sandbox/assistant-id',
  ]));

  template.hasResourceProperties('AWS::Lex::BotAlias', {
    BotAliasName: 'live',
    BotAliasLocaleSettings: [
      { LocaleId: 'en_US', BotAliasLocaleSetting: { Enabled: true } },
    ],
  });
  template.hasResourceProperties('AWS::Lex::Bot', {
    TestBotAliasSettings: {
      BotAliasLocaleSettings: [
        { LocaleId: 'en_US', BotAliasLocaleSetting: { Enabled: true } },
      ],
    },
  });

  const bot = JSON.stringify(template.findResources('AWS::Lex::Bot'));
  expect(bot).toContain('AMAZON.QInConnectIntent');
  expect(bot).not.toContain('AMAZON.QinConnectIntent');
  expect(bot).toContain('AMAZON.FallbackIntent');
  expect(bot).toContain('en_US');
  expect(bot).not.toContain('es_US');
  expect(bot).not.toContain('AMAZON.QnAIntent');

  const customResources = JSON.stringify(template.findResources('Custom::AWS'));
  expect(customResources).toContain('UpdateAssistantAIAgent');
  expect(customResources).toContain('RemoveAssistantAIAgent');
  expect(customResources).toContain('ORCHESTRATION');
  expect(customResources).toContain('Connect.SelfService');
  expect(customResources).not.toContain('SELF_SERVICE');
  expect(customResources).toContain('QConnect');
  expect(customResources).toContain('assistantId');
  expect(customResources).toContain('aiAgentId');
  expect(customResources).toContain('AssociateSecurityProfiles');
  expect(customResources).toContain('DisassociateSecurityProfiles');
  expect(customResources).toContain('AI_AGENT');
  const setDefault = Object.values(template.findResources('Custom::AWS')).find((resource) =>
    JSON.stringify(resource).includes('UpdateAssistantAIAgent')) as { DependsOn?: string | string[] };
  const setDefaultDependsOn = [setDefault.DependsOn].flat();
  expect(setDefaultDependsOn).toEqual(expect.arrayContaining(['MainFlow', 'CityQuestionsBotAlias']));
  for (const association of [
    'AssociateVoiceAgentProfile',
    'AssociateVoiceAgentVersionProfile',
    'AssociateChatAgentProfile',
    'AssociateChatAgentVersionProfile',
  ]) {
    expect(setDefaultDependsOn.some((dependency) => dependency?.startsWith(association))).toBe(true);
  }

  const flow = contactFlow(template, 'HarborRidge311-Main');
  const content = mainDocument(flow.Properties.Content);
  const session = content.Actions.find((action) => action.Type === 'CreateWisdomSession');
  const lexBots = content.Actions.filter((action) => action.Type === 'ConnectParticipantWithLexBot');
  const toolCheck = content.Actions.find((action) => action.Identifier === 'check-tool');
  const orchestrator = content.Actions.find((action) => action.Identifier === 'select-orchestrator');
  const escalation = content.Actions.find((action) => action.Identifier === 'set-escalation');
  expect(session?.Parameters?.WisdomAssistantArn).toBe('token');
  expect(session?.Transitions?.NextAction).toBe('select-orchestrator');
  expect(session?.Transitions?.Errors?.[0].NextAction).toBe('play-goodbye');
  expect(content.Actions.some((action) => action.Identifier === 'check-question-language')).toBe(false);
  expect(content.Actions.some((action) => action.Identifier === 'ask-es-question')).toBe(false);
  expect(lexBots.map((action) => action.Parameters?.Text)).toEqual(['$.DataTables.Question.Text']);
  expect(lexBots.every((action) => action.Parameters?.LexV2Bot?.AliasArn === 'token')).toBe(true);
  expect(JSON.stringify(lexBots)).toContain('"x-amz-lex:q-in-connect:session-arn":"$.Wisdom.SessionArn"');
  expect(lexBots).toHaveLength(1);
  for (const action of lexBots) {
    const branch = (errorType: string) =>
      action.Transitions?.Errors?.find((error) => error.ErrorType === errorType)?.NextAction;
    expect(action.Transitions?.Conditions).toEqual([]);
    expect(branch('NoMatchingCondition')).toBe('check-tool');
    expect(branch('InputTimeLimitExceeded')).toBe('check-hours');
    expect(branch('NoMatchingError')).toBe('check-hours');
    expect(action.Transitions?.NextAction).toBe('check-hours');
  }
  expect(orchestrator?.Type).toBe('InvokeLambdaFunction');
  expect(orchestrator?.Parameters?.InvocationTimeLimitSeconds).toBe('8');
  expect(orchestrator?.Transitions?.NextAction).toBe('ask-en-question');
  expect(orchestrator?.Transitions?.Errors).toEqual([
    { ErrorType: 'NoMatchingError', NextAction: 'ask-en-question' },
  ]);
  expect(JSON.stringify(orchestrator?.Parameters)).toContain('"sessionArn":"$.Wisdom.SessionArn"');
  expect(toolCheck?.Parameters?.ComparisonValue).toBe('$.Lex.SessionAttributes.Tool');
  expect(toolCheck?.Transitions?.Conditions?.find((branch) => branch.Condition.Operands[0] === 'Complete')?.NextAction)
    .toBe('play-goodbye');
  expect(toolCheck?.Transitions?.Conditions?.find((branch) => branch.Condition.Operands[0] === 'Escalate')?.NextAction)
    .toBe('set-escalation');
  expect(toolCheck?.Transitions?.Conditions?.some((branch) => branch.Condition.Operands[0] === 'COMPLETE')).toBe(false);
  expect(toolCheck?.Transitions?.Conditions?.some((branch) => branch.Condition.Operands[0] === 'ESCALATION')).toBe(false);
  expect(toolCheck?.Transitions?.Errors?.[0]).toEqual({
    ErrorType: 'NoMatchingCondition',
    NextAction: 'check-hours',
  });
  expect(escalation?.Type).toBe('UpdateContactAttributes');
  expect(escalation?.Transitions?.NextAction).toBe('check-hours');
  expect(JSON.stringify(escalation?.Parameters)).toContain('"escalationReason":"$.Lex.SessionAttributes.escalationReason"');
  expect(JSON.stringify(escalation?.Parameters)).toContain('"escalationSummary":"$.Lex.SessionAttributes.escalationSummary"');
  expect(JSON.stringify(escalation?.Parameters)).toContain('"customerIntent":"$.Lex.SessionAttributes.customerIntent"');
  expect(JSON.stringify(escalation?.Parameters)).toContain('"sentiment":"$.Lex.SessionAttributes.sentiment"');
  expect(content.Actions.find((action) => action.Identifier === 'play-greeting')?.Transitions?.NextAction)
    .toBe('branch-identity');
  expect(content.Metadata).toBeUndefined();

  const associateStatements = policyStatements(template).filter((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.some((action) => action === 'connect:AssociateSecurityProfiles' || action === 'connect:DisassociateSecurityProfiles');
  });
  expect(associateStatements.length).toBeGreaterThan(0);
  for (const statement of associateStatements) {
    expect(JSON.stringify(statement.Resource)).not.toContain('*');
    expect(statement.Action).not.toContain('*');
  }
  const getAgentStatements = policyStatements(template).filter((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.includes('wisdom:GetAIAgent');
  });
  expect(getAgentStatements).toHaveLength(4);
  for (const statement of getAgentStatements) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    expect(actions).toEqual(['wisdom:GetAIAgent']);
    const resources = resourceValues(statement.Resource);
    expect(resources).toHaveLength(8);
    expect(resources.filter((resource) => resource.includes('OrchestrationAgentVersion'))).toHaveLength(2);
    expect(resources.filter((resource) => resource.includes('AIAgentArn') && !resource.includes('OrchestrationAgentVersion'))).toHaveLength(2);
    expect(resources.filter((resource) => resource.includes('AIAgentId') && resource.includes(':*'))).toHaveLength(2);
    expect(resources.filter((resource) => resource.includes('AIAgentId') && !resource.includes(':*'))).toHaveLength(2);
    expect(resources.some((resource) => resource.includes('VersionNumber') || resource.includes('Fn::Sub'))).toBe(false);
    expect(resources.every((resource) => !resource.includes('*') || resource.includes(':*'))).toBe(true);
  }
  const defaultAgentStatements = policyStatements(template).filter((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.includes('wisdom:UpdateAssistantAIAgent');
  });
  expect(defaultAgentStatements).toHaveLength(1);
  expect([defaultAgentStatements[0]?.Action].flat()).not.toContain('wisdom:GetAIAgent');
  const customResourceText = JSON.stringify(template.findResources('Custom::AWS'));
  expect(customResourceText.match(/DisassociateSecurityProfiles/g)).toHaveLength(4);
  expect(customResourceText.match(/ResourceNotFoundException\|InvalidParameterException/g)).toHaveLength(4);
  expect(customResourceText).toContain('RemoveAssistantAIAgent');
  expect(customResourceText).toContain('ignoreErrorCodesMatching\\":\\"ResourceNotFoundException\\"');

  const wisdomStatements = policyStatements(template).filter((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.some((action) => action.startsWith('wisdom:'));
  });
  expect(wisdomStatements.length).toBeGreaterThan(0);
  for (const statement of wisdomStatements) {
    expect(resourceValues(statement.Resource).some((resource) => resource === '*')).toBe(false);
  }
  const wisdomResources = wisdomStatements.flatMap((statement) => resourceValues(statement.Resource)).join('\n');
  expect(wisdomResources).toContain('assistantarn');
  expect(wisdomResources).toContain('assistantid');
  expect(wisdomResources).not.toContain('Assistant.AssistantArn');

  const keyPolicy = JSON.stringify(template.findResources('AWS::KMS::Key'));
  expect(keyPolicy).toContain('"Resource":"*"');
});

test('ConnectStack opens an after-hours case and removes voicemail', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new ConnectStack(app, 'ConnectStack'));

  template.hasResourceProperties('AWS::Connect::HoursOfOperation', {
    Name: 'HarborRidge311-Hours',
    TimeZone: 'America/Los_Angeles',
    Config: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map((day) => ({
      Day: day,
      StartTime: { Hours: 8, Minutes: 0 },
      EndTime: { Hours: 17, Minutes: 0 },
    })),
  });

  const main = mainDocument(contactFlow(template, 'HarborRidge311-Main').Properties.Content);
  const logging = main.Actions.find((action) => action.Identifier === 'enable-flow-logging');
  const hoursCheck = main.Actions.find((action) => action.Identifier === 'check-hours');
  const block = (identifier: string) => {
    const found = main.Actions.find((action) => action.Identifier === identifier);
    if (!found) {
      throw new Error(`missing ${identifier}`);
    }
    return found;
  };
  expect(main.StartAction).toBe('enable-flow-logging');
  expect(logging?.Transitions?.NextAction).toBe('set-en-voice');
  expect(main.Actions.some((action) => action.Identifier === 'set-en-language')).toBe(false);
  expect(hoursCheck?.Type).toBe('CheckHoursOfOperation');
  expect(hoursCheck?.Transitions?.Conditions?.find((branch) => branch.Condition.Operands[0] === 'True')?.NextAction)
    .toBe('set-event-flow');
  expect(hoursCheck?.Transitions?.Conditions?.find((branch) => branch.Condition.Operands[0] === 'False')?.NextAction)
    .toBe('check-ticket-subject');
  expect(hoursCheck?.Transitions?.Errors?.[0]).toEqual({
    ErrorType: 'NoMatchingError',
    NextAction: 'check-ticket-subject',
  });
  expect(main.Actions.some((action) => action.Identifier === 'play-agent-placeholder')).toBe(false);
  expect(main.Actions.some((action) => action.Identifier === 'transfer-after-hours')).toBe(false);
  expect(main.Actions.some((action) => action.Type === 'TransferToFlow')).toBe(false);
  expect(main.Actions.find((action) => action.Identifier === 'set-en-voice')?.Transitions?.NextAction)
    .toBe('lookup-prompts');
  expect(main.Actions.some((action) => action.Identifier === 'select-language')).toBe(false);
  expect(Object.keys(template.findResources('AWS::Connect::ContactFlow')).some((id) => id.startsWith('AfterHours')))
    .toBe(false);

  expect(main.Actions.some((action) => action.Type === 'GetCustomerProfile')).toBe(true);
  expect(main.Actions.some((action) => action.Type === 'CreateCustomerProfile')).toBe(true);
  expect(block('check-ticket-subject').Parameters?.ComparisonValue).toBe('$.Attributes.customerIntent');
  expect(block('check-ticket-subject').Transitions?.Conditions?.[0]).toMatchObject({
    NextAction: 'set-ticket-subject',
    Condition: { Operator: 'Exists', Operands: [] },
  });
  expect(JSON.stringify(block('set-ticket-subject').Parameters)).toContain('"ticketSubject":"$.Attributes.customerIntent"');
  expect(JSON.stringify(block('set-fallback-subject').Parameters)).toContain('"ticketSubject":"After-hours request"');
  expect(block('set-ticket-subject').Transitions?.NextAction).toBe('check-customer-id');
  expect(block('set-fallback-subject').Transitions?.NextAction).toBe('check-customer-id');
  expect(block('set-fallback-subject').Transitions?.Errors?.[0].NextAction).toBe('play-closed');

  expect(block('create-ticket').Type).toBe('InvokeLambdaFunction');
  expect(block('create-ticket').Parameters?.InvocationTimeLimitSeconds).toBe('8');
  expect(block('create-ticket').Transitions?.NextAction).toBe('check-ticket-id');
  expect(block('create-ticket').Transitions?.Errors?.[0].NextAction).toBe('play-closed');
  expect(block('check-customer-id').Transitions?.Conditions?.[0]).toMatchObject({
    NextAction: 'create-ticket',
    Condition: { Operator: 'Exists', Operands: [] },
  });
  expect(block('check-customer-id').Transitions?.NextAction).toBe('play-closed');
  expect(block('check-ticket-id').Parameters?.ComparisonValue).toBe('$.External.ticketId');
  expect(block('lookup-after-hours-ticket').Parameters?.Queries).toEqual([{
    QueryName: 'AfterHoursTicket',
    Attributes: ['Text', 'TextAfter'],
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: 'AfterHoursTicket' },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  }]);
  expect(block('check-ticket-prompt').Transitions?.Conditions?.[0]).toMatchObject({
    NextAction: 'branch-ticket-channel',
    Condition: { Operator: 'Exists', Operands: [] },
  });
  expect(block('play-ticket-chat').Parameters?.Text).toBe(
    '$.DataTables.AfterHoursTicket.Text $.External.ticketId. $.DataTables.AfterHoursTicket.TextAfter',
  );
  expect(block('play-ticket-chat').Parameters?.SSML).toBeUndefined();
  expect(block('play-ticket-chat').Transitions?.NextAction).toBe('disconnect');
  expect(block('play-ticket-voice').Parameters?.SSML).toBe(
    '<speak>$.DataTables.AfterHoursTicket.Text <say-as interpret-as="characters">$.External.ticketId</say-as>. $.DataTables.AfterHoursTicket.TextAfter</speak>',
  );
  expect(block('play-ticket-voice').Parameters?.Text).toBeUndefined();
  expect(block('play-ticket-voice').Transitions?.NextAction).toBe('disconnect');
  expect(block('play-ticket-voice').Transitions?.Errors?.[0].NextAction).toBe('play-closed');
  expect(JSON.stringify(main)).not.toContain('CreateCase');
  expect(JSON.stringify(main)).not.toContain('GetCase');
  expect(block('play-closed').Parameters?.Text).toBe(AFTER_HOURS_CLOSED_TEXT);
  expect(block('play-closed').Transitions?.NextAction).toBe('disconnect');
  expect(JSON.stringify(main)).not.toContain('Voicemail');
  expect(JSON.stringify(main)).not.toContain('leave a message');
  const mainRaw = JSON.stringify(contactFlow(template, 'HarborRidge311-Main').Properties.Content);
  expect(mainRaw).not.toContain('ServiceRequestTemplate');
  expect(mainRaw).not.toContain('case_reason');

  template.resourceCountIs('AWS::DynamoDB::Table', 1);
  template.resourceCountIs('AWS::Events::Rule', 0);
  template.resourceCountIs('AWS::SQS::Queue', 0);
  template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 0);
  const parameters = template.toJSON().Parameters as Record<string, { Default?: string }>;
  const parameterDefaults = Object.values(parameters).map((parameter) => parameter.Default);
  expect(parameterDefaults).toContain('/connect/sandbox/instance-arn');
  expect(parameterDefaults).not.toContain('/connect/sandbox/storage-bucket');
  const templateText = JSON.stringify(template.toJSON());
  expect(templateText).not.toContain('HarborRidge311-Voicemails');
  expect(templateText).not.toContain('HarborRidge311-VoicemailIndexer');
  expect(templateText).not.toContain('HarborRidge311-AfterHours');
});

test('ConnectStack stores customer-scoped tickets behind an IAM API and a JWT gateway', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new ConnectStack(app, 'ConnectStack'));
  const text = JSON.stringify(template.toJSON());

  template.resourceCountIs('AWS::Cases::Domain', 0);
  template.resourceCountIs('AWS::Cases::Field', 0);
  template.resourceCountIs('AWS::Cases::Layout', 0);
  template.resourceCountIs('AWS::Cases::Template', 0);
  expect(text).not.toContain('cases-domain-id');
  expect(text).not.toContain('cases:');
  expect(text).not.toContain('BatchPutFieldOptions');

  const tables = template.findResources('AWS::DynamoDB::Table') as Record<string, {
    DeletionPolicy?: string;
    UpdateReplacePolicy?: string;
    Properties: {
      TableName: string;
      BillingMode: string;
      KeySchema: Array<{ AttributeName: string; KeyType: string }>;
      GlobalSecondaryIndexes: Array<{
        IndexName: string;
        KeySchema: Array<{ AttributeName: string; KeyType: string }>;
        Projection: { ProjectionType: string };
      }>;
    };
  }>;
  const table = Object.values(tables)[0];
  expect(table?.DeletionPolicy).toBe('Delete');
  expect(table?.UpdateReplacePolicy).toBe('Delete');
  expect(table?.Properties.TableName).toBe('HarborRidge311Tickets');
  expect(table?.Properties.BillingMode).toBe('PAY_PER_REQUEST');
  expect(table?.Properties.KeySchema).toEqual([{ AttributeName: 'ticketId', KeyType: 'HASH' }]);
  expect(table?.Properties.GlobalSecondaryIndexes).toEqual([{
    IndexName: 'ByCustomer',
    KeySchema: [
      { AttributeName: 'customerId', KeyType: 'HASH' },
      { AttributeName: 'createdAt', KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'ALL' },
  }]);

  template.hasResourceProperties('AWS::ApiGateway::Stage', {
    StageName: 'prod',
    MethodSettings: [{
      ResourcePath: '/*',
      HttpMethod: '*',
      ThrottlingRateLimit: 5,
      ThrottlingBurstLimit: 10,
    }],
  });
  template.resourceCountIs('AWS::ApiGateway::Method', 0);
  const apiBody = Object.values(template.findResources('AWS::ApiGateway::RestApi')).map((resource) => (
    resource as { Properties: { Body?: unknown; Name?: string } }
  ).Properties).find((properties) => properties.Name === 'HarborRidge311Tickets')?.Body;
  expect(contractApi(apiBody)).toEqual(ticketOpenApiDocument());
  expect(ticketOpenApiDocument()).toEqual(JSON.parse(fs.readFileSync(
    path.join(__dirname, '../openapi/tickets.json'),
    'utf8',
  )));
  expect(JSON.stringify(apiBody)).toContain('x-amazon-apigateway-integration');
  expect(JSON.stringify(apiBody)).toContain('awsSigv4');
  expect(JSON.stringify(apiBody)).toContain('customerId');
  expect(JSON.stringify(apiBody)).toContain('subject');

  template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
    Name: 'HarborRidge311Tickets',
    ProtocolType: 'MCP',
    AuthorizerType: 'CUSTOM_JWT',
  });
  template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
    Name: 'Tickets',
    CredentialProviderConfigurations: [{
      CredentialProviderType: 'GATEWAY_IAM_ROLE',
      CredentialProvider: { IamCredentialProvider: { Service: 'execute-api' } },
    }],
  });
  template.hasResourceProperties('AWS::AppIntegrations::Application', {
    Name: 'HarborRidge311Tickets',
    ApplicationType: 'MCP_SERVER',
  });
  template.hasResourceProperties('AWS::Connect::SecurityProfile', {
    SecurityProfileName: 'HarborRidge311-Orchestration',
    Applications: [{
      Type: 'MCP',
      ApplicationPermissions: [
        'Tickets___createTicket',
        'Tickets___getTicket',
        'Tickets___listMyTickets',
        'Tickets___updateTicket',
        'Tickets___closeTicket',
      ],
    }],
  });
  expect(text).toContain('Tickets___createTicket');
  expect(text).toContain('MODEL_CONTEXT_PROTOCOL');
  expect(text).toContain('{{$.contactId}}');
  expect(text).toContain('{{$.instanceId}}');
  expect(text).toContain('{{$.Custom.customerId}}');

  const custom = JSON.stringify(template.findResources('Custom::AWS'));
  expect(custom).toContain('updateGateway');
  expect(custom).toContain('describeInstance');
  expect(custom).toContain('customJWTAuthorizer');
  expect(custom).toContain('.my.connect.aws/.well-known/openid-configuration');

  const dynamoActions = policyStatements(template).flatMap((statement) => {
    const actions = [statement.Action].flat();
    return actions.filter((action) => action.startsWith('dynamodb:'));
  });
  expect([...new Set(dynamoActions)].sort()).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query']);
  const contactAttribute = policyStatements(template).find((statement) => (
    [statement.Action].flat().includes('connect:GetContactAttributes')
  ));
  expect(JSON.stringify(contactAttribute?.Resource)).toContain('/contact/*');
  expect(JSON.stringify(contactAttribute?.Resource)).not.toMatch(/"\*"/);

  const customResources = Object.values(template.findResources('Custom::AWS')) as Array<{
    Properties: { InstallLatestAwsSdk?: boolean };
  }>;
  const discoveryResource = customResources.find((resource) => JSON.stringify(resource).includes('describeInstance'));
  const audienceResource = customResources.find((resource) => JSON.stringify(resource).includes('updateGateway'));
  expect(discoveryResource?.Properties.InstallLatestAwsSdk).toBe(false);
  expect(audienceResource?.Properties.InstallLatestAwsSdk).toBe(true);
  expect(JSON.stringify(audienceResource)).toContain('gatewayConfigHash');

  const ticketActions = policyStatements(template).filter((statement) => {
    const actions = [statement.Action].flat();
    return actions.some((action) => (
      action.startsWith('execute-api:')
      || action.startsWith('bedrock-agentcore:')
      || action === 'connect:GetContactAttributes'
      || action === 'connect:DescribeInstance'
    ));
  });
  expect(ticketActions.length).toBeGreaterThan(0);
  for (const statement of ticketActions) {
    const actions = [statement.Action].flat();
    expect(actions.some((action) => action === '*' || action.endsWith(':*'))).toBe(false);
    expect(JSON.stringify(statement.Resource)).not.toMatch(/"\*"/);
  }
});

test('ConnectStack transfers an in-hours escalation and keeps the agent password out of the template', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new ConnectStack(app, 'ConnectStack'));

  template.hasResourceProperties('AWS::Connect::Queue', {
    Name: 'HarborRidge311-General',
    Status: 'ENABLED',
    HoursOfOperationArn: { 'Fn::GetAtt': ['Hours', 'HoursOfOperationArn'] },
  });
  const queue = JSON.stringify(template.findResources('AWS::Connect::Queue'));
  expect(queue).not.toContain('OutboundCallerConfig');

  const queueArn = { 'Fn::GetAtt': ['GeneralQueue', 'QueueArn'] };
  template.hasResourceProperties('AWS::Connect::RoutingProfile', {
    Name: 'HarborRidge311-Agents',
    DefaultOutboundQueueArn: queueArn,
    MediaConcurrencies: [
      { Channel: 'VOICE', Concurrency: 1 },
      { Channel: 'CHAT', Concurrency: 2 },
    ],
    QueueConfigs: ['VOICE', 'CHAT'].map((channel) => ({
      Delay: 0,
      Priority: 1,
      QueueReference: { Channel: channel, QueueArn: queueArn },
    })),
  });

  const agentPermissions = [
    'BasicAgentAccess',
    'CustomViews.Access',
    'Wisdom.View',
  ];
  template.hasResourceProperties('AWS::Connect::SecurityProfile', {
    SecurityProfileName: 'HarborRidge311-Agent',
    Permissions: agentPermissions,
  });
  const profiles = Object.values(template.findResources('AWS::Connect::SecurityProfile')) as Array<{
    Properties: { Permissions: string[] };
  }>;
  expect(profiles).toHaveLength(2);
  for (const profile of profiles) {
    expect(profile.Properties.Permissions.some((permission) => permission.includes('*'))).toBe(false);
  }

  template.hasResourceProperties('AWS::Connect::User', {
    Username: 'harborridge-agent1',
    IdentityInfo: {
      FirstName: 'Harbor',
      LastName: 'Agent',
      Email: 'harborridge-agent1@example.com',
    },
    PhoneConfig: {
      PhoneType: 'SOFT_PHONE',
      AutoAccept: false,
    },
    RoutingProfileArn: { 'Fn::GetAtt': ['AgentRoutingProfile', 'RoutingProfileArn'] },
    SecurityProfileArns: [{ 'Fn::GetAtt': ['AgentSecurityProfile', 'SecurityProfileArn'] }],
  });
  const user = JSON.stringify(template.findResources('AWS::Connect::User'));
  expect(user).not.toContain('DirectoryUserId');
  expect(user).toContain('{{resolve:secretsmanager:');
  expect(user).toContain(':SecretString:::}}');
  expect(user).not.toMatch(/"Password":"[^{]/);

  const secrets = template.findResources('AWS::SecretsManager::Secret') as Record<string, {
    DeletionPolicy?: string;
    Properties: {
      SecretString?: string;
      GenerateSecretString?: {
        PasswordLength?: number;
        RequireEachIncludedType?: boolean;
        ExcludePunctuation?: boolean;
        IncludeSpace?: boolean;
      };
    };
  }>;
  const secretIds = Object.keys(secrets);
  expect(secretIds).toHaveLength(1);
  const secret = secrets[secretIds[0]!];
  expect(secret?.Properties.SecretString).toBeUndefined();
  expect(secret?.Properties.GenerateSecretString?.PasswordLength).toBe(32);
  expect(secret?.Properties.GenerateSecretString?.RequireEachIncludedType).toBe(true);
  expect(secret?.Properties.GenerateSecretString?.ExcludePunctuation).not.toBe(true);
  expect(secret?.Properties.GenerateSecretString?.IncludeSpace).not.toBe(true);
  expect(secret?.DeletionPolicy).toBe('Delete');
  const templateText = JSON.stringify(template.toJSON());
  expect(templateText).not.toMatch(/"Password"\s*:\s*"(?!\{\{resolve:secretsmanager:)/);
  template.hasOutput('AgentPasswordSecretArn', {
    Value: { Ref: secretIds[0] },
  });

  const mainRaw = JSON.stringify(contactFlow(template, 'HarborRidge311-Main').Properties.Content);
  expect(mainRaw).toContain('DefaultAgentUI');
  expect(mainRaw).toContain('EscalationGuide');
  expect(mainRaw).toContain('GeneralQueue');
  expect(mainRaw).toContain('HoursOfOperationArn');
  expect(mainRaw).not.toContain('play-agent-placeholder');
  const main = mainDocument(contactFlow(template, 'HarborRidge311-Main').Properties.Content);
  expect(main.Actions.find((action) => action.Identifier === 'set-event-flow')?.Transitions?.NextAction)
    .toBe('set-working-queue');
  expect(main.Actions.find((action) => action.Identifier === 'set-working-queue')?.Transitions?.NextAction)
    .toBe('set-customer-queue');
  expect(main.Actions.find((action) => action.Identifier === 'set-customer-queue')?.Type)
    .toBe('UpdateContactEventHooks');
  expect(main.Actions.find((action) => action.Identifier === 'set-customer-queue')?.Transitions?.NextAction)
    .toBe('transfer-to-queue');
  expect(main.Actions.find((action) => action.Identifier === 'set-customer-queue')?.Transitions?.Errors?.[0])
    .toEqual({ ErrorType: 'NoMatchingError', NextAction: 'transfer-to-queue' });
  expect(main.Actions.find((action) => action.Identifier === 'transfer-to-queue')?.Type)
    .toBe('TransferContactToQueue');
  const queueFlow = contactFlow(template, 'HarborRidge311-Queue');
  expect(queueFlow.Properties.Type).toBe('CUSTOMER_QUEUE');
  const queueDocument = flowDocument(queueFlow.Properties.Content);
  expect(queueDocument.StartAction).toBe('branch-channel');
  expect(queueDocument.Actions.some((action) => action.Identifier === 'loop-hold' && action.Type === 'MessageParticipantIteratively'))
    .toBe(true);
  expect(queueDocument.Actions.some((action) => action.Identifier === 'wait-in-queue' && action.Type === 'Wait'))
    .toBe(true);
  const queueRaw = JSON.stringify(queueFlow.Properties.Content);
  const instanceArnParameter = Object.entries(template.toJSON().Parameters as Record<string, { Default?: string }>)
    .find(([, parameter]) => parameter.Default === '/connect/sandbox/instance-arn')?.[0];
  expect(instanceArnParameter).toBeDefined();
  expect(queueRaw).toContain(CUSTOMER_QUEUE_PROMPT_ID);
  expect(queueRaw).toContain('/prompt/');
  expect(queueRaw).toContain(`"Ref":"${instanceArnParameter}"`);
  expect(queueRaw).toContain('Fn::Join');
  expect(queueRaw).not.toContain('Fn::Sub');
  expect(queueRaw).not.toContain('TimeoutSeconds');
  expect(queueRaw).toContain('TimeLimitSeconds');
  expect(queueRaw).not.toContain('<break');
  expect(mainRaw).toContain('CustomerQueue');
  expect(mainRaw).toContain('QueueFlow');

  const guideRaw = JSON.stringify(contactFlow(template, 'HarborRidge311-EscalationGuide').Properties.Content);
  expect(guideRaw).toContain('ShowView');
  expect(guideRaw).toContain('view/detail:1');
  expect(guideRaw).not.toContain('TemplateString');
  for (const attribute of ['escalationReason', 'escalationSummary', 'customerIntent', 'sentiment']) {
    expect(guideRaw.split(`$.Attributes.${attribute}`).length - 1).toBe(1);
  }
  const assistants = JSON.stringify(template.findResources('Custom::AWS'));
  expect(assistants).toContain('ORCHESTRATION');
  expect(assistants).not.toContain('ANSWER_RECOMMENDATION');
  expect(assistants).not.toContain('MANUAL_SEARCH');
});

test('ConnectStack hours can be overridden', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new ConnectStack(app, 'ConnectStack', {
    hours: {
      timeZone: 'America/New_York',
      config: [{
        day: 'SATURDAY',
        startTime: { hours: 9, minutes: 30 },
        endTime: { hours: 13, minutes: 0 },
      }],
    },
  }));
  template.hasResourceProperties('AWS::Connect::HoursOfOperation', {
    TimeZone: 'America/New_York',
    Config: [{
      Day: 'SATURDAY',
      StartTime: { Hours: 9, Minutes: 30 },
      EndTime: { Hours: 13, Minutes: 0 },
    }],
  });
});
