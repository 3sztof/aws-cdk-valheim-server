import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as appregistry from 'aws-cdk-lib/aws-servicecatalogappregistry';
import { Construct } from 'constructs';
import { ValheimConfig } from './config';
import { ValheimServer } from './constructs/server';
import { BackupBucket } from './constructs/backup';
import { ServerControl } from './constructs/control';
import { AutoShutdown } from './constructs/auto-shutdown';
import { BudgetAlert } from './constructs/budget';

export interface ValheimServerStackProps extends cdk.StackProps {
  config: ValheimConfig;
}

export class ValheimServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ValheimServerStackProps) {
    super(scope, id, props);

    const { config } = props;

    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    // Register this stack as an AWS myApplications application so it appears
    // in the AWS Console > Applications view and enables per-application cost
    // tracking in Cost Explorer.
    const appRegistryApp = new appregistry.CfnApplication(this, 'AppRegistryApplication', {
      name: config.tags.Project,
      description: `${config.workloadName} dedicated server - ${config.server.name}`,
      tags: {
        ...config.tags,
      },
    });

    // Explicitly apply the awsApplication tag to all resources in this stack.
    // This is what makes resources visible under the application in the AWS
    // Console myApplications view and Cost Explorer.
    // NOTE: attrApplicationTagKey is always the literal string "awsApplication"
    // (documented by AWS). We use the literal to avoid CDK rejecting a CFN token
    // as a tag key at synth time.
    // NOTE: CfnResourceAssociation(CFN_STACK) is intentionally omitted - it
    // creates a circular dependency (resource references this.stackId which
    // depends on the stack being fully resolved). Tag propagation via Tags.of()
    // is sufficient for myApplications and Cost Explorer visibility.
    cdk.Tags.of(this).add(
      'awsApplication',
      appRegistryApp.attrApplicationTagValue,
    );

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
      availabilityZones: [`${config.instance.region}a`, `${config.instance.region}b`],
      flowLogs: {
        'VpcFlowLog': {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'VpcFlowLogGroup', {
              retention: logs.RetentionDays.ONE_MONTH,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
            })
          ),
          trafficType: ec2.FlowLogTrafficType.REJECT,
        },
      },
    });

    const backupBucket = new BackupBucket(this, 'Backup', { config });

    // Compute the control base URL from config - used in EC2 userdata for Discord hooks.
    // Custom domain URL is deterministic at synth time; API Gateway URL is a deploy-time token
    // and cannot be embedded in userdata. Falls back to empty string (hooks will show no URL).
    const controlBaseUrl = config.domain?.enabled
      ? `https://${config.domain.subdomain ? config.domain.subdomain + '.' : ''}${config.domain.hostedZoneName}/server/`
      : '';

    const server = new ValheimServer(this, 'Server', {
      config,
      vpc,
      backupBucket: backupBucket.bucket,
      controlBaseUrl,
    });

    const control = new ServerControl(this, 'Control', {
      config,
      instanceId: server.instance.ref,
    });

    new AutoShutdown(this, 'AutoShutdown', {
      config,
      instanceId: server.instance.ref,
      controlFunction: control.controlFunction,
    });

    if (config.budget?.enabled) {
      new BudgetAlert(this, 'Budget', { config });
    }

    new cdk.CfnOutput(this, 'ServerPublicIp', {
      value: server.publicIp,
      description: `Static public IP for the ${config.workloadName} server (Elastic IP)`,
    });

    new cdk.CfnOutput(this, 'ServerConnectionInfo', {
      value: `Connect using the public IP from the status endpoint: ${control.api.url}server/status`,
      description: 'How to find server connection info',
    });

    const startUrl = control.customDomainBaseUrl
      ? `${control.customDomainBaseUrl}start`
      : `${control.api.url}server/start`;
    const stopUrl = control.customDomainBaseUrl
      ? `${control.customDomainBaseUrl}stop`
      : `${control.api.url}server/stop`;
    const statusUrl = control.customDomainBaseUrl
      ? `${control.customDomainBaseUrl}status`
      : `${control.api.url}server/status`;
    new cdk.CfnOutput(this, 'StartServerCommand', {
      value: `curl ${startUrl}`,
      description: 'Command to start the server',
    });
    new cdk.CfnOutput(this, 'StopServerCommand', {
      value: `curl ${stopUrl}`,
      description: 'Command to stop the server',
    });

    new cdk.CfnOutput(this, 'StatusServerCommand', {
      value: `curl ${statusUrl}`,
      description: 'Command to check server status',
    });
  }
}
