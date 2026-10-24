import * as path from 'node:path';
import * as appintegrations from 'aws-cdk-lib/aws-appintegrations';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lex from 'aws-cdk-lib/aws-lex';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wisdom from 'aws-cdk-lib/aws-wisdom';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { ESCALATION_GUIDE_FLOW_NAME, escalationGuideFlow } from './flows/escalation-guide-flow';
import {
  AFTER_HOURS_TICKET_CHAT_TEXT,
  AFTER_HOURS_TICKET_TEXT_AFTER,
  AFTER_HOURS_TICKET_VOICE_TEXT,
  MAIN_FLOW_NAME,
  mainFlow,
} from './flows/main-flow';
import { customerQueueFlow, QUEUE_CHAT_TEXT, QUEUE_FLOW_NAME, QUEUE_VOICE_TEXT } from './flows/queue-flow';
import { ORCHESTRATION_MODEL_ID, orchestrationPrompt } from './orchestration-prompt';
import { SELF_SERVICE_USE_CASE } from './select-orchestrator';
import { addTickets } from './tickets/resources';
import { TICKET_OPERATIONS, ticketToolId } from './tickets/tools';

export const SANDBOX_PARAMETER_PREFIX = '/connect/sandbox';
export const MAIN_CONTACT_FLOW_ID_PARAMETER = `${SANDBOX_PARAMETER_PREFIX}/harbor-ridge-311/main-contact-flow-id`;
export const MAIN_CONTACT_FLOW_ARN_PARAMETER = `${SANDBOX_PARAMETER_PREFIX}/harbor-ridge-311/main-contact-flow-arn`;
export const CUSTOMER_QUEUE_PROMPT_ID = '666650f7-db8f-435f-bc27-77644f59f6bb';

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
    const tickets = addTickets(this, instanceArn, instanceId);

    const prompts = new connect.CfnDataTable(this, 'PromptsByChannel', {
      instanceArn,
      name: 'HarborRidge311-PromptsByChannel',
      status: 'PUBLISHED',
      timeZone: 'America/New_York',
      valueLockLevel: 'NONE',
    });

    const promptAttribute = new connect.CfnDataTableAttribute(this, 'PromptAttribute', {
      instanceArn,
      dataTableArn: prompts.attrArn,
      name: 'Prompt',
      primary: true,
      valueType: 'TEXT',
    });
    const channelAttribute = new connect.CfnDataTableAttribute(this, 'ChannelAttribute', {
      instanceArn,
      dataTableArn: prompts.attrArn,
      name: 'Channel',
      primary: true,
      valueType: 'TEXT',
    });
    const textAttribute = new connect.CfnDataTableAttribute(this, 'TextAttribute', {
      instanceArn,
      dataTableArn: prompts.attrArn,
      name: 'Text',
      valueType: 'TEXT',
    });
    const textAfterAttribute = new connect.CfnDataTableAttribute(this, 'TextAfterAttribute', {
      instanceArn,
      dataTableArn: prompts.attrArn,
      name: 'TextAfter',
      valueType: 'TEXT',
    });
    const promptRows = [
      ['Greeting', 'VOICE', 'Thank you for calling Harbor Ridge 3 1 1. This line is a demo.'],
      ['Greeting', 'CHAT', 'Welcome to Harbor Ridge 311 chat. This is a demo.'],
      ['Goodbye', 'VOICE', 'Thank you for calling Harbor Ridge 3 1 1. Goodbye.'],
      ['Goodbye', 'CHAT', 'Thanks for chatting with Harbor Ridge 311. Goodbye.'],
      ['Question', 'VOICE', 'What can I help you with? You can ask about trash pickup, potholes, parking permits, or office hours. Say agent if you would rather talk to a person.'],
      ['Question', 'CHAT', 'What can I help you with? You can ask about trash pickup, potholes, parking permits, or office hours, or type agent to reach a person.'],
      ['AfterHoursTicket', 'CHAT', AFTER_HOURS_TICKET_CHAT_TEXT, AFTER_HOURS_TICKET_TEXT_AFTER],
      ['AfterHoursTicket', 'VOICE', AFTER_HOURS_TICKET_VOICE_TEXT, AFTER_HOURS_TICKET_TEXT_AFTER],
      ['Queue', 'CHAT', QUEUE_CHAT_TEXT],
      ['Queue', 'VOICE', QUEUE_VOICE_TEXT],
    ].map(([prompt, channel, text, textAfter]) => new connect.CfnDataTableRecord(this, `${prompt}${channel}`, {
      instanceArn,
      dataTableArn: prompts.attrArn,
      dataTableRecord: {
        primaryValues: [
          { attributeId: promptAttribute.attrAttributeId, attributeValue: prompt },
          { attributeId: channelAttribute.attrAttributeId, attributeValue: channel },
        ],
        values: textAfter === undefined
          ? [{ attributeId: textAttribute.attrAttributeId, attributeValue: text }]
          : [
            { attributeId: textAttribute.attrAttributeId, attributeValue: text },
            { attributeId: textAfterAttribute.attrAttributeId, attributeValue: textAfter },
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
      agent.node.addDependency(tickets.target, tickets.application, tickets.applicationIntegration);
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
      description: 'Lets the Harbor Ridge 311 orchestration agents retrieve FAQ answers and use ticket tools.',
      permissions: ['Wisdom.View'],
      applications: [{
        namespace: tickets.gatewayIdentifier,
        type: 'MCP',
        applicationPermissions: TICKET_OPERATIONS.map((operation) => ticketToolId(operation)),
      }],
    });
    orchestratorSecurityProfile.node.addDependency(tickets.applicationIntegration);
    const securityProfileId = cdk.Fn.select(3, cdk.Fn.split('/', orchestratorSecurityProfile.attrSecurityProfileArn));
    const voiceAgentArn = voiceOrchestrator.agent.attrAiAgentArn;
    const voiceAgentVersionArn = voiceOrchestrator.agentVersion.attrAiAgentArn;
    const chatAgentArn = chatOrchestrator.agent.attrAiAgentArn;
    const chatAgentVersionArn = chatOrchestrator.agentVersion.attrAiAgentArn;
    const stableAgentResources = [voiceOrchestrator.agent.attrAiAgentId, chatOrchestrator.agent.attrAiAgentId]
      .flatMap((agentId) => {
        const arn = this.formatArn({
          service: 'wisdom',
          resource: 'ai-agent',
          resourceName: cdk.Fn.join('/', [assistantId, agentId]),
        });
        return [arn, cdk.Fn.join('', [arn, ':*'])];
      });
    const securityProfileResources = [
      instanceArn,
      orchestratorSecurityProfile.attrSecurityProfileArn,
      ...stableAgentResources,
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
        memorySize: 512,
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
            resources: stableAgentResources,
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
      memorySize: 512,
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
      actions: ['wisdom:UpdateSession', 'wisdom:UpdateSessionData'],
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

    const queue = new connect.CfnQueue(this, 'GeneralQueue', {
      instanceArn,
      name: 'HarborRidge311-General',
      description: 'Harbor Ridge 311 general queue',
      hoursOfOperationArn: hoursOfOperation.attrHoursOfOperationArn,
      status: 'ENABLED',
    });
    const agentRoutingProfile = new connect.CfnRoutingProfile(this, 'AgentRoutingProfile', {
      instanceArn,
      name: 'HarborRidge311-Agents',
      description: 'Harbor Ridge 311 voice and chat agents',
      defaultOutboundQueueArn: queue.attrQueueArn,
      mediaConcurrencies: [
        { channel: 'VOICE', concurrency: 1 },
        { channel: 'CHAT', concurrency: 2 },
      ],
      queueConfigs: (['VOICE', 'CHAT'] as const).map((channel) => ({
        delay: 0,
        priority: 1,
        queueReference: { channel, queueArn: queue.attrQueueArn },
      })),
    });
    const agentSecurityProfile = new connect.CfnSecurityProfile(this, 'AgentSecurityProfile', {
      instanceArn,
      securityProfileName: 'HarborRidge311-Agent',
      description: 'Lets a Harbor Ridge 311 agent handle contacts, step-by-step guides, and Q in Connect.',
      permissions: [
        'BasicAgentAccess',
        'CustomViews.Access',
        'Wisdom.View',
      ],
    });
    const agentPassword = new secretsmanager.Secret(this, 'AgentPassword', {
      description: 'Password for the Harbor Ridge 311 test agent',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: {
        passwordLength: 32,
        requireEachIncludedType: true,
        excludePunctuation: false,
        includeSpace: false,
        excludeCharacters: ' "\'\\`',
      },
    });
    new connect.CfnUser(this, 'AgentUser', {
      instanceArn,
      username: 'harborridge-agent1',
      password: cdk.Fn.join('', [
        '{{resolve:secretsmanager:',
        agentPassword.secretArn,
        ':SecretString:::}}',
      ]),
      identityInfo: {
        firstName: 'Harbor',
        lastName: 'Agent',
        email: 'harborridge-agent1@example.com',
      },
      phoneConfig: {
        phoneType: 'SOFT_PHONE',
        autoAccept: false,
      },
      routingProfileArn: agentRoutingProfile.attrRoutingProfileArn,
      securityProfileArns: [agentSecurityProfile.attrSecurityProfileArn],
    });

    const dataTableId = cdk.Fn.select(3, cdk.Fn.split('/', prompts.attrArn));

    const customerQueue = customerQueueFlow({
      dataTableId,
      holdMusicPromptArn: cdk.Fn.join('', [instanceArn, '/prompt/', CUSTOMER_QUEUE_PROMPT_ID]),
    });
    const queueFlow = new connect.CfnContactFlow(this, 'QueueFlow', {
      instanceArn,
      name: QUEUE_FLOW_NAME,
      type: customerQueue.type,
      content: cdk.Fn.toJsonString(customerQueue.content),
    });
    const promptRow = (id: string) => {
      const found = promptRows.find((record) => record.node.id === id);
      if (!found) {
        throw new Error(`missing prompt row ${id}`);
      }
      return found;
    };
    queueFlow.node.addDependency(promptRow('QueueCHAT'), promptRow('QueueVOICE'));

    const guide = escalationGuideFlow({
      detailViewArn: cdk.Fn.join('', [
        'arn:',
        cdk.Aws.PARTITION,
        ':connect:',
        cdk.Aws.REGION,
        ':aws:view/detail:1',
      ]),
    });
    const escalationGuide = new connect.CfnContactFlow(this, 'EscalationGuide', {
      instanceArn,
      name: ESCALATION_GUIDE_FLOW_NAME,
      type: guide.type,
      content: cdk.Fn.toJsonString(guide.content),
    });

    const main = mainFlow({
      dataTableId,
      wisdomAssistantArn: assistantArn,
      lexBotAliasArn: botAlias.attrArn,
      orchestratorLambdaArn: selectOrchestrator.functionArn,
      hoursOfOperationArn: hoursOfOperation.attrHoursOfOperationArn,
      queueArn: queue.attrQueueArn,
      escalationGuideFlowArn: escalationGuide.attrContactFlowArn,
      customerQueueFlowArn: queueFlow.attrContactFlowArn,
      ticketLambdaArn: tickets.lambdaArn,
    });
    const flow = new connect.CfnContactFlow(this, 'MainFlow', {
      instanceArn,
      name: MAIN_FLOW_NAME,
      type: main.type,
      content: cdk.Fn.toJsonString(main.content),
    });
    flow.node.addDependency(...promptRows, lexAssociation, orchestratorAssociation, tickets.lambdaIntegration);
    setDefaultAgent.node.addDependency(botAlias, flow, tickets.target, tickets.applicationIntegration);
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
      memorySize: 512,
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

    new cdk.CfnOutput(this, 'AgentPasswordSecretArn', {
      value: agentPassword.secretArn,
      description: 'Secrets Manager ARN for the Harbor Ridge 311 test agent password',
    });
  }
}
