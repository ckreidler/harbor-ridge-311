#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { WebsiteStack } from '../lib/website-stack';

const app = new cdk.App();
new WebsiteStack(app, 'WebsiteStack');
