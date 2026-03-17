#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ValheimServerStack } from '../lib/valheim-server-stack';
import { loadConfig } from '../lib/config';

const config = loadConfig();

// Derive a PascalCase stack name from the workload name so the CloudFormation
// stack itself carries no hardcoded "valheim" when workload_name is changed.
// e.g. "valheim" -> "ValheimStack", "game-server" -> "GameServerStack"
const stackName = config.workloadName
  .split('-')
  .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
  .join('') + 'Stack';

const app = new cdk.App();
new ValheimServerStack(app, stackName, {
  config,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: config.instance.region,
  },
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
