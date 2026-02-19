#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ValheimServerStack } from '../lib/valheim-server-stack';
import { loadConfig } from '../lib/config';

const config = loadConfig();

const app = new cdk.App();
new ValheimServerStack(app, 'ValheimServerStack', {
  config,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: config.instance.region,
  },
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
