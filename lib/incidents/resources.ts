import * as path from 'node:path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { incidentOpenApiDocument } from './openapi';
import { INCIDENT_API_STAGE, INCIDENT_TARGET_NAME } from './tools';

export interface IncidentSystem {
  readonly target: bedrockagentcore.CfnGatewayTarget;
  readonly topicArn: string;
}

export interface IncidentResourcesProps {
  readonly instanceArn: string;
  readonly instanceId: string;
  readonly contactFlowArn: string;
  readonly queueArn: string;
  readonly gatewayIdentifier: string;
  readonly gatewayRole: iam.Role;
  readonly gatewayReady: Construct;
}

function executeArn(stack: cdk.Stack, apiId: string, methodAndPath: string): string {
  return stack.formatArn({
    service: 'execute-api',
    resource: apiId,
    resourceName: `${INCIDENT_API_STAGE}/${methodAndPath}`,
  });
}

function lambdaProxyUri(lambdaArn: string): string {
  return cdk.Fn.join('', [
    'arn:',
    cdk.Aws.PARTITION,
    ':apigateway:',
    cdk.Aws.REGION,
    ':lambda:path/2015-03-31/functions/',
    lambdaArn,
    '/invocations',
  ]);
}

function deployedApiDefinition(lambdaArn: string): { [key: string]: unknown } {
  const document = incidentOpenApiDocument();
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
  const deployedPaths: Record<string, Record<string, unknown>> = {};
  for (const [route, methods] of Object.entries(paths)) {
    const deployedMethods: Record<string, unknown> = {};
    for (const [method, operation] of Object.entries(methods)) {
      deployedMethods[method] = {
        ...operation,
        security: [{ sigv4: [] }],
        'x-amazon-apigateway-integration': {
          type: 'aws_proxy',
          httpMethod: 'POST',
          uri: lambdaProxyUri(lambdaArn),
          passthroughBehavior: 'when_no_match',
        },
      };
    }
    deployedPaths[route] = deployedMethods;
  }
  const components = document.components as Record<string, unknown>;
  return {
    ...document,
    paths: deployedPaths,
    components: {
      ...components,
      securitySchemes: {
        sigv4: {
          type: 'apiKey',
          name: 'Authorization',
          in: 'header',
          'x-amazon-apigateway-authtype': 'awsSigv4',
        },
      },
    },
  };
}

export function addIncidents(stack: cdk.Stack, props: IncidentResourcesProps): IncidentSystem {
  const topic = new sns.Topic(stack, 'MajorIncidentsTopic', {
    topicName: 'HarborRidge311-MajorIncidents',
    displayName: 'Harbor Ridge 311 major incidents',
  });
  topic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

  const functionName = 'HarborRidge311-MajorIncidents';
  const logGroup = new logs.LogGroup(stack, 'IncidentApiHandlerLogGroup', {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const role = new iam.Role(stack, 'IncidentApiHandlerRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
    resources: [cdk.Fn.join('', [logGroup.logGroupArn, ':*'])],
  }));
  const contactFlowId = cdk.Fn.select(3, cdk.Fn.split('/', props.contactFlowArn));
  const incidentFunction = new nodejs.NodejsFunction(stack, 'IncidentApiHandler', {
    runtime: lambda.Runtime.NODEJS_22_X,
    entry: path.join(__dirname, 'handler.ts'),
    handler: 'handler',
    timeout: cdk.Duration.seconds(10),
    functionName,
    logGroup,
    role,
    bundling: { externalModules: [] },
    environment: {
      CONNECT_INSTANCE_ID: props.instanceId,
      CONTACT_FLOW_ID: contactFlowId,
      INCIDENT_TOPIC_ARN: topic.topicArn,
    },
  });
  incidentFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['connect:StartTaskContact'],
    resources: [props.instanceArn, props.contactFlowArn, props.queueArn],
  }));
  incidentFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['sns:Publish'],
    resources: [topic.topicArn],
  }));

  const api = new apigateway.SpecRestApi(stack, 'IncidentApi', {
    restApiName: 'HarborRidge311Incidents',
    apiDefinition: apigateway.ApiDefinition.fromInline(deployedApiDefinition(incidentFunction.functionArn)),
    deployOptions: {
      stageName: INCIDENT_API_STAGE,
      throttlingRateLimit: 5,
      throttlingBurstLimit: 10,
    },
  });
  incidentFunction.addPermission('AllowApiPostIncidents', {
    principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    sourceArn: executeArn(stack, api.restApiId, 'POST/incidents'),
  });
  props.gatewayRole.addToPolicy(new iam.PolicyStatement({
    actions: ['execute-api:Invoke'],
    resources: [executeArn(stack, api.restApiId, 'POST/incidents')],
  }));

  const target = new bedrockagentcore.CfnGatewayTarget(stack, 'IncidentTarget', {
    gatewayIdentifier: props.gatewayIdentifier,
    name: INCIDENT_TARGET_NAME,
    description: 'Harbor Ridge 311 major incident reports',
    credentialProviderConfigurations: [{
      credentialProviderType: 'GATEWAY_IAM_ROLE',
    }],
    targetConfiguration: {
      mcp: {
        apiGateway: {
          restApiId: api.restApiId,
          stage: INCIDENT_API_STAGE,
          apiGatewayToolConfiguration: {
            toolFilters: [
              { filterPath: '/incidents', methods: ['POST'] },
            ],
          },
        },
      },
    },
  });
  target.node.addDependency(api, props.gatewayReady);

  return {
    target,
    topicArn: topic.topicArn,
  };
}
