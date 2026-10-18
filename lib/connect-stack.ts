import * as path from 'node:path';
import * as appintegrations from 'aws-cdk-lib/aws-appintegrations';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lex from 'aws-cdk-lib/aws-lex';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wisdom from 'aws-cdk-lib/aws-wisdom';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { mainFlow } from './flows/main-flow';

const SANDBOX_PARAMETER_PREFIX = '/connect/sandbox';
const FAQ_SOURCE_NAME = 'HarborRidge311-Faqs';

const BLOCKED_INPUT_MESSAGE = 'I can only help with Harbor Ridge city services, and I cannot take personal information. Please ask about trash pickup, potholes, parking permits, or office hours.';
const BLOCKED_OUTPUT_MESSAGE = 'I cannot share that. Please ask about Harbor Ridge city services without personal details.';

const BLOCKED_PII = [
  'ADDRESS',
  'EMAIL',
  'PHONE',
  'NAME',
  'PASSWORD',
  'US_SOCIAL_SECURITY_NUMBER',
  'CREDIT_DEBIT_CARD_NUMBER',
  'US_BANK_ACCOUNT_NUMBER',
];

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
        parentIntentSignature: 'AMAZON.QinConnectIntent',
        qInConnectIntentConfiguration: {
          qInConnectAssistantConfiguration: { assistantArn },
        },
      },
    ],
  };
}

export class ConnectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
    const questionAttribute = new connect.CfnDataTableAttribute(this, 'QuestionAttribute', {
      instanceArn,
      dataTableArn: prompts.attrArn,
      name: 'Question',
      valueType: 'TEXT',
    });

    const promptRows = [
      {
        id: 'EnglishPrompt',
        language: 'en-US',
        greeting: 'Thank you for calling Harbor Ridge 3 1 1. This line is a demo.',
        goodbye: 'Thank you for calling Harbor Ridge 3 1 1. Goodbye.',
        question: 'What can I help you with? You can ask about trash pickup, potholes, parking permits, or office hours. Say agent if you would rather talk to a person.',
      },
      {
        id: 'SpanishPrompt',
        language: 'es-US',
        greeting: 'Gracias por llamar a Harbor Ridge tres uno uno. Esta línea es una demostración.',
        goodbye: 'Gracias por llamar a Harbor Ridge tres uno uno. Adiós.',
        question: '¿En qué puedo ayudarle? Puede preguntar sobre la recolección de basura, los baches, los permisos de estacionamiento o el horario. Diga agente si prefiere hablar con una persona.',
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
          { attributeId: questionAttribute.attrAttributeId, attributeValue: row.question },
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

    const assistant = new wisdom.CfnAssistant(this, 'Assistant', {
      name: 'HarborRidge311-Assistant',
      type: 'AGENT',
      description: 'Harbor Ridge 311 assistant',
    });

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
      assistantId: assistant.attrAssistantId,
      associationType: 'KNOWLEDGE_BASE',
      association: {
        knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      },
    });

    new connect.CfnIntegrationAssociation(this, 'AssistantIntegration', {
      instanceId: instanceArn,
      integrationType: 'WISDOM_ASSISTANT',
      integrationArn: assistant.attrAssistantArn,
    });
    new connect.CfnIntegrationAssociation(this, 'KnowledgeBaseIntegration', {
      instanceId: instanceArn,
      integrationType: 'WISDOM_KNOWLEDGE_BASE',
      integrationArn: knowledgeBase.attrKnowledgeBaseArn,
    });

    const guardrail = new wisdom.CfnAIGuardrail(this, 'SelfServiceGuardrail', {
      assistantId: assistant.attrAssistantId,
      name: 'HarborRidge311-Guardrail',
      description: 'Blocks off-topic requests and personal information.',
      blockedInputMessaging: BLOCKED_INPUT_MESSAGE,
      blockedOutputsMessaging: BLOCKED_OUTPUT_MESSAGE,
      topicPolicyConfig: {
        topicsConfig: [
          {
            name: 'Off topic',
            type: 'DENY',
            definition: 'Requests unrelated to Harbor Ridge city services such as trash, roads, parking, or office hours.',
            examples: [
              'What is the weather today?',
              'Tell me a joke',
              'Who won the game last night?',
            ],
          },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: BLOCKED_PII.map((type) => ({ type, action: 'BLOCK' })),
      },
    });
    const guardrailVersion = new wisdom.CfnAIGuardrailVersion(this, 'SelfServiceGuardrailVersion', {
      assistantId: assistant.attrAssistantId,
      aiGuardrailId: guardrail.attrAiGuardrailId,
    });
    const guardrailVersionId = cdk.Fn.join(':', [
      guardrail.attrAiGuardrailId,
      cdk.Token.asString(guardrailVersion.attrVersionNumber),
    ]);

    const selfServiceAgent = new wisdom.CfnAIAgent(this, 'SelfServiceAgent', {
      assistantId: assistant.attrAssistantId,
      name: 'HarborRidge311-SelfService',
      type: 'SELF_SERVICE',
      description: 'Answers Harbor Ridge city questions from the FAQ knowledge base.',
      configuration: {
        selfServiceAiAgentConfiguration: {
          selfServiceAiGuardrailId: guardrailVersionId,
        },
      },
    });
    const selfServiceAgentVersion = new wisdom.CfnAIAgentVersion(this, 'SelfServiceAgentVersion', {
      assistantId: assistant.attrAssistantId,
      aiAgentId: selfServiceAgent.attrAiAgentId,
    });
    const selfServiceAgentVersionId = cdk.Fn.join(':', [
      selfServiceAgent.attrAiAgentId,
      cdk.Token.asString(selfServiceAgentVersion.attrVersionNumber),
    ]);

    const setDefaultAgentCall: cr.AwsSdkCall = {
      service: 'QConnect',
      action: 'UpdateAssistantAIAgent',
      parameters: {
        assistantId: assistant.attrAssistantId,
        aiAgentType: 'SELF_SERVICE',
        configuration: {
          aiAgentId: selfServiceAgentVersionId,
        },
      },
      physicalResourceId: cr.PhysicalResourceId.of(selfServiceAgentVersionId),
    };
    const setDefaultAgent = new cr.AwsCustomResource(this, 'SetDefaultSelfServiceAgent', {
      installLatestAwsSdk: true,
      onCreate: setDefaultAgentCall,
      onUpdate: setDefaultAgentCall,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['wisdom:UpdateAssistantAIAgent'],
          resources: [assistant.attrAssistantArn],
        }),
      ]),
    });

    const botRole = new iam.Role(this, 'CityQuestionsBotRole', {
      assumedBy: new iam.ServicePrincipal('lexv2.amazonaws.com'),
    });
    botRole.addToPolicy(new iam.PolicyStatement({
      actions: ['wisdom:CreateSession', 'wisdom:GetAssistant'],
      resources: [
        assistant.attrAssistantArn,
        cdk.Fn.join('', [assistant.attrAssistantArn, '/*']),
      ],
    }));
    botRole.addToPolicy(new iam.PolicyStatement({
      actions: ['wisdom:SendMessage', 'wisdom:GetNextMessage'],
      resources: [
        this.formatArn({
          service: 'wisdom',
          resource: 'session',
          resourceName: `${assistant.attrAssistantId}/*`,
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
      botLocales: [
        cityQuestionLocale('en_US', 'Joanna', assistant.attrAssistantArn),
        cityQuestionLocale('es_US', 'Lupe', assistant.attrAssistantArn),
      ],
    });
    const botVersion = new lex.CfnBotVersion(this, 'CityQuestionsBotVersion', {
      botId: bot.attrId,
      botVersionLocaleSpecification: [
        { localeId: 'en_US', botVersionLocaleDetails: { sourceBotVersion: 'DRAFT' } },
        { localeId: 'es_US', botVersionLocaleDetails: { sourceBotVersion: 'DRAFT' } },
      ],
    });
    const botAlias = new lex.CfnBotAlias(this, 'CityQuestionsBotAlias', {
      botId: bot.attrId,
      botAliasName: 'live',
      botVersion: botVersion.attrBotVersion,
    });
    const lexAssociation = new connect.CfnIntegrationAssociation(this, 'LexBotIntegration', {
      instanceId: instanceArn,
      integrationType: 'LEX_BOT',
      integrationArn: botAlias.attrArn,
    });

    const flow = new connect.CfnContactFlow(this, 'MainFlow', {
      instanceArn,
      name: 'HarborRidge311-Main',
      type: 'CONTACT_FLOW',
      content: cdk.Fn.toJsonString(mainFlow({
        dataTableId: cdk.Fn.select(3, cdk.Fn.split('/', prompts.attrArn)),
        wisdomAssistantArn: assistant.attrAssistantArn,
        lexBotAliasArn: botAlias.attrArn,
      })),
    });
    flow.node.addDependency(...promptRows, setDefaultAgent, lexAssociation);

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

    new cdk.CfnOutput(this, 'ContactFlowArn', {
      value: flow.attrContactFlowArn,
      description: 'ARN of the Harbor Ridge 311 main contact flow',
    });

    new cdk.CfnOutput(this, 'PhoneNumber', {
      value: phoneNumber,
      description: 'Sandbox phone number associated with the main contact flow',
    });

    new cdk.CfnOutput(this, 'AssistantArn', {
      value: assistant.attrAssistantArn,
      description: 'ARN of the Harbor Ridge 311 Q in Connect assistant',
    });

    new cdk.CfnOutput(this, 'LexBotAliasArn', {
      value: botAlias.attrArn,
      description: 'ARN of the Lex V2 alias used for city questions',
    });
  }
}
