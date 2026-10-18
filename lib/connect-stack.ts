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

function enabledLocale(localeId: string) {
  return { localeId, botAliasLocaleSetting: { enabled: true } };
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
    const assistantArn = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/assistant-arn`,
    );
    const assistantId = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/assistant-id`,
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
    const promptRows = [
      {
        id: 'EnglishPrompt',
        language: 'en-US',
        greeting: 'Thank you for calling Harbor Ridge 3 1 1. This line is a demo.',
        goodbye: 'Thank you for calling Harbor Ridge 3 1 1. Goodbye.',
      },
      {
        id: 'SpanishPrompt',
        language: 'es-US',
        greeting: 'Gracias por llamar a Harbor Ridge tres uno uno. Esta línea es una demostración.',
        goodbye: 'Gracias por llamar a Harbor Ridge tres uno uno. Adiós.',
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
        piiEntitiesConfig: BLOCKED_PII.map((type) => ({ type, action: 'BLOCK' })),
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
    const selfServiceAgent = new wisdom.CfnAIAgent(this, 'SelfServiceAgent', {
      assistantId,
      name: 'HarborRidge311-SelfService',
      type: 'SELF_SERVICE',
      description: 'Answers Harbor Ridge city questions from the FAQ knowledge base.',
      configuration: {
        selfServiceAiAgentConfiguration: {
          selfServiceAiGuardrailId: guardrailVersion.attrAiGuardrailVersionId,
        },
      },
    });
    const selfServiceAgentVersion = new wisdom.CfnAIAgentVersion(this, 'SelfServiceAgentVersion', {
      assistantId,
      aiAgentId: selfServiceAgent.attrAiAgentId,
      modifiedTimeSeconds: cdk.Token.asNumber(selfServiceAgent.attrModifiedTimeSeconds),
    });

    const setDefaultAgentCall: cr.AwsSdkCall = {
      service: 'QConnect',
      action: 'UpdateAssistantAIAgent',
      parameters: {
        assistantId,
        aiAgentType: 'SELF_SERVICE',
        configuration: {
          aiAgentId: selfServiceAgentVersion.attrAiAgentVersionId,
        },
      },
      physicalResourceId: cr.PhysicalResourceId.of(selfServiceAgentVersion.attrAiAgentVersionId),
    };
    const setDefaultAgent = new cr.AwsCustomResource(this, 'SetDefaultSelfServiceAgent', {
      installLatestAwsSdk: true,
      onCreate: setDefaultAgentCall,
      onUpdate: setDefaultAgentCall,
      onDelete: {
        service: 'QConnect',
        action: 'RemoveAssistantAIAgent',
        parameters: {
          assistantId,
          aiAgentType: 'SELF_SERVICE',
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['wisdom:UpdateAssistantAIAgent', 'wisdom:RemoveAssistantAIAgent'],
          resources: [assistantArn],
        }),
      ]),
    });

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
        botAliasLocaleSettings: [enabledLocale('en_US'), enabledLocale('es_US')],
      },
      botLocales: [
        cityQuestionLocale('en_US', 'Joanna', assistantArn),
        cityQuestionLocale('es_US', 'Lupe', assistantArn),
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
      botAliasLocaleSettings: [enabledLocale('en_US'), enabledLocale('es_US')],
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
        wisdomAssistantArn: assistantArn,
        lexBotAliasArn: botAlias.attrArn,
      })),
    });
    flow.node.addDependency(...promptRows, lexAssociation);
    setDefaultAgent.node.addDependency(botAlias, flow);

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
      value: assistantArn,
      description: 'Sandbox Q in Connect assistant ARN',
    });

    new cdk.CfnOutput(this, 'LexBotAliasArn', {
      value: botAlias.attrArn,
      description: 'ARN of the Lex V2 alias used for city questions',
    });
  }
}
