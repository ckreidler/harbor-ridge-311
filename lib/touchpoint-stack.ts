import * as path from 'node:path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import {
  MAIN_CONTACT_FLOW_ARN_PARAMETER,
  MAIN_CONTACT_FLOW_ID_PARAMETER,
  SANDBOX_PARAMETER_PREFIX,
} from './connect-stack';

export const TOUCHPOINT_THROTTLE_RATE = 1;
export const TOUCHPOINT_THROTTLE_BURST = 2;

export interface TouchpointStackProps extends cdk.StackProps {
  readonly siteBucket: s3.IBucket;
  readonly distribution: cloudfront.IDistribution;
  readonly siteOrigin: string;
}

export class TouchpointStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TouchpointStackProps) {
    super(scope, id, props);

    const instanceArn = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/instance-arn`,
    );
    const instanceId = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/instance-id`,
    );
    const contactFlowId = ssm.StringParameter.valueForStringParameter(
      this,
      MAIN_CONTACT_FLOW_ID_PARAMETER,
    );
    const contactFlowArn = ssm.StringParameter.valueForStringParameter(
      this,
      MAIN_CONTACT_FLOW_ARN_PARAMETER,
    );
    const contactResources = [instanceArn, contactFlowArn];
    const stopSecret = new secretsmanager.Secret(this, 'VoiceStopSecret', {
      description: 'HMAC key that authorizes stopping a Harbor Ridge web call',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });
    const stopSecretValue = stopSecret.secretValue.unsafeUnwrap();

    const chatLogGroup = contactLogGroup(this, 'StartChatLogs', 'HarborRidge311-StartChat');
    const voiceLogGroup = contactLogGroup(this, 'StartWebRtcLogs', 'HarborRidge311-StartWebRtc');
    const stopLogGroup = contactLogGroup(this, 'StopVoiceLogs', 'HarborRidge311-StopVoice');
    const chatFunction = contactFunction(this, 'StartChat', {
      handler: 'chatHandler',
      functionName: 'HarborRidge311-StartChat',
      logGroup: chatLogGroup,
      action: 'connect:StartChatContact',
      instanceId,
      contactFlowId,
      siteOrigin: props.siteOrigin,
      resources: contactResources,
    });
    const voiceFunction = contactFunction(this, 'StartWebRtc', {
      handler: 'voiceHandler',
      functionName: 'HarborRidge311-StartWebRtc',
      logGroup: voiceLogGroup,
      action: 'connect:StartWebRTCContact',
      instanceId,
      contactFlowId,
      siteOrigin: props.siteOrigin,
      resources: contactResources,
      environment: { STOP_SECRET: stopSecretValue },
    });
    const stopFunction = contactFunction(this, 'StopVoice', {
      handler: 'stopVoiceHandler',
      functionName: 'HarborRidge311-StopVoice',
      logGroup: stopLogGroup,
      action: 'connect:StopContact',
      instanceId,
      contactFlowId,
      siteOrigin: props.siteOrigin,
      resources: [cdk.Fn.join('', [instanceArn, '/contact/*'])],
      environment: { STOP_SECRET: stopSecretValue },
    });

    const api = new apigateway.RestApi(this, 'TouchpointApi', {
      restApiName: 'HarborRidge311-Touchpoint',
      description: 'Starts Harbor Ridge 311 chat and web calls and stops a web call the browser started',
      cloudWatchRole: false,
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: TOUCHPOINT_THROTTLE_RATE,
        throttlingBurstLimit: TOUCHPOINT_THROTTLE_BURST,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [props.siteOrigin],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
      },
    });
    const corsHeaders = {
      'Access-Control-Allow-Origin': cdk.Fn.join('', ["'", props.siteOrigin, "'"]),
      'Access-Control-Allow-Headers': "'Content-Type'",
      'Access-Control-Allow-Methods': "'POST,OPTIONS'",
    };
    api.addGatewayResponse('Gateway4xx', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: corsHeaders,
    });
    api.addGatewayResponse('Gateway5xx', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: corsHeaders,
    });

    const chat = api.root.addResource('chat');
    chat.addMethod('POST', new apigateway.LambdaIntegration(chatFunction));
    const voice = api.root.addResource('voice');
    voice.addMethod('POST', new apigateway.LambdaIntegration(voiceFunction));
    const voiceStop = voice.addResource('stop');
    voiceStop.addMethod('POST', new apigateway.LambdaIntegration(stopFunction));

    const configBody = cdk.Fn.join('', [
      'window.HARBOR_RIDGE_TOUCHPOINT=',
      cdk.Fn.toJsonString({
        chatEndpoint: api.urlForPath('/chat'),
        voiceEndpoint: api.urlForPath('/voice'),
        voiceStopEndpoint: api.urlForPath('/voice/stop'),
        instanceId,
        contactFlowId,
        region: this.region,
      }),
      ';',
    ]);
    const configLogGroup = new logs.LogGroup(this, 'TouchpointConfigLogs', {
      logGroupName: '/aws/lambda/HarborRidge311-TouchpointConfig',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const configObject = {
      Bucket: props.siteBucket.bucketName,
      Key: 'config.js',
    };
    const putConfig: cr.AwsSdkCall = {
      service: 'S3',
      action: 'putObject',
      parameters: {
        ...configObject,
        Body: configBody,
        ContentType: 'application/javascript',
        CacheControl: 'no-cache',
      },
      physicalResourceId: cr.PhysicalResourceId.of('HarborRidge311-TouchpointConfig'),
    };
    new cr.AwsCustomResource(this, 'TouchpointConfig', {
      logGroup: configLogGroup,
      installLatestAwsSdk: false,
      timeout: cdk.Duration.seconds(30),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      onCreate: putConfig,
      onUpdate: putConfig,
      onDelete: {
        service: 'S3',
        action: 'deleteObject',
        parameters: configObject,
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['s3:PutObject', 's3:DeleteObject'],
          resources: [props.siteBucket.arnForObjects('config.js')],
        }),
      ]),
    });

    new cdk.CfnOutput(this, 'ChatEndpoint', {
      value: api.urlForPath('/chat'),
      description: 'Public StartChatContact endpoint',
    });
    new cdk.CfnOutput(this, 'VoiceEndpoint', {
      value: api.urlForPath('/voice'),
      description: 'Public StartWebRTCContact endpoint',
    });
    new cdk.CfnOutput(this, 'VoiceStopEndpoint', {
      value: api.urlForPath('/voice/stop'),
      description: 'Public StopContact endpoint for a web call this browser started',
    });
  }
}

function contactLogGroup(scope: Construct, id: string, functionName: string): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}

function contactFunction(scope: Construct, id: string, options: {
  handler: string;
  functionName: string;
  logGroup: logs.LogGroup;
  action: string;
  instanceId: string;
  contactFlowId: string;
  siteOrigin: string;
  resources: string[];
  environment?: Record<string, string>;
}): nodejs.NodejsFunction {
  const role = new iam.Role(scope, `${id}Role`, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
    resources: [cdk.Fn.join('', [options.logGroup.logGroupArn, ':*'])],
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: options.action.split(':')[1],
    actions: [options.action],
    resources: options.resources,
  }));
  return new nodejs.NodejsFunction(scope, id, {
    role,
    runtime: lambda.Runtime.NODEJS_22_X,
    entry: path.join(__dirname, 'touchpoint-handler.ts'),
    handler: options.handler,
    functionName: options.functionName,
    logGroup: options.logGroup,
    timeout: cdk.Duration.seconds(10),
    memorySize: 256,
    environment: {
      INSTANCE_ID: options.instanceId,
      CONTACT_FLOW_ID: options.contactFlowId,
      ALLOWED_ORIGIN: options.siteOrigin,
      ...options.environment,
    },
  });
}
