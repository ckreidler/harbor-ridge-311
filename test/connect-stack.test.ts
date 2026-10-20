import * as fs from 'node:fs';
import * as path from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { ConnectStack, VOICEMAIL_RECORDING_KEY_PATTERN } from '../lib/connect-stack';

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

  template.resourceCountIs('AWS::Connect::ContactFlow', 2);
  template.resourceCountIs('AWS::Connect::DataTable', 1);
  template.resourceCountIs('AWS::Connect::DataTableAttribute', 3);
  template.resourceCountIs('AWS::Connect::DataTableRecord', 1);

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
  expect(records).not.toContain('es-US');
  expect(records).not.toContain('Gracias');
  expect(records).not.toContain('Question');

  const flow = contactFlow(template, 'HarborRidge311-Main');
  expect(flow.Properties.Type).toBe('CONTACT_FLOW');

  const content = flowDocument(flow.Properties.Content);
  expect(content.Actions.some((action) => action.Type === 'GetParticipantInput')).toBe(false);
  expect(content.Actions.some((action) => action.Identifier === 'set-es-language')).toBe(false);
  expect(content.Actions.some((action) => action.Identifier === 'set-es-voice')).toBe(false);
  expect(JSON.stringify(content)).not.toContain('español');
  expect(JSON.stringify(content)).not.toContain('$.Attributes.language');

  expect(JSON.stringify(flow.Properties.Content)).toContain('Prompts');
  const lookup = content.Actions.find((action) => action.Type === 'EvaluateDataTableValues');
  expect(lookup?.Parameters?.Queries?.[0].QueryName).toBe('Prompts');
  expect(lookup?.Parameters?.Queries?.[0].Attributes).toEqual(['Greeting', 'Goodbye']);
  expect(lookup?.Parameters?.Queries?.[0].PrimaryValues).toEqual([
    { AttributeName: 'Language', Value: '$.LanguageCode' },
  ]);
  expect(lookup?.Transitions?.Errors?.[0].NextAction).toBe('play-fallback');

  const greeting = content.Actions.find((action) => action.Identifier === 'play-greeting');
  const goodbye = content.Actions.find((action) => action.Identifier === 'play-goodbye');
  expect(greeting?.Parameters?.Text).toBe('$.DataTables.Prompts.Greeting');
  expect(goodbye?.Parameters?.Text).toBe('$.DataTables.Prompts.Goodbye');
  expect(content.Actions.find((action) => action.Identifier === 'set-en-voice')?.Parameters?.TextToSpeechVoice)
    .toBe('Joanna');
  expect(content.Actions.find((action) => action.Identifier === 'enable-flow-logging')?.Transitions?.NextAction)
    .toBe('set-en-language');
  expect(content.Actions.map((action) => action.Identifier).every((id) => content.Metadata.ActionMetadata[id]?.position))
    .toBe(true);
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
  template.resourceCountIs('AWS::Connect::SecurityProfile', 1);
  template.resourceCountIs('AWS::Lex::Bot', 1);
  template.resourceCountIs('AWS::Lex::BotVersion', 1);
  template.resourceCountIs('AWS::Lex::BotAlias', 1);
  template.resourceCountIs('AWS::Connect::IntegrationAssociation', 3);
  template.resourceCountIs('Custom::AWS', 7);

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
  expect(integrationTypes.sort()).toEqual(['LAMBDA_FUNCTION', 'LEX_BOT', 'WISDOM_KNOWLEDGE_BASE']);
  const lambdaIntegrations = Object.values(integrations).filter((resource) => (
    resource as { Properties: { IntegrationType: string } }
  ).Properties.IntegrationType === 'LAMBDA_FUNCTION');
  expect(lambdaIntegrations).toHaveLength(1);

  const parameters = template.toJSON().Parameters as Record<string, { Default?: string }>;
  const instanceArnParameter = Object.entries(parameters).find(([, parameter]) => (
    parameter.Default === '/connect/sandbox/instance-arn'
  ))?.[0];
  const connectPermissions = Object.values(template.findResources('AWS::Lambda::Permission') as Record<string, {
    Properties: { Action?: string; Principal?: string; SourceArn?: { Ref?: string } };
  }>).filter((permission) => permission.Properties.Principal === 'connect.amazonaws.com');
  expect(connectPermissions).toHaveLength(1);
  expect(connectPermissions[0]?.Properties.Action).toBe('lambda:InvokeFunction');
  expect(connectPermissions[0]?.Properties.SourceArn).toEqual({ Ref: instanceArnParameter });

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
  const voicemailBundle = bundledHandler(template, 'HarborRidge311-VoicemailIndexer', app.assetOutdir);
  expect(voicemailBundle).not.toContain('UpdateSessionRequest$');
  expect(voicemailBundle).not.toContain('@aws-sdk/client-qconnect');

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
  const content = flowDocument(flow.Properties.Content);
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
  expect(lexBots.map((action) => action.Parameters?.Text)).toEqual([
    'What can I help you with? You can ask about trash pickup, potholes, parking permits, or office hours. Say agent if you would rather talk to a person.',
  ]);
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
    .toBe('create-assistant-session');
  expect(content.Actions.map((action) => action.Identifier).every((id) => content.Metadata.ActionMetadata[id]?.position))
    .toBe(true);

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

test('ConnectStack records an after-hours voicemail when the office is closed', () => {
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

  const main = flowDocument(contactFlow(template, 'HarborRidge311-Main').Properties.Content);
  const logging = main.Actions.find((action) => action.Identifier === 'enable-flow-logging');
  const hoursCheck = main.Actions.find((action) => action.Identifier === 'check-hours');
  expect(main.StartAction).toBe('enable-flow-logging');
  expect(logging?.Transitions?.NextAction).toBe('set-en-language');
  const beforeLanguage: string[] = [];
  let cursor: string | undefined = main.StartAction;
  while (cursor && cursor !== 'set-en-language') {
    beforeLanguage.push(cursor);
    cursor = main.Actions.find((action) => action.Identifier === cursor)?.Transitions?.NextAction;
  }
  expect(beforeLanguage).toEqual(['enable-flow-logging']);
  expect(hoursCheck?.Type).toBe('CheckHoursOfOperation');
  expect(hoursCheck?.Transitions?.Conditions?.find((branch) => branch.Condition.Operands[0] === 'True')?.NextAction)
    .toBe('play-agent-placeholder');
  expect(hoursCheck?.Transitions?.Conditions?.find((branch) => branch.Condition.Operands[0] === 'False')?.NextAction)
    .toBe('transfer-after-hours');
  expect(hoursCheck?.Transitions?.Errors?.[0]).toEqual({
    ErrorType: 'NoMatchingError',
    NextAction: 'transfer-after-hours',
  });
  const placeholder = main.Actions.find((action) => action.Identifier === 'play-agent-placeholder');
  expect(placeholder?.Type).toBe('MessageParticipant');
  expect(placeholder?.Parameters?.Text).toBe('This is where we would escalate to an agent.');
  expect(placeholder?.Transitions?.NextAction).toBe('disconnect');
  expect(main.Actions.find((action) => action.Identifier === 'transfer-after-hours')?.Type).toBe('TransferToFlow');
  expect(main.Actions.find((action) => action.Identifier === 'set-en-language')?.Transitions?.NextAction)
    .toBe('set-en-voice');
  expect(main.Actions.some((action) => action.Identifier === 'select-language')).toBe(false);

  const afterHours = contactFlow(template, 'HarborRidge311-AfterHours');
  expect(afterHours.Properties.Type).toBe('CONTACT_FLOW');
  const closed = flowDocument(afterHours.Properties.Content);
  expect(closed.Actions.map((action) => action.Identifier).every((id) => closed.Metadata.ActionMetadata[id]?.position))
    .toBe(true);
  const recording = closed.Actions.find((action) => action.Identifier === 'start-recording');
  expect(recording?.Type).toBe('UpdateContactRecordingBehavior');
  expect(JSON.stringify(recording?.Parameters)).toContain('"IVRRecordingBehavior":"Enabled"');
  expect(JSON.stringify(recording?.Parameters)).toContain('"RecordedParticipants":[]');
  expect(closed.Actions.find((action) => action.Identifier === 'set-voicemail')?.Type).toBe('UpdateContactAttributes');
  expect(JSON.stringify(closed)).toContain('"Voicemail":"true"');
  expect(closed.Actions.find((action) => action.Identifier === 'play-closed')?.Parameters?.Text)
    .toBe('Thank you for calling Harbor Ridge 3 1 1. Our office is closed. Please leave a message after the tone, and hang up when you are finished.');
  expect(closed.Actions.find((action) => action.Identifier === 'leave-message')?.Parameters?.InputTimeLimitSeconds)
    .toBe('60');
  expect(closed.Actions.find((action) => action.Identifier === 'leave-message')?.Transitions?.NextAction)
    .toBe('disconnect');

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'HarborRidge311-Voicemails',
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'contactId', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'contactId', AttributeType: 'S' }],
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
  });
  template.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Delete',
    UpdateReplacePolicy: 'Delete',
  });

  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: {
      source: ['aws.s3'],
      'detail-type': ['Object Created'],
      detail: {
        object: {
          key: [{ wildcard: VOICEMAIL_RECORDING_KEY_PATTERN }],
        },
      },
    },
  });
  const rule = JSON.stringify(template.findResources('AWS::Events::Rule'));
  expect(rule).toContain('Object Created');
  expect(rule).toContain(VOICEMAIL_RECORDING_KEY_PATTERN);
  expect(rule).not.toContain('DISCONNECTED');
  expect(rule).not.toContain('aws.connect');
  const parameters = template.toJSON().Parameters as Record<string, { Default?: string }>;
  const storageBucketParameter = Object.entries(parameters).find(([, parameter]) => (
    parameter.Default === '/connect/sandbox/storage-bucket'
  ));
  expect(storageBucketParameter).toBeDefined();
  expect(rule).toContain(`"Ref":"${storageBucketParameter?.[0]}"`);
  const parameterDefaults = Object.values(parameters).map((parameter) => parameter.Default);
  expect(parameterDefaults).toContain('/connect/sandbox/instance-arn');
  expect(parameterDefaults).toContain('/connect/sandbox/storage-bucket');

  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'HarborRidge311-VoicemailIndexer',
    Timeout: 30,
  });
  template.hasResourceProperties('AWS::SQS::Queue', {
    QueueName: 'HarborRidge311-VoicemailIndexerFailures',
    MessageRetentionPeriod: 1_209_600,
    SqsManagedSseEnabled: true,
  });
  const queuePolicy = JSON.stringify(template.findResources('AWS::SQS::QueuePolicy'));
  expect(queuePolicy).not.toContain('"Principal":"*"');
  expect(queuePolicy).not.toContain('"AWS":"*"');
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    DestinationConfig: {
      OnFailure: {
        Destination: Match.anyValue(),
      },
    },
  });
  const invokeConfig = Object.values(template.findResources('AWS::Lambda::EventInvokeConfig')) as Array<{
    Properties: { MaximumRetryAttempts?: number; DestinationConfig: { OnSuccess?: unknown } };
  }>;
  expect(invokeConfig).toHaveLength(1);
  expect(invokeConfig[0]?.Properties.MaximumRetryAttempts ?? 2).toBe(2);
  expect(invokeConfig[0]?.Properties.DestinationConfig.OnSuccess).toBeUndefined();

  const indexerPolicies = Object.values(template.findResources('AWS::IAM::Policy') as Record<string, {
    Properties: { PolicyDocument: { Statement: PolicyStatement[] } };
  }>).filter((policy) => JSON.stringify(policy).includes('connect:DescribeContact'));
  expect(indexerPolicies).toHaveLength(1);
  const indexer = indexerPolicies[0]!.Properties.PolicyDocument.Statement;
  const indexerActions = indexer.flatMap((statement) => (
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  ));
  expect(indexerActions).toEqual(expect.arrayContaining([
    's3:GetObject',
    'dynamodb:PutItem',
    'connect:DescribeContact',
    'connect:GetContactAttributes',
  ]));
  expect(indexerActions).not.toContain('s3:ListBucket');
  expect(indexerActions).not.toContain('*');
  for (const statement of indexer) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    expect(actions.every((action) => !action.includes('*'))).toBe(true);
    expect(resourceValues(statement.Resource).some((resource) => resource === '*')).toBe(false);
  }
  const indexerJson = JSON.stringify(indexer);
  expect(indexerJson).toContain('call-recordings/*');
  expect(indexerJson).toContain('/contact/*');
  expect(indexerJson).not.toContain('s3:prefix');
  expect(indexerJson).not.toContain('s3:ListBucket');
});

test('ConnectStack adds an active Harbor Ridge 311 case template', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new ConnectStack(app, 'ConnectStack'));

  template.resourceCountIs('AWS::Cases::Domain', 0);
  template.resourceCountIs('AWS::Cases::Field', 2);
  template.resourceCountIs('AWS::Cases::Layout', 1);
  template.resourceCountIs('AWS::Cases::Template', 1);

  template.hasResourceProperties('AWS::Cases::Field', {
    Name: 'Request category',
    Type: 'SingleSelect',
  });
  template.hasResourceProperties('AWS::Cases::Field', {
    Name: 'Service address',
    Type: 'Text',
    Attributes: { Text: { IsMultiline: false } },
  });
  const fieldNames = Object.values(template.findResources('AWS::Cases::Field')).map((resource) => (
    resource as { Properties: { Name: string } }
  ).Properties.Name);
  expect(fieldNames.sort()).toEqual(['Request category', 'Service address']);

  const parameters = template.toJSON().Parameters as Record<string, { Default?: string }>;
  const casesDomainParameter = Object.entries(parameters).find(([, parameter]) => (
    parameter.Default === '/connect/sandbox/cases-domain-id'
  ));
  expect(casesDomainParameter).toBeDefined();
  const casesResources = {
    ...template.findResources('AWS::Cases::Field'),
    ...template.findResources('AWS::Cases::Layout'),
    ...template.findResources('AWS::Cases::Template'),
  };
  for (const resource of Object.values(casesResources) as Array<{
    DeletionPolicy?: string;
    UpdateReplacePolicy?: string;
    Properties: { DomainId?: unknown };
  }>) {
    expect(resource.DeletionPolicy).toBe('Delete');
    expect(resource.UpdateReplacePolicy).toBe('Delete');
    expect(resource.Properties.DomainId).toEqual({ Ref: casesDomainParameter?.[0] });
  }

  const categoryId = Object.entries(template.findResources('AWS::Cases::Field')).find(([, resource]) => (
    (resource as { Properties: { Name: string } }).Properties.Name === 'Request category'
  ))?.[0];
  const addressId = Object.entries(template.findResources('AWS::Cases::Field')).find(([, resource]) => (
    (resource as { Properties: { Name: string } }).Properties.Name === 'Service address'
  ))?.[0];
  template.hasResourceProperties('AWS::Cases::Layout', {
    Name: 'Harbor Ridge 311 Service Request',
    Content: {
      Basic: {
        TopPanel: {
          Sections: [{
            FieldGroup: {
              Fields: [
                { Id: { 'Fn::GetAtt': [categoryId, 'FieldId'] } },
                { Id: { 'Fn::GetAtt': [addressId, 'FieldId'] } },
                { Id: 'summary' },
                { Id: 'customer_id' },
              ],
            },
          }],
        },
      },
    },
  });
  const layout = JSON.stringify(template.findResources('AWS::Cases::Layout'));
  expect(layout).not.toContain('"title"');
  expect(layout).not.toContain('"status"');

  const layoutId = Object.keys(template.findResources('AWS::Cases::Layout'))[0];
  template.hasResourceProperties('AWS::Cases::Template', {
    Name: 'Harbor Ridge 311 Service Request',
    Status: 'Active',
    LayoutConfiguration: { DefaultLayout: { 'Fn::GetAtt': [layoutId, 'LayoutId'] } },
    RequiredFields: [
      { FieldId: 'title' },
      { FieldId: { 'Fn::GetAtt': [categoryId, 'FieldId'] } },
    ],
  });

  const options = JSON.stringify(template.findResources('Custom::AWS'));
  expect(options).toContain('BatchPutFieldOptions');
  expect(options).toContain('Trash pickup');
  expect(options).toContain('trash-pickup');
  expect(options).toContain('Pothole');
  expect(options).toContain('pothole');
  expect(options).toContain('Parking permit');
  expect(options).toContain('parking-permit');
  expect(options).toContain('Other');
  expect(options).toContain('\\"active\\":false');
  const optionPolicies = policyStatements(template).filter((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return actions.some((action) => action.startsWith('cases:'));
  });
  expect(optionPolicies).toHaveLength(1);
  expect([optionPolicies[0]?.Action].flat()).toEqual(['cases:BatchPutFieldOptions']);
  expect(optionPolicies[0]?.Resource).toEqual([
    {
      'Fn::Join': [
        '',
        [
          'arn:',
          { Ref: 'AWS::Partition' },
          ':cases:',
          { Ref: 'AWS::Region' },
          ':',
          { Ref: 'AWS::AccountId' },
          ':domain/',
          { Ref: casesDomainParameter?.[0] },
        ],
      ],
    },
    { 'Fn::GetAtt': [categoryId, 'FieldArn'] },
  ]);
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
