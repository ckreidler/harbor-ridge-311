import * as path from 'node:path';
import * as appintegrations from 'aws-cdk-lib/aws-appintegrations';
import * as cases from 'aws-cdk-lib/aws-cases';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lex from 'aws-cdk-lib/aws-lex';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wisdom from 'aws-cdk-lib/aws-wisdom';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { afterHoursFlow } from './flows/after-hours-flow';
import { mainFlow } from './flows/main-flow';
import { ORCHESTRATION_MODEL_ID, orchestrationPrompt } from './orchestration-prompt';
import { SELF_SERVICE_USE_CASE } from './select-orchestrator';

export const SANDBOX_PARAMETER_PREFIX = '/connect/sandbox';
export const MAIN_CONTACT_FLOW_ID_PARAMETER = `${SANDBOX_PARAMETER_PREFIX}/harbor-ridge-311/main-contact-flow-id`;
export const MAIN_CONTACT_FLOW_ARN_PARAMETER = `${SANDBOX_PARAMETER_PREFIX}/harbor-ridge-311/main-contact-flow-arn`;
export const RECORDINGS_PREFIX = 'call-recordings/';
export const VOICEMAIL_RECORDING_KEY_PATTERN = `${RECORDINGS_PREFIX}*ivr/*.wav`;

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const;

export interface ConnectHoursProps {
  readonly timeZone: string;
  readonly config: ReadonlyArray<{
    readonly day: typeof WEEKDAYS[number] | 'SATURDAY' | 'SUNDAY';
    readonly startTime: { readonly hours: number; readonly minutes: number };
    readonly endTime: { readonly hours: number; readonly minutes: number };
  }>;
}

const DEFAULT_HOURS: ConnectHoursProps = {
  timeZone: 'America/Los_Angeles',
  config: WEEKDAYS.map((day) => ({
    day,
    startTime: { hours: 8, minutes: 0 },
    endTime: { hours: 17, minutes: 0 },
  })),
};

export interface ConnectStackProps extends cdk.StackProps {
  readonly hours?: ConnectHoursProps;
}
const FAQ_SOURCE_NAME = 'HarborRidge311-Faqs';

const BLOCKED_INPUT_MESSAGE = 'I can only help with Harbor Ridge city services, and I cannot take personal information. Please ask about trash pickup, potholes, parking permits, or office hours.';
const BLOCKED_OUTPUT_MESSAGE = 'I cannot share that. Please ask about Harbor Ridge city services without personal details.';

const BLOCKED_PII = [
  'EMAIL',
  'PHONE',
  'NAME',
  'PASSWORD',
  'US_SOCIAL_SECURITY_NUMBER',
  'CREDIT_DEBIT_CARD_NUMBER',
  'US_BANK_ACCOUNT_NUMBER',
];

function enabledLocale(localeId: string) {
  return { localeId, botAliasLocaleSetting: { enabled: true } };
}

function templateOverride(
  jsonPath: string,
  value: string,
  type: 'STRING' | 'JSON_STRING' = 'STRING',
): wisdom.CfnAIAgent.ToolOverrideInputValueProperty {
  return {
    jsonPath,
    value: { constant: { type, value } },
  };
}

function orchestrationTools(): wisdom.CfnAIAgent.ToolConfigurationProperty[] {
  return [
    {
      toolName: 'Complete',
      toolType: 'RETURN_TO_CONTROL',
      description: 'End the conversation after the city question is answered.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why the conversation is complete',
          },
        },
        required: ['reason'],
      },
      instruction: {
        instruction: 'Call Complete when the person has the city information they asked for and does not want anything else.',
      },
    },
    {
      toolName: 'Escalate',
      toolType: 'RETURN_TO_CONTROL',
      description: 'Hand the Harbor Ridge 311 conversation to a person.',
      inputSchema: {
        type: 'object',
        properties: {
          customerIntent: {
            type: 'string',
            description: 'A brief phrase describing what the customer wants to accomplish',
          },
          sentiment: {
            type: 'string',
            description: 'Customer emotional state during the conversation',
            enum: ['positive', 'neutral', 'frustrated'],
          },
          escalationSummary: {
            type: 'string',
            description: 'Summary for the person who picks up, including what was asked, what was tried, and why escalation is needed, under 500 characters',
          },
          escalationReason: {
            type: 'string',
            description: 'Category for the escalation reason',
            enum: [
              'complex_request',
              'technical_issue',
              'customer_frustration',
              'policy_exception',
              'out_of_scope',
              'other',
            ],
          },
        },
        required: [
          'escalationReason',
          'escalationSummary',
          'customerIntent',
          'sentiment',
        ],
      },
      instruction: {
        instruction: 'Escalate to a person when the caller asks for a person, agent, representative, or transfer. Also escalate for a policy exception, an inspection, or another request a city employee has to handle, when the question is outside Harbor Ridge city services, when the FAQ does not contain an answer, when the caller is frustrated, or when the request needs payment, an account change, or personal information.',
        examples: [
          'I can connect you with a person. I will share what we talked about so you do not have to start over.',
        ],
      },
    },
    {
      toolName: 'Retrieve',
      toolType: 'MODEL_CONTEXT_PROTOCOL',
      toolId: 'aws_service__qconnect_Retrieve',
      description: 'Search the Harbor Ridge 311 FAQ knowledge base.',
      instruction: {
        instruction: 'Call Retrieve before answering a question about Harbor Ridge city services. Answer only from the retrieved FAQ text.',
      },
      overrideInputValues: [
        templateOverride('$.assistantId', '{{$.assistantId}}'),
        templateOverride(
          '$.retrievalConfiguration.knowledgeSource.assistantAssociationIds',
          '{{$.knowledgeBaseAssistantAssociationIds}}',
          'JSON_STRING',
        ),
      ],
    },
  ];
}

function cityQuestionLocale(localeId: string, voiceId: string, assistantArn: string): lex.CfnBot.BotLocaleProperty {
  return {
    localeId,
    nluConfidenceThreshold: 0.4,
    voiceSettings: { voiceId, engine: 'neural' },
    intents: [
      {
        name: 'FallbackIntent',
        parentIntentSignature: 'AMAZON.FallbackIntent',
      },
      {
        name: 'CityQuestion',
        parentIntentSignature: 'AMAZON.QInConnectIntent',
        qInConnectIntentConfiguration: {
          qInConnectAssistantConfiguration: { assistantArn },
        },
      },
    ],
  };
}

export class ConnectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConnectStackProps = {}) {
    super(scope, id, props);
    const hours = props.hours ?? DEFAULT_HOURS;

    const instanceArn = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/instance-arn`,
    );
    const instanceId = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/instance-id`,
    );
    const phoneNumberArn = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/phone-number-arn`,
    );
    const phoneNumber = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/phone-number`,
    );
    const assistantArn = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/assistant-arn`,
    );
    const assistantId = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/assistant-id`,
    );
    const storageBucketName = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/storage-bucket`,
    );
    const casesDomainId = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/cases-domain-id`,
    );
    const storageBucket = s3.Bucket.fromBucketName(this, 'StorageBucket', storageBucketName);

    const prompts = new connect.CfnDataTable(this, 'Prompts', {
      instanceArn,
      name: 'HarborRidge311-Prompts',
      status: 'PUBLISHED',
      timeZone: 'America/New_York',
      valueLockLevel: 'NONE',
    });

    const languageAttribute = new connect.CfnDataTableAttribute(this, 'LanguageAttribute', {
      instanceArn,
      dataTableArn: prompts.attrArn,
      name: 'Language',
      primary: true,
      valueType: 'TEXT',
    });
    const greetingAttribute = new connect.CfnDataTableAttribute(this, 'GreetingAttribute', {
      instanceArn,
      dataTableArn: prompts.attrArn,
      name: 'Greeting',
      valueType: 'TEXT',
    });
    const goodbyeAttribute = new connect.CfnDataTableAttribute(this, 'GoodbyeAttribute', {
      instanceArn,
      dataTableArn: prompts.attrArn,
      name: 'Goodbye',
      valueType: 'TEXT',
    });
    const promptRows = [
      {
        id: 'EnglishPrompt',
        language: 'en-US',
        greeting: 'Thank you for calling Harbor Ridge 3 1 1. This line is a demo.',
        goodbye: 'Thank you for calling Harbor Ridge 3 1 1. Goodbye.',
      },
    ].map((row) => new connect.CfnDataTableRecord(this, row.id, {
      instanceArn,
      dataTableArn: prompts.attrArn,
      dataTableRecord: {
        primaryValues: [{
          attributeId: languageAttribute.attrAttributeId,
          attributeValue: row.language,
        }],
        values: [
          { attributeId: greetingAttribute.attrAttributeId, attributeValue: row.greeting },
          { attributeId: goodbyeAttribute.attrAttributeId, attributeValue: row.goodbye },
        ],
      },
    }));

    const faqKey = new kms.Key(this, 'FaqKey', {
      description: 'Encrypts the Harbor Ridge 311 FAQ data integration',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    const faqBucket = new s3.Bucket(this, 'FaqBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
    });
    const appIntegrationsCondition = {
      StringEquals: { 'aws:SourceAccount': this.account },
      ArnLike: {
        'aws:SourceArn': this.formatArn({
          service: 'app-integrations',
          resource: 'data-integration',
          resourceName: '*',
        }),
      },
    };
    faqBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAppIntegrationsList',
      principals: [new iam.ServicePrincipal('app-integrations.amazonaws.com')],
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: [faqBucket.bucketArn],
      conditions: appIntegrationsCondition,
    }));
    faqBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAppIntegrationsRead',
      principals: [new iam.ServicePrincipal('app-integrations.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: [faqBucket.arnForObjects('*')],
      conditions: appIntegrationsCondition,
    }));

    const faqDeployment = new s3deploy.BucketDeployment(this, 'DeployFaqs', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../faqs'))],
      destinationBucket: faqBucket,
    });

    const dataIntegration = new appintegrations.CfnDataIntegration(this, 'FaqDataIntegration', {
      name: FAQ_SOURCE_NAME,
      description: 'Harbor Ridge 311 FAQ documents',
      kmsKey: faqKey.keyArn,
      sourceUri: cdk.Fn.join('', ['s3://', faqBucket.bucketName]),
    });
    dataIntegration.node.addDependency(faqDeployment);
    if (faqBucket.policy) {
      dataIntegration.node.addDependency(faqBucket.policy);
    }

    const knowledgeBase = new wisdom.CfnKnowledgeBase(this, 'FaqKnowledgeBase', {
      name: FAQ_SOURCE_NAME,
      description: 'Harbor Ridge 311 city FAQ',
      knowledgeBaseType: 'EXTERNAL',
      sourceConfiguration: {
        appIntegrations: {
          appIntegrationArn: dataIntegration.attrDataIntegrationArn,
        },
      },
    });

    new wisdom.CfnAssistantAssociation(this, 'FaqAssociation', {
      assistantId,
      associationType: 'KNOWLEDGE_BASE',
      association: {
        knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      },
    });

    new connect.CfnIntegrationAssociation(this, 'KnowledgeBaseIntegration', {
      instanceId: instanceArn,
      integrationType: 'WISDOM_KNOWLEDGE_BASE',
      integrationArn: knowledgeBase.attrKnowledgeBaseArn,
    });

    const guardrail = new wisdom.CfnAIGuardrail(this, 'SelfServiceGuardrail', {
      assistantId,
      name: 'HarborRidge311-Guardrail',
      description: 'Blocks personal information.',
      blockedInputMessaging: BLOCKED_INPUT_MESSAGE,
      blockedOutputsMessaging: BLOCKED_OUTPUT_MESSAGE,
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: BLOCKED_PII.map((type) => ({
          type,
          action: type === 'NAME' ? 'ANONYMIZE' : 'BLOCK',
        })),
        regexesConfig: [
          {
            name: 'AccountNumber',
            pattern: '\\b\\d{10,12}\\b',
            action: 'BLOCK',
            description: 'Utility or city account numbers',
          },
        ],
      },
    });
    const guardrailVersion = new wisdom.CfnAIGuardrailVersion(this, 'SelfServiceGuardrailVersion', {
      assistantId,
      aiGuardrailId: guardrail.attrAiGuardrailId,
      modifiedTimeSeconds: cdk.Token.asNumber(guardrail.attrModifiedTimeSeconds),
    });
    const orchestrationAgents = (['Voice', 'Chat'] as const).map((channel) => {
      const prompt = new wisdom.CfnAIPrompt(this, `${channel}OrchestrationPrompt`, {
        assistantId,
        name: `HarborRidge311-${channel}Orchestration`,
        description: `Harbor Ridge 311 ${channel.toLowerCase()} self-service orchestration prompt.`,
        type: 'ORCHESTRATION',
        apiFormat: 'MESSAGES',
        modelId: ORCHESTRATION_MODEL_ID,
        templateType: 'TEXT',
        templateConfiguration: {
          textFullAiPromptEditTemplateConfiguration: {
            text: orchestrationPrompt(channel === 'Voice' ? 'voice' : 'chat'),
          },
        },
      });
      const promptVersion = new wisdom.CfnAIPromptVersion(this, `${channel}OrchestrationPromptVersion`, {
        assistantId,
        aiPromptId: prompt.attrAiPromptId,
        modifiedTimeSeconds: cdk.Token.asNumber(prompt.attrModifiedTimeSeconds),
      });
      const agent = new wisdom.CfnAIAgent(this, `${channel}OrchestrationAgent`, {
        assistantId,
        name: `HarborRidge311-${channel}Orchestration`,
        type: 'ORCHESTRATION',
        description: `Harbor Ridge 311 ${channel.toLowerCase()} self-service orchestration agent.`,
        configuration: {
          orchestrationAiAgentConfiguration: {
            connectInstanceArn: instanceArn,
            locale: 'en_US',
            orchestrationAiGuardrailId: guardrailVersion.attrAiGuardrailVersionId,
            orchestrationAiPromptId: promptVersion.attrAiPromptVersionId,
            toolConfigurations: orchestrationTools(),
          },
        },
      });
      const agentVersion = new wisdom.CfnAIAgentVersion(this, `${channel}OrchestrationAgentVersion`, {
        assistantId,
        aiAgentId: agent.attrAiAgentId,
        modifiedTimeSeconds: cdk.Token.asNumber(agent.attrModifiedTimeSeconds),
      });
      return { agent, agentVersion };
    });
    const [voiceOrchestrator, chatOrchestrator] = orchestrationAgents;
    if (!voiceOrchestrator || !chatOrchestrator) {
      throw new Error('missing orchestration agents');
    }

    const orchestratorSecurityProfile = new connect.CfnSecurityProfile(this, 'OrchestratorSecurityProfile', {
      instanceArn,
      securityProfileName: 'HarborRidge311-Orchestration',
      description: 'Lets the Harbor Ridge 311 orchestration agents retrieve FAQ answers.',
      permissions: ['Wisdom.View'],
    });
    const securityProfileId = cdk.Fn.select(3, cdk.Fn.split('/', orchestratorSecurityProfile.attrSecurityProfileArn));
    const voiceAgentArn = voiceOrchestrator.agent.attrAiAgentArn;
    const voiceAgentVersionArn = voiceOrchestrator.agentVersion.attrAiAgentArn;
    const chatAgentArn = chatOrchestrator.agent.attrAiAgentArn;
    const chatAgentVersionArn = chatOrchestrator.agentVersion.attrAiAgentArn;
    const agentArns = [voiceAgentArn, voiceAgentVersionArn, chatAgentArn, chatAgentVersionArn];
    const unqualifiedAgentArn = (agentId: string): string => this.formatArn({
      service: 'wisdom',
      resource: 'ai-agent',
      resourceName: cdk.Fn.join('/', [assistantId, agentId]),
    });
    const voiceUnqualifiedArn = unqualifiedAgentArn(voiceOrchestrator.agent.attrAiAgentId);
    const chatUnqualifiedArn = unqualifiedAgentArn(chatOrchestrator.agent.attrAiAgentId);
    const getAiAgentResources = [
      ...agentArns,
      voiceUnqualifiedArn,
      cdk.Fn.join('', [voiceUnqualifiedArn, ':*']),
      chatUnqualifiedArn,
      cdk.Fn.join('', [chatUnqualifiedArn, ':*']),
    ];
    const securityProfileResources = [
      instanceArn,
      orchestratorSecurityProfile.attrSecurityProfileArn,
      ...agentArns,
    ];
    const securityProfileAssociations = [
      { id: 'AssociateVoiceAgentProfile', entityArn: voiceAgentArn },
      { id: 'AssociateVoiceAgentVersionProfile', entityArn: voiceAgentVersionArn },
      { id: 'AssociateChatAgentProfile', entityArn: chatAgentArn },
      { id: 'AssociateChatAgentVersionProfile', entityArn: chatAgentVersionArn },
    ].map(({ id, entityArn }) => {
      const parameters = {
        InstanceId: instanceId,
        EntityArn: entityArn,
        EntityType: 'AI_AGENT',
        SecurityProfiles: [{ Id: securityProfileId }],
      };
      const associateCall: cr.AwsSdkCall = {
        service: 'connect',
        action: 'AssociateSecurityProfiles',
        parameters,
        physicalResourceId: cr.PhysicalResourceId.of(`HarborRidge311-${id}`),
      };
      return new cr.AwsCustomResource(this, id, {
        installLatestAwsSdk: true,
        onCreate: associateCall,
        onUpdate: associateCall,
        onDelete: {
          service: 'connect',
          action: 'DisassociateSecurityProfiles',
          parameters,
          ignoreErrorCodesMatching: 'ResourceNotFoundException|InvalidParameterException',
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['connect:AssociateSecurityProfiles'],
            resources: securityProfileResources,
          }),
          new iam.PolicyStatement({
            actions: ['connect:DisassociateSecurityProfiles'],
            resources: securityProfileResources,
          }),
          new iam.PolicyStatement({
            actions: ['wisdom:GetAIAgent'],
            resources: getAiAgentResources,
          }),
        ]),
      });
    });

    const setDefaultAgentCall: cr.AwsSdkCall = {
      service: 'QConnect',
      action: 'UpdateAssistantAIAgent',
      parameters: {
        assistantId,
        aiAgentType: 'ORCHESTRATION',
        configuration: {
          aiAgentId: voiceOrchestrator.agentVersion.attrAiAgentVersionId,
        },
        orchestratorUseCase: SELF_SERVICE_USE_CASE,
      },
      physicalResourceId: cr.PhysicalResourceId.of('HarborRidge311-SelfServiceOrchestrator'),
    };
    const setDefaultAgent = new cr.AwsCustomResource(this, 'SetDefaultOrchestrationAgent', {
      installLatestAwsSdk: true,
      onCreate: setDefaultAgentCall,
      onUpdate: setDefaultAgentCall,
      onDelete: {
        service: 'QConnect',
        action: 'RemoveAssistantAIAgent',
        parameters: {
          assistantId,
          aiAgentType: 'ORCHESTRATION',
          orchestratorUseCase: SELF_SERVICE_USE_CASE,
        },
        ignoreErrorCodesMatching: 'ResourceNotFoundException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['wisdom:UpdateAssistantAIAgent', 'wisdom:RemoveAssistantAIAgent'],
          resources: [assistantArn],
        }),
      ]),
    });
    setDefaultAgent.node.addDependency(...securityProfileAssociations);

    const botRole = new iam.Role(this, 'CityQuestionsBotRole', {
      assumedBy: new iam.ServicePrincipal('lexv2.amazonaws.com'),
    });
    botRole.addToPolicy(new iam.PolicyStatement({
      actions: ['wisdom:CreateSession', 'wisdom:GetAssistant'],
      resources: [
        assistantArn,
        cdk.Fn.join('', [assistantArn, '/*']),
      ],
    }));
    botRole.addToPolicy(new iam.PolicyStatement({
      actions: ['polly:SynthesizeSpeech'],
      resources: ['*'],
    }));
    const lexTextLogs = new logs.LogGroup(this, 'CityQuestionsTextLogs', {
      logGroupName: '/aws/lex/HarborRidge311-CityQuestions',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    botRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [cdk.Fn.join('', [lexTextLogs.logGroupArn, ':*'])],
    }));
    botRole.addToPolicy(new iam.PolicyStatement({
      actions: ['wisdom:SendMessage', 'wisdom:GetNextMessage'],
      resources: [
        this.formatArn({
          service: 'wisdom',
          resource: 'session',
          resourceName: cdk.Fn.join('', [assistantId, '/*']),
        }),
      ],
    }));

    const bot = new lex.CfnBot(this, 'CityQuestionsBot', {
      name: 'HarborRidge311-CityQuestions',
      description: 'Harbor Ridge 311 city questions',
      roleArn: botRole.roleArn,
      dataPrivacy: { ChildDirected: false },
      idleSessionTtlInSeconds: 600,
      autoBuildBotLocales: true,
      testBotAliasSettings: {
        botAliasLocaleSettings: [enabledLocale('en_US')],
      },
      botLocales: [
        cityQuestionLocale('en_US', 'Joanna', assistantArn),
      ],
    });
    const botVersion = new lex.CfnBotVersion(this, 'CityQuestionsBotVersion', {
      botId: bot.attrId,
      botVersionLocaleSpecification: [
        { localeId: 'en_US', botVersionLocaleDetails: { sourceBotVersion: 'DRAFT' } },
      ],
    });
    const botAlias = new lex.CfnBotAlias(this, 'CityQuestionsBotAlias', {
      botId: bot.attrId,
      botAliasName: 'live',
      botVersion: botVersion.attrBotVersion,
      botAliasLocaleSettings: [enabledLocale('en_US')],
      conversationLogSettings: {
        textLogSettings: [{
          enabled: true,
          destination: {
            cloudWatch: {
              cloudWatchLogGroupArn: lexTextLogs.logGroupArn,
              logPrefix: 'live',
            },
          },
        }],
      },
    });
    botAlias.node.addDependency(botRole.node.findChild('DefaultPolicy'));
    const lexAssociation = new connect.CfnIntegrationAssociation(this, 'LexBotIntegration', {
      instanceId: instanceArn,
      integrationType: 'LEX_BOT',
      integrationArn: botAlias.attrArn,
    });

    const orchestratorLogGroup = new logs.LogGroup(this, 'SelectOrchestratorLogs', {
      logGroupName: '/aws/lambda/HarborRidge311-SelectOrchestrator',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const orchestratorRole = new iam.Role(this, 'SelectOrchestratorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    orchestratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [cdk.Fn.join('', [orchestratorLogGroup.logGroupArn, ':*'])],
    }));
    const selectOrchestrator = new nodejs.NodejsFunction(this, 'SelectOrchestrator', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, 'select-orchestrator.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(8),
      functionName: 'HarborRidge311-SelectOrchestrator',
      logGroup: orchestratorLogGroup,
      role: orchestratorRole,
      bundling: {
        externalModules: [],
      },
      environment: {
        ASSISTANT_ID: assistantId,
        VOICE_AGENT_VERSION_ID: voiceOrchestrator.agentVersion.attrAiAgentVersionId,
        CHAT_AGENT_VERSION_ID: chatOrchestrator.agentVersion.attrAiAgentVersionId,
      },
    });
    selectOrchestrator.addToRolePolicy(new iam.PolicyStatement({
      actions: ['wisdom:UpdateSession'],
      resources: [
        this.formatArn({
          service: 'wisdom',
          resource: 'session',
          resourceName: cdk.Fn.join('/', [assistantId, '*']),
        }),
      ],
    }));
    selectOrchestrator.addPermission('AllowConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      sourceArn: instanceArn,
    });
    const orchestratorAssociation = new connect.CfnIntegrationAssociation(this, 'OrchestratorLambdaIntegration', {
      instanceId: instanceArn,
      integrationType: 'LAMBDA_FUNCTION',
      integrationArn: selectOrchestrator.functionArn,
    });

    const hoursOfOperation = new connect.CfnHoursOfOperation(this, 'Hours', {
      instanceArn,
      name: 'HarborRidge311-Hours',
      timeZone: hours.timeZone,
      config: hours.config.map((day) => ({
        day: day.day,
        startTime: day.startTime,
        endTime: day.endTime,
      })),
    });

    const afterHours = new connect.CfnContactFlow(this, 'AfterHoursFlow', {
      instanceArn,
      name: 'HarborRidge311-AfterHours',
      type: 'CONTACT_FLOW',
      content: cdk.Fn.toJsonString(afterHoursFlow()),
    });

    const flow = new connect.CfnContactFlow(this, 'MainFlow', {
      instanceArn,
      name: 'HarborRidge311-Main',
      type: 'CONTACT_FLOW',
      content: cdk.Fn.toJsonString(mainFlow({
        dataTableId: cdk.Fn.select(3, cdk.Fn.split('/', prompts.attrArn)),
        wisdomAssistantArn: assistantArn,
        lexBotAliasArn: botAlias.attrArn,
        orchestratorLambdaArn: selectOrchestrator.functionArn,
        hoursOfOperationArn: hoursOfOperation.attrHoursOfOperationArn,
        afterHoursFlowArn: afterHours.attrContactFlowArn,
      })),
    });
    flow.node.addDependency(...promptRows, lexAssociation, orchestratorAssociation);
    setDefaultAgent.node.addDependency(botAlias, flow);
    const mainContactFlowId = cdk.Fn.select(3, cdk.Fn.split('/', flow.attrContactFlowArn));
    new ssm.StringParameter(this, 'MainContactFlowIdParameter', {
      parameterName: MAIN_CONTACT_FLOW_ID_PARAMETER,
      stringValue: mainContactFlowId,
    }).applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    new ssm.StringParameter(this, 'MainContactFlowArnParameter', {
      parameterName: MAIN_CONTACT_FLOW_ARN_PARAMETER,
      stringValue: flow.attrContactFlowArn,
    }).applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const associateCall: cr.AwsSdkCall = {
      service: 'connect',
      action: 'AssociatePhoneNumberContactFlow',
      parameters: {
        PhoneNumberId: phoneNumberArn,
        InstanceId: instanceId,
        ContactFlowId: flow.attrContactFlowArn,
      },
      physicalResourceId: cr.PhysicalResourceId.of('HarborRidge311-Main'),
    };

    new cr.AwsCustomResource(this, 'AssociatePhoneNumber', {
      onCreate: associateCall,
      onUpdate: associateCall,
      onDelete: {
        service: 'connect',
        action: 'DisassociatePhoneNumberContactFlow',
        parameters: {
          PhoneNumberId: phoneNumberArn,
          InstanceId: instanceId,
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['connect:AssociatePhoneNumberContactFlow'],
          resources: [instanceArn, flow.attrContactFlowArn, phoneNumberArn],
        }),
        new iam.PolicyStatement({
          actions: ['connect:DisassociatePhoneNumberContactFlow'],
          resources: [instanceArn, phoneNumberArn],
        }),
      ]),
    });

    const voicemails = new dynamodb.Table(this, 'Voicemails', {
      tableName: 'HarborRidge311-Voicemails',
      partitionKey: { name: 'contactId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      timeToLiveAttribute: 'expiresAt',
    });

    const voicemailLogGroup = new logs.LogGroup(this, 'VoicemailIndexerLogs', {
      logGroupName: '/aws/lambda/HarborRidge311-VoicemailIndexer',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const voicemailRole = new iam.Role(this, 'VoicemailIndexerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    voicemailRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [cdk.Fn.join('', [voicemailLogGroup.logGroupArn, ':*'])],
    }));
    const voicemailFailures = new sqs.Queue(this, 'VoicemailIndexerFailures', {
      queueName: 'HarborRidge311-VoicemailIndexerFailures',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const voicemailIndexer = new nodejs.NodejsFunction(this, 'VoicemailIndexer', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, 'voicemail-handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      functionName: 'HarborRidge311-VoicemailIndexer',
      logGroup: voicemailLogGroup,
      role: voicemailRole,
      onFailure: new destinations.SqsDestination(voicemailFailures),
      environment: {
        TABLE_NAME: voicemails.tableName,
        BUCKET_NAME: storageBucket.bucketName,
        INSTANCE_ID: instanceId,
      },
    });
    voicemailIndexer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [storageBucket.arnForObjects(`${RECORDINGS_PREFIX}*`)],
    }));
    voicemailIndexer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['connect:DescribeContact', 'connect:GetContactAttributes'],
      resources: [cdk.Fn.join('', [instanceArn, '/contact/*'])],
    }));
    voicemailIndexer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem'],
      resources: [voicemails.tableArn],
    }));

    new events.Rule(this, 'VoicemailRecordingCreated', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: {
            name: [storageBucket.bucketName],
          },
          object: {
            key: events.Match.wildcard(VOICEMAIL_RECORDING_KEY_PATTERN),
          },
        },
      },
      targets: [new targets.LambdaFunction(voicemailIndexer)],
    });

    const requestCategory = new cases.CfnField(this, 'RequestCategory', {
      domainId: casesDomainId,
      name: 'Request category',
      type: 'SingleSelect',
    });
    const serviceAddress = new cases.CfnField(this, 'ServiceAddress', {
      domainId: casesDomainId,
      name: 'Service address',
      type: 'Text',
      attributes: { text: { isMultiline: false } },
    });
    const serviceRequestLayout = new cases.CfnLayout(this, 'ServiceRequestLayout', {
      domainId: casesDomainId,
      name: 'Harbor Ridge 311 Service Request',
      content: {
        basic: {
          topPanel: {
            sections: [{
              fieldGroup: {
                fields: [
                  { id: requestCategory.attrFieldId },
                  { id: serviceAddress.attrFieldId },
                  { id: 'summary' },
                  { id: 'customer_id' },
                ],
              },
            }],
          },
        },
      },
    });
    const serviceRequest = new cases.CfnTemplate(this, 'ServiceRequestTemplate', {
      domainId: casesDomainId,
      name: 'Harbor Ridge 311 Service Request',
      status: 'Active',
      layoutConfiguration: { defaultLayout: serviceRequestLayout.attrLayoutId },
      requiredFields: [
        { fieldId: 'title' },
        { fieldId: requestCategory.attrFieldId },
      ],
    });
    for (const resource of [requestCategory, serviceAddress, serviceRequestLayout, serviceRequest]) {
      resource.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }

    const categoryOptions = [
      { name: 'Trash pickup', value: 'trash-pickup' },
      { name: 'Pothole', value: 'pothole' },
      { name: 'Parking permit', value: 'parking-permit' },
      { name: 'Other', value: 'other' },
    ];
    const categoryOptionCall = (active: boolean): cr.AwsSdkCall => ({
      service: 'ConnectCases',
      action: 'BatchPutFieldOptions',
      parameters: {
        domainId: casesDomainId,
        fieldId: requestCategory.attrFieldId,
        options: categoryOptions.map((option) => ({ ...option, active })),
      },
      physicalResourceId: cr.PhysicalResourceId.of('HarborRidge311-RequestCategory'),
    });
    const requestCategoryOptions = new cr.AwsCustomResource(this, 'RequestCategoryOptions', {
      installLatestAwsSdk: true,
      onCreate: categoryOptionCall(true),
      onUpdate: categoryOptionCall(true),
      onDelete: {
        ...categoryOptionCall(false),
        ignoreErrorCodesMatching: 'ValidationException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cases:BatchPutFieldOptions'],
          resources: [
            this.formatArn({
              service: 'cases',
              resource: 'domain',
              resourceName: casesDomainId,
            }),
            requestCategory.attrFieldArn,
          ],
        }),
      ]),
    });
    serviceRequest.node.addDependency(requestCategoryOptions);

    new cdk.CfnOutput(this, 'ContactFlowArn', {
      value: flow.attrContactFlowArn,
      description: 'ARN of the Harbor Ridge 311 main contact flow',
    });

    new cdk.CfnOutput(this, 'PhoneNumber', {
      value: phoneNumber,
      description: 'Sandbox phone number associated with the main contact flow',
    });

    new cdk.CfnOutput(this, 'AssistantArn', {
      value: assistantArn,
      description: 'Sandbox Q in Connect assistant ARN',
    });

    new cdk.CfnOutput(this, 'LexBotAliasArn', {
      value: botAlias.attrArn,
      description: 'ARN of the Lex V2 alias used for city questions',
    });
  }
}
