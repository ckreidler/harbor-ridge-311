#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ConnectStack } from '../lib/connect-stack';
import { TouchpointStack } from '../lib/touchpoint-stack';
import { WebsiteStack } from '../lib/website-stack';

const app = new cdk.App();
const website = new WebsiteStack(app, 'WebsiteStack');
const connect = new ConnectStack(app, 'ConnectStack');
const touchpoint = new TouchpointStack(app, 'TouchpointStack', {
  siteBucket: website.siteBucket,
  distribution: website.distribution,
  siteOrigin: website.siteOrigin,
});
touchpoint.addStackDependency(connect);
touchpoint.addStackDependency(website);
