import * as path from 'node:path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as appintegrations from 'aws-cdk-lib/aws-appintegrations';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import { ticketOpenApiDocument } from './openapi';
import { TICKET_API_STAGE, TICKET_GATEWAY_NAME, TICKET_TARGET_NAME } from './tools';

const MCP_VERSION = '2025-03-26';

export interface TicketSystem {
  readonly lambdaArn: string;
  readonly gatewayIdentifier: string;
  readonly target: bedrockagentcore.CfnGatewayTarget;
  readonly applicationIntegration: connect.CfnIntegrationAssociation;
  readonly lambdaIntegration: connect.CfnIntegrationAssociation;
}

function executeArn(stack: cdk.Stack, apiId: string, methodAndPath: string): string {
  return stack.formatArn({
    service: 'execute-api',
    resource: apiId,
    resourceName: `${TICKET_API_STAGE}/${methodAndPath}`,
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
  const document = ticketOpenApiDocument();
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

function lambdaFunction(
  stack: cdk.Stack,
  id: string,
  functionName: string,
  entry: string,
): nodejs.NodejsFunction {
  const logGroup = new logs.LogGroup(stack, `${id}LogGroup`, {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const role = new iam.Role(stack, `${id}Role`, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
    resources: [cdk.Fn.join('', [logGroup.logGroupArn, ':*'])],
  }));
  return new nodejs.NodejsFunction(stack, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    entry,
    handler: 'handler',
    timeout: cdk.Duration.seconds(10),
    functionName,
    logGroup,
    role,
    bundling: { externalModules: [] },
  });
}

export function addTickets(stack: cdk.Stack, instanceArn: string, instanceId: string): TicketSystem {
  const table = new dynamodb.Table(stack, 'Tickets', {
    tableName: 'HarborRidge311Tickets',
    partitionKey: { name: 'ticketId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  table.addGlobalSecondaryIndex({
    indexName: 'ByCustomer',
    partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  const ticketFunction = lambdaFunction(
    stack,
    'TicketApiHandler',
    'HarborRidge311-Tickets',
    path.join(__dirname, 'handler.ts'),
  );
  ticketFunction.addEnvironment('TICKET_TABLE_NAME', table.tableName);
  ticketFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
    resources: [table.tableArn, cdk.Fn.join('', [table.tableArn, '/index/ByCustomer'])],
  }));
  ticketFunction.addPermission('AllowConnectInvoke', {
    principal: new iam.ServicePrincipal('connect.amazonaws.com'),
    sourceArn: instanceArn,
  });

  const api = new apigateway.SpecRestApi(stack, 'TicketApi', {
    restApiName: 'HarborRidge311Tickets',
    apiDefinition: apigateway.ApiDefinition.fromInline(deployedApiDefinition(ticketFunction.functionArn)),
    deployOptions: {
      stageName: TICKET_API_STAGE,
      throttlingRateLimit: 5,
      throttlingBurstLimit: 10,
    },
  });
  for (const [id, methodAndPath] of [
    ['GetTickets', 'GET/tickets'],
    ['PostTickets', 'POST/tickets'],
    ['GetOneTicket', 'GET/tickets/*'],
    ['PostOneTicket', 'POST/tickets/*'],
    ['PostCloseTicket', 'POST/tickets/*/close'],
  ] as const) {
    ticketFunction.addPermission(`AllowApi${id}`, {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: executeArn(stack, api.restApiId, methodAndPath),
    });
  }

  const discovery = new cr.AwsCustomResource(stack, 'TicketDiscoveryUrl', {
    installLatestAwsSdk: false,
    onCreate: {
      service: 'connect',
      action: 'describeInstance',
      parameters: { InstanceId: instanceId },
      physicalResourceId: cr.PhysicalResourceId.of(instanceId),
    },
    onUpdate: {
      service: 'connect',
      action: 'describeInstance',
      parameters: { InstanceId: instanceId },
      physicalResourceId: cr.PhysicalResourceId.of(instanceId),
    },
    policy: cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: ['connect:DescribeInstance'],
        resources: [instanceArn],
      }),
    ]),
  });
  const discoveryUrl = cdk.Fn.join('', [
    'https://',
    discovery.getResponseField('Instance.InstanceAlias'),
    '.my.connect.aws/.well-known/openid-configuration',
  ]);

  const interceptor = lambdaFunction(
    stack,
    'TicketIdentity',
    'HarborRidge311-TicketIdentity',
    path.join(__dirname, 'interceptor.ts'),
  );
  interceptor.addToRolePolicy(new iam.PolicyStatement({
    actions: ['connect:GetContactAttributes'],
    resources: [cdk.Fn.join('', [instanceArn, '/contact/*'])],
  }));

  const gatewayRole = new iam.Role(stack, 'TicketGatewayRole', {
    assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
  });
  gatewayRole.addToPolicy(new iam.PolicyStatement({
    actions: ['execute-api:Invoke'],
    resources: [
      executeArn(stack, api.restApiId, 'GET/tickets'),
      executeArn(stack, api.restApiId, 'POST/tickets'),
      executeArn(stack, api.restApiId, 'GET/tickets/*'),
      executeArn(stack, api.restApiId, 'POST/tickets/*'),
      executeArn(stack, api.restApiId, 'POST/tickets/*/close'),
    ],
  }));
  gatewayRole.addToPolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [interceptor.functionArn],
  }));

  const interceptors = [{
    interceptionPoints: ['REQUEST'],
    interceptor: { lambda: { arn: interceptor.functionArn } },
    inputConfiguration: { passRequestHeaders: false },
  }];
  const gatewayConfig = {
    name: TICKET_GATEWAY_NAME,
    description: 'Harbor Ridge 311 ticket tools',
    protocolType: 'MCP',
    authorizerType: 'CUSTOM_JWT',
    roleArn: gatewayRole.roleArn,
    protocolConfiguration: {
      mcp: {
        supportedVersions: [MCP_VERSION],
        instructions: 'Harbor Ridge 311 tickets for the signed-in customer.',
      },
    },
    authorizerConfiguration: {
      customJwtAuthorizer: {
        discoveryUrl,
        allowedAudience: [discoveryUrl],
      },
    },
    interceptorConfigurations: interceptors,
  };
  const gateway = new bedrockagentcore.CfnGateway(stack, 'TicketGateway', gatewayConfig);
  interceptor.addPermission('AllowThisGateway', {
    principal: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    sourceArn: gateway.attrGatewayArn,
  });
  const audienceCall: cr.AwsSdkCall = {
    service: 'bedrock-agentcore-control',
    action: 'updateGateway',
    parameters: {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: gatewayConfig.name,
      roleArn: gatewayConfig.roleArn,
      authorizerType: gatewayConfig.authorizerType,
      protocolType: gatewayConfig.protocolType,
      description: gatewayConfig.description,
      protocolConfiguration: gatewayConfig.protocolConfiguration,
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl,
          allowedAudience: [gateway.attrGatewayIdentifier],
        },
      },
      interceptorConfigurations: gatewayConfig.interceptorConfigurations,
      gatewayConfigHash: cdk.Fn.toJsonString(gatewayConfig),
    },
    physicalResourceId: cr.PhysicalResourceId.of(gateway.attrGatewayIdentifier),
  };
  const audience = new cr.AwsCustomResource(stack, 'TicketGatewayAudience', {
    installLatestAwsSdk: true,
    timeout: cdk.Duration.minutes(5),
    onCreate: audienceCall,
    onUpdate: audienceCall,
    policy: cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:UpdateGateway'],
        resources: [gateway.attrGatewayArn],
      }),
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [gatewayRole.roleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' },
        },
      }),
    ]),
  });
  audience.node.addDependency(gateway);

  const target = new bedrockagentcore.CfnGatewayTarget(stack, 'TicketTarget', {
    gatewayIdentifier: gateway.attrGatewayIdentifier,
    name: TICKET_TARGET_NAME,
    description: 'Harbor Ridge 311 ticket API',
    credentialProviderConfigurations: [{
      credentialProviderType: 'GATEWAY_IAM_ROLE',
      credentialProvider: {
        iamCredentialProvider: { service: 'execute-api' },
      },
    }],
    targetConfiguration: {
      mcp: {
        apiGateway: {
          restApiId: api.restApiId,
          stage: TICKET_API_STAGE,
          apiGatewayToolConfiguration: {
            toolFilters: [
              { filterPath: '/tickets', methods: ['GET', 'POST'] },
              { filterPath: '/tickets/{ticketId}', methods: ['GET', 'POST'] },
              { filterPath: '/tickets/{ticketId}/close', methods: ['POST'] },
            ],
          },
        },
      },
    },
  });
  target.node.addDependency(api, audience);

  const application = new appintegrations.CfnApplication(stack, 'TicketApplication', {
    name: 'HarborRidge311Tickets',
    description: 'Ticket tools for the Harbor Ridge 311 assistant',
    namespace: gateway.attrGatewayIdentifier,
    applicationType: 'MCP_SERVER',
    applicationSourceConfig: {
      externalUrlConfig: { accessUrl: gateway.attrGatewayUrl },
    },
  });
  const applicationIntegration = new connect.CfnIntegrationAssociation(stack, 'TicketApplicationIntegration', {
    instanceId: instanceArn,
    integrationType: 'APPLICATION',
    integrationArn: application.attrApplicationArn,
  });
  applicationIntegration.node.addDependency(audience);
  const lambdaIntegration = new connect.CfnIntegrationAssociation(stack, 'TicketLambdaIntegration', {
    instanceId: instanceArn,
    integrationType: 'LAMBDA_FUNCTION',
    integrationArn: ticketFunction.functionArn,
  });
  lambdaIntegration.node.addDependency(ticketFunction);

  return {
    lambdaArn: ticketFunction.functionArn,
    gatewayIdentifier: gateway.attrGatewayIdentifier,
    target,
    applicationIntegration,
    lambdaIntegration,
  };
}
