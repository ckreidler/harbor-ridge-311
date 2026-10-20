import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

export function stageWebsite(): string {
  const root = path.join(__dirname, '..');
  execFileSync(process.execPath, [path.join(root, 'scripts/build-site.mjs')], {
    cwd: root,
  });
  return path.join(root, '.website-build');
}

export class WebsiteStack extends cdk.Stack {
  readonly siteBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly siteOrigin: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
    });

    const bucketOrigin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: 'Harbor Ridge 311 static site',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: bucketOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      additionalBehaviors: {
        '/config.js': {
          origin: bucketOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          compress: true,
        },
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
        },
      ],
    });

    const deployLogs = new logs.LogGroup(this, 'DeploySiteLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(stageWebsite())],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      exclude: ['config.js'],
      logGroup: deployLogs,
    });
    this.siteBucket = siteBucket;
    this.distribution = distribution;
    this.siteOrigin = `https://${distribution.distributionDomainName}`;

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'HTTPS URL of the static site',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution id',
    });
  }
}


