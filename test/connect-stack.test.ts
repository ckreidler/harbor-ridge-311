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
    WisdomAssistantArn?: string;
    ComparisonValue?: string;
    LexV2Bot?: { AliasArn?: string };
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
  expect(records).not.toContain('Question');

  const flows = template.findResources('AWS::Connect::ContactFlow');
  const flow = Object.values(flows)[0] as {
    DependsOn?: string | string[];
    Properties: { Type: string; Content: unknown; Name: string };
  };
  expect(flow.Properties.Type).toBe('CONTACT_FLOW');
  expect(flow.Properties.Name).toBe('HarborRidge311-Main');

  const content = flowDocument(flow.Properties.Content);
  const menu = content.Actions.find((action) => action.Type === 'GetParticipantInput');
  const digits = menu?.Transitions?.Conditions?.map((branch) => branch.Condition.Operands[0]);
  expect(menu?.Parameters?.Text).toBe('For English, press 1. Para español, oprima 2.');
  expect(menu?.Parameters?.InputTimeLimitSeconds).toBe('5');
  expect(digits).toEqual(['1', '2']);
  expect(menu?.Transitions?.Conditions?.find((branch) => branch.Condition.Operands[0] === '1')?.NextAction)
    .toBe('set-en-language');
  expect(menu?.Transitions?.Conditions?.find((branch) => branch.Condition.Operands[0] === '2')?.NextAction)
    .toBe('set-es-language');
  expect(menu?.Transitions?.Errors?.map((error) => error.NextAction)).toEqual([
    'set-en-language',
    'set-en-language',
    'set-en-language',
  ]);
  expect(content.Actions.some((action) => action.Type === 'UpdateContactAttributes')).toBe(false);
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
  expect(content.Actions.find((action) => action.Identifier === 'set-es-voice')?.Parameters?.TextToSpeechVoice)
    .toBe('Lupe');
  expect(content.Actions.map((action) => action.Identifier).every((id) => content.Metadata.ActionMetadata[id]?.position))
    .toBe(true);
  const recordIds = Object.keys(template.findResources('AWS::Connect::DataTableRecord'));
  const dependsOn = [flow.DependsOn].flat();
  expect(dependsOn).toEqual(expect.arrayContaining(recordIds));

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

test('ConnectStack answers city questions from Q in Connect and falls back to goodbye', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new ConnectStack(app, 'ConnectStack'));

  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.resourceCountIs('AWS::KMS::Key', 1);
  template.resourceCountIs('AWS::AppIntegrations::DataIntegration', 1);
  template.resourceCountIs('AWS::Wisdom::Assistant', 0);
  template.resourceCountIs('AWS::Wisdom::KnowledgeBase', 1);
  template.resourceCountIs('AWS::Wisdom::AssistantAssociation', 1);
  template.resourceCountIs('AWS::Wisdom::AIGuardrail', 1);
  template.resourceCountIs('AWS::Wisdom::AIGuardrailVersion', 1);
  template.resourceCountIs('AWS::Wisdom::AIAgent', 1);
  template.resourceCountIs('AWS::Wisdom::AIAgentVersion', 1);
  template.resourceCountIs('AWS::Wisdom::AIPrompt', 0);
  template.resourceCountIs('AWS::Lex::Bot', 1);
  template.resourceCountIs('AWS::Lex::BotVersion', 1);
  template.resourceCountIs('AWS::Lex::BotAlias', 1);
  template.resourceCountIs('AWS::Connect::IntegrationAssociation', 2);
  template.resourceCountIs('Custom::AWS', 2);

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
    Name: 'HarborRidge311-SelfService',
    Type: 'SELF_SERVICE',
  });
  const agent = JSON.stringify(template.findResources('AWS::Wisdom::AIAgent'));
  expect(agent).toContain('SelfServiceAIGuardrailId');
  expect(agent).toContain('AIGuardrailVersionId');
  expect(agent).not.toContain('AIPrompt');
  expect(JSON.stringify(template.findResources('Custom::AWS'))).toContain('AIAgentVersionId');
  expect(joinReferencesVersionNumber(template.toJSON())).toBe(false);
  expect(JSON.stringify(template.findResources('AWS::Wisdom::AIGuardrailVersion'))).toContain('ModifiedTimeSeconds');
  expect(JSON.stringify(template.findResources('AWS::Wisdom::AIAgentVersion'))).toContain('ModifiedTimeSeconds');

  const guardrail = JSON.stringify(template.findResources('AWS::Wisdom::AIGuardrail'));
  expect(guardrail).not.toContain('TopicPolicyConfig');
  expect(guardrail).not.toContain('Off topic');
  expect(guardrail).toContain('I can only help with Harbor Ridge city services');
  expect(guardrail).toContain('I cannot share that');
  for (const pii of ['ADDRESS', 'EMAIL', 'PHONE', 'NAME', 'US_SOCIAL_SECURITY_NUMBER', 'CREDIT_DEBIT_CARD_NUMBER']) {
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
  expect(integrationTypes.sort()).toEqual(['LEX_BOT', 'WISDOM_KNOWLEDGE_BASE']);

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
      { LocaleId: 'es_US', BotAliasLocaleSetting: { Enabled: true } },
    ],
  });
  template.hasResourceProperties('AWS::Lex::Bot', {
    TestBotAliasSettings: {
      BotAliasLocaleSettings: [
        { LocaleId: 'en_US', BotAliasLocaleSetting: { Enabled: true } },
        { LocaleId: 'es_US', BotAliasLocaleSetting: { Enabled: true } },
      ],
    },
  });

  const bot = JSON.stringify(template.findResources('AWS::Lex::Bot'));
  expect(bot).toContain('AMAZON.QInConnectIntent');
  expect(bot).not.toContain('AMAZON.QinConnectIntent');
  expect(bot).toContain('AMAZON.FallbackIntent');
  expect(bot).toContain('en_US');
  expect(bot).toContain('es_US');
  expect(bot).not.toContain('AMAZON.QnAIntent');

  const customResources = JSON.stringify(template.findResources('Custom::AWS'));
  expect(customResources).toContain('UpdateAssistantAIAgent');
  expect(customResources).toContain('RemoveAssistantAIAgent');
  expect(customResources).toContain('SELF_SERVICE');
  expect(customResources).toContain('QConnect');
  expect(customResources).toContain('assistantId');
  expect(customResources).toContain('aiAgentId');
  const setDefault = Object.values(template.findResources('Custom::AWS')).find((resource) =>
    JSON.stringify(resource).includes('UpdateAssistantAIAgent')) as { DependsOn?: string | string[] };
  expect([setDefault.DependsOn].flat()).toEqual(expect.arrayContaining(['MainFlow', 'CityQuestionsBotAlias']));

  const flows = template.findResources('AWS::Connect::ContactFlow');
  const flow = Object.values(flows)[0] as { Properties: { Content: unknown } };
  const content = flowDocument(flow.Properties.Content);
  const session = content.Actions.find((action) => action.Type === 'CreateWisdomSession');
  const lexBots = content.Actions.filter((action) => action.Type === 'ConnectParticipantWithLexBot');
  const toolCheck = content.Actions.find((action) => action.Identifier === 'check-tool');
  const questionLanguage = content.Actions.find((action) => action.Identifier === 'check-question-language');
  expect(session?.Parameters?.WisdomAssistantArn).toBe('token');
  expect(session?.Transitions?.NextAction).toBe('check-question-language');
  expect(session?.Transitions?.Errors?.[0].NextAction).toBe('play-goodbye');
  expect(questionLanguage?.Parameters?.ComparisonValue).toBe('$.LanguageCode');
  expect(questionLanguage?.Transitions?.Conditions?.find((branch) => branch.Condition.Operands[0] === 'es-US')?.NextAction)
    .toBe('ask-es-question');
  expect(lexBots.map((action) => action.Parameters?.Text)).toEqual(expect.arrayContaining([
    'What can I help you with? You can ask about trash pickup, potholes, parking permits, or office hours. Say agent if you would rather talk to a person.',
    '¿En qué puedo ayudarle? Puede preguntar sobre la recolección de basura, los baches, los permisos de estacionamiento o el horario. Diga agente si prefiere hablar con una persona.',
  ]));
  expect(lexBots.every((action) => action.Parameters?.LexV2Bot?.AliasArn === 'token')).toBe(true);
  expect(lexBots.every((action) => action.Transitions?.NextAction === 'check-tool')).toBe(true);
  expect(lexBots[0]?.Transitions?.Errors?.map((error) => error.NextAction)).toEqual([
    'play-goodbye',
    'play-goodbye',
    'play-goodbye',
  ]);
  expect(toolCheck?.Parameters?.ComparisonValue).toBe('$.Lex.SessionAttributes.Tool');
  expect(toolCheck?.Transitions?.Conditions?.[0].Condition.Operands).toEqual(['COMPLETE']);
  expect(toolCheck?.Transitions?.Conditions?.[0].NextAction).toBe('play-goodbye');
  expect(toolCheck?.Transitions?.Errors?.[0]).toEqual({
    ErrorType: 'NoMatchingCondition',
    NextAction: 'play-goodbye',
  });
  expect(content.Actions.find((action) => action.Identifier === 'play-greeting')?.Transitions?.NextAction)
    .toBe('create-assistant-session');
  expect(content.Actions.map((action) => action.Identifier).every((id) => content.Metadata.ActionMetadata[id]?.position))
    .toBe(true);

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
