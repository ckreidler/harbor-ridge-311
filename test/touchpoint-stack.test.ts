import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { ConnectStack, MAIN_CONTACT_FLOW_ARN_PARAMETER, MAIN_CONTACT_FLOW_ID_PARAMETER } from '../lib/connect-stack';
import { TouchpointStack } from '../lib/touchpoint-stack';
import { stageWebsite, WebsiteStack } from '../lib/website-stack';

test('site build bundles the Touchpoint SDK and leaves config.js out', () => {
  const built = stageWebsite();
  const index = fs.readFileSync(path.join(built, 'index.html'), 'utf8');
  expect(index).toMatch(/<script\s+src="\/config\.js"\s*><\/script>/);
  expect(index).not.toContain('touchpoint.umd.js');
  expect(fs.existsSync(path.join(built, 'config.js'))).toBe(false);
  expect(fs.existsSync(path.join(built, 'touchpoint.umd.js'))).toBe(false);
  const notFound = fs.readFileSync(path.join(built, '404.html'), 'utf8');
  expect(notFound).toContain('href="/"');
  for (const html of [index, notFound]) {
    const cssHref = html.match(/href="(\/[^"]+\.css)"/);
    expect(cssHref).not.toBeNull();
    expect(fs.existsSync(path.join(built, cssHref![1].slice(1)))).toBe(true);
  }
  const moduleSrc = index.match(/<script type="module"[^>]*\ssrc="(\/[^"]+\.js)"/);
  expect(moduleSrc).not.toBeNull();
  const bundlePath = path.join(built, moduleSrc![1].slice(1));
  execFileSync(process.execPath, ['--check', bundlePath]);
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  expect(bundle).toContain('Opening chat');
  expect(bundle).toContain('voiceMini');
  expect(bundle).toContain('#0f6e6b');
  expect(bundle).toContain('Harbor Ridge visitor');
  expect(bundle.length).toBeGreaterThan(100_000);
});

test('TouchpointStack publishes throttled chat and voice routes for the main flow', () => {
  const app = new cdk.App();
  const website = new WebsiteStack(app, 'WebsiteStack');
  const connect = new ConnectStack(app, 'ConnectStack');
  const touchpoint = new TouchpointStack(app, 'TouchpointStack', {
    siteBucket: website.siteBucket,
    distribution: website.distribution,
    siteOrigin: website.siteOrigin,
  });
  const template = Template.fromStack(touchpoint);
  const site = Template.fromStack(website);

  const buckets = site.findResources('AWS::S3::Bucket') as Record<string, {
    Properties: Record<string, unknown>;
  }>;
  const siteBuckets = Object.values(buckets);
  expect(siteBuckets).toHaveLength(1);
  expect(siteBuckets[0]?.Properties.PublicAccessBlockConfiguration).toEqual({
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
  expect(siteBuckets[0]?.Properties.WebsiteConfiguration).toBeUndefined();
  site.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  const distributions = site.findResources('AWS::CloudFront::Distribution') as Record<string, {
    Properties: {
      DistributionConfig: { Origins: Array<{ OriginAccessControlId?: unknown; S3OriginConfig?: unknown }> };
    };
  }>;
  const origins = Object.values(distributions)[0]?.Properties.DistributionConfig.Origins ?? [];
  expect(origins[0]?.OriginAccessControlId).toEqual(expect.any(Object));
  expect(origins[0]?.S3OriginConfig).toEqual({ OriginAccessIdentity: '' });
  const bucketPolicies = site.findResources('AWS::S3::BucketPolicy') as Record<string, {
    Properties: {
      PolicyDocument: {
        Statement: Array<{ Effect: string; Principal: unknown; Action: string | string[] }>;
      };
    };
  }>;
  const statements = Object.values(bucketPolicies).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  const publicAllows = statements.filter((statement) => {
    if (statement.Effect !== 'Allow') return false;
    const principal = JSON.stringify(statement.Principal);
    return principal === '"*"' || principal.includes('"*"');
  });
  expect(publicAllows).toEqual([]);
  expect(statements).toEqual(expect.arrayContaining([
    expect.objectContaining({
      Effect: 'Allow',
      Action: 's3:GetObject',
      Principal: { Service: 'cloudfront.amazonaws.com' },
    }),
  ]));

  site.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      CacheBehaviors: Match.arrayWith([
        Match.objectLike({
          PathPattern: '/config.js',
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
        }),
      ]),
    }),
  });

  const deployment = JSON.stringify(site.findResources('Custom::CDKBucketDeployment'));
  expect(deployment).toContain('config.js');
  const siteResources = site.toJSON().Resources as Record<string, { DeletionPolicy?: string; UpdateReplacePolicy?: string }>;
  for (const resource of Object.values(siteResources)) {
    expect(resource.DeletionPolicy).not.toBe('Retain');
    expect(resource.UpdateReplacePolicy).not.toBe('Retain');
  }

  template.hasResourceProperties('AWS::ApiGateway::RestApi', {
    Name: 'HarborRidge311-Touchpoint',
    EndpointConfiguration: { Types: ['REGIONAL'] },
  });
  template.hasResourceProperties('AWS::ApiGateway::Stage', {
    StageName: 'prod',
    MethodSettings: Match.arrayWith([
      Match.objectLike({
        ThrottlingRateLimit: 1,
        ThrottlingBurstLimit: 2,
      }),
    ]),
  });
  const methods = Object.values(template.findResources('AWS::ApiGateway::Method')) as Array<{
    Properties: { HttpMethod: string };
  }>;
  expect(methods.map((method) => method.Properties.HttpMethod).sort()).toEqual([
    'OPTIONS',
    'OPTIONS',
    'OPTIONS',
    'POST',
    'POST',
  ]);
  template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'chat' });
  template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'voice' });

  const resources = template.toJSON().Resources as Record<string, {
    Type: string;
    DeletionPolicy?: string;
    UpdateReplacePolicy?: string;
    Properties?: Record<string, unknown>;
  }>;
  for (const resource of Object.values(resources)) {
    expect(resource.DeletionPolicy).not.toBe('Retain');
    expect(resource.UpdateReplacePolicy).not.toBe('Retain');
  }

  const functions = template.findResources('AWS::Lambda::Function') as Record<string, {
    Properties: {
      FunctionName?: string;
      Environment?: { Variables: Record<string, unknown> };
    };
  }>;
  const chat = Object.values(functions).find((fn) => fn.Properties.FunctionName === 'HarborRidge311-StartChat');
  const voice = Object.values(functions).find((fn) => fn.Properties.FunctionName === 'HarborRidge311-StartWebRtc');
  const instanceId = chat?.Properties.Environment?.Variables.INSTANCE_ID as { Ref: string };
  expect(template.toJSON().Parameters[instanceId.Ref].Default).toBe('/connect/sandbox/instance-id');
  const connectTemplate = Template.fromStack(connect);
  connectTemplate.hasResourceProperties('AWS::Connect::ContactFlow', {
    Name: 'HarborRidge311-Main',
    Type: 'CONTACT_FLOW',
  });
  connectTemplate.hasResourceProperties('AWS::SSM::Parameter', {
    Name: MAIN_CONTACT_FLOW_ID_PARAMETER,
  });
  connectTemplate.hasResourceProperties('AWS::SSM::Parameter', {
    Name: MAIN_CONTACT_FLOW_ARN_PARAMETER,
  });
  const connectResources = connectTemplate.toJSON().Resources as Record<string, {
    DeletionPolicy?: string;
    UpdateReplacePolicy?: string;
    Properties?: { Name?: string };
  }>;
  const publishedFlowParameters = Object.values(connectResources).filter((resource) =>
    resource.Properties?.Name === MAIN_CONTACT_FLOW_ID_PARAMETER
    || resource.Properties?.Name === MAIN_CONTACT_FLOW_ARN_PARAMETER);
  expect(publishedFlowParameters).toHaveLength(2);
  for (const parameter of publishedFlowParameters) {
    expect(parameter.DeletionPolicy).toBe('Delete');
    expect(parameter.UpdateReplacePolicy).not.toBe('Retain');
  }
  const contactFlowId = chat?.Properties.Environment?.Variables.CONTACT_FLOW_ID as { Ref: string };
  expect(template.toJSON().Parameters[contactFlowId.Ref].Default).toBe(MAIN_CONTACT_FLOW_ID_PARAMETER);
  expect(voice?.Properties.Environment?.Variables.CONTACT_FLOW_ID).toEqual(
    chat?.Properties.Environment?.Variables.CONTACT_FLOW_ID,
  );
  expect(JSON.stringify(chat?.Properties.Environment)).toContain('https://');

  const policies = template.findResources('AWS::IAM::Policy') as Record<string, {
    Properties: {
      PolicyDocument: {
        Statement: Array<{ Sid?: string; Action: string | string[]; Resource: unknown }>;
      };
    };
  }>;
  const connectStatements = Object.values(policies).flatMap((policy) =>
    policy.Properties.PolicyDocument.Statement.filter((statement) => {
      const actions = [statement.Action].flat();
      return actions.some((action) => action.startsWith('connect:'));
    }));
  expect(connectStatements.map((statement) => statement.Action).sort()).toEqual([
    'connect:StartChatContact',
    'connect:StartWebRTCContact',
  ]);
  const templateJson = template.toJSON();
  for (const statement of connectStatements) {
    const resourcesForAction = [statement.Resource].flat() as Array<{ Ref?: string }>;
    expect(resourcesForAction).toHaveLength(2);
    expect(JSON.stringify(resourcesForAction)).not.toContain('*');
    const names = resourcesForAction.map((resource) => templateJson.Parameters[resource.Ref ?? ''].Default);
    expect(names).toEqual(expect.arrayContaining([
      '/connect/sandbox/instance-arn',
      MAIN_CONTACT_FLOW_ARN_PARAMETER,
    ]));
  }

  const json = JSON.stringify(templateJson);
  expect(json).toContain('/connect/sandbox/instance-arn');
  expect(json).toContain('config.js');
  expect(json).not.toContain("'*'");
  expect(json).toContain('\'https://');
});
