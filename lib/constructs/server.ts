import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import { ValheimConfig } from '../config';

export interface ValheimServerProps {
  config: ValheimConfig;
  vpc: ec2.IVpc;
  backupBucket: s3.IBucket;
  controlBaseUrl: string;
}
export class ValheimServer extends Construct {
  public readonly instance: ec2.CfnInstance;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly role: iam.Role;
  public readonly publicIp: string;

  constructor(scope: Construct, id: string, props: ValheimServerProps) {
    super(scope, id);

    const { config, vpc, backupBucket, controlBaseUrl } = props;

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      description: `${config.workloadName} server security group`,
      allowAllOutbound: true,
    });

    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udpRange(2456, 2458),
      `${config.workloadName} game ports`
    );

    NagSuppressions.addResourceSuppressions(this.securityGroup, [
      { id: 'AwsSolutions-EC23', reason: 'Valheim game server requires public UDP ports 2456-2458 for player connections' },
    ]);

    this.role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    backupBucket.grantReadWrite(this.role);

    if (config.discord.enabled) {
      this.role.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${config.discord.webhookParameterName}`,
        ],
      }));
    }

    NagSuppressions.addResourceSuppressions(this.role, [
      { id: 'AwsSolutions-IAM4', reason: 'SSM and CloudWatch managed policies are required for EC2 instance management via Session Manager and monitoring', appliesTo: [
        'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore',
        'Policy::arn:<AWS::Partition>:iam::aws:policy/CloudWatchAgentServerPolicy',
      ]},
    ]);

    NagSuppressions.addResourceSuppressions(this.role, [
      { id: 'AwsSolutions-IAM5', reason: 'S3 grantReadWrite requires wildcard actions for backup operations (list, get, put, delete on bucket objects)', appliesTo: [
        'Action::s3:Abort*',
        'Action::s3:DeleteObject*',
        'Action::s3:GetBucket*',
        'Action::s3:GetObject*',
        'Action::s3:List*',
        `Resource::<BackupBucketBC94E555.Arn>/*`,
      ]},
    ], true);

    const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
      roles: [this.role.roleName],
    });

    const serverPassword = config.server.password || this.generatePassword();

    new ssm.StringParameter(this, 'ServerPassword', {
      parameterName: `/${config.workloadName}/password`,
      stringValue: serverPassword,
      description: `${config.workloadName} server password`,
      tier: ssm.ParameterTier.STANDARD,
    });

    const eip = new ec2.CfnEIP(this, 'ElasticIP', {
      domain: 'vpc',
      tags: Object.entries(config.tags).map(([key, value]) => ({ key, value })).concat([
        { key: 'Name', value: `${config.workloadName}-${config.server.name}-eip` },
      ]),
    });
    this.publicIp = eip.attrPublicIp;

    const userData = this.generateUserData(config, backupBucket.bucketName, serverPassword, controlBaseUrl, eip.attrPublicIp);

    const amiId = ssm.StringParameter.valueForStringParameter(
      this,
      '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64'
    );

    const subnet = vpc.publicSubnets[0];

    const launchTemplateData: ec2.CfnLaunchTemplate.LaunchTemplateDataProperty = {
      imageId: amiId,
      instanceType: config.instance.type,
      iamInstanceProfile: { arn: instanceProfile.attrArn },
      securityGroupIds: [this.securityGroup.securityGroupId],
      userData: cdk.Fn.base64(userData),
      monitoring: { enabled: true },
      blockDeviceMappings: [{
        deviceName: '/dev/xvda',
        ebs: {
          volumeSize: config.instance.volumeSize,
          volumeType: 'gp3',
          deleteOnTermination: true,
          encrypted: true,
        },
      }],
      metadataOptions: {
        httpTokens: 'required',
        httpEndpoint: 'enabled',
      },
      tagSpecifications: [{
        resourceType: 'instance',
        tags: Object.entries(config.tags).map(([key, value]) => ({ key, value })),
      }, {
        resourceType: 'volume',
        tags: Object.entries(config.tags).map(([key, value]) => ({ key, value })),
      }],
    };

    if (config.instance.useSpot) {
      const spotOptions: ec2.CfnLaunchTemplate.SpotOptionsProperty = {
        spotInstanceType: 'persistent',
        instanceInterruptionBehavior: 'stop',
      };

      if (config.instance.maxSpotPrice > 0) {
        (spotOptions as any).maxPrice = config.instance.maxSpotPrice.toString();
      }

      (launchTemplateData as any).instanceMarketOptions = {
        marketType: 'spot',
        spotOptions,
      };
    }

    const launchTemplate = new ec2.CfnLaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateData,
    });

    this.instance = new ec2.CfnInstance(this, 'Instance', {
      launchTemplate: {
        launchTemplateId: launchTemplate.ref,
        version: launchTemplate.attrLatestVersionNumber,
      },
      subnetId: subnet.subnetId,
      tags: Object.entries(config.tags).map(([key, value]) => ({ key, value })).concat([
        { key: 'Name', value: `${config.workloadName}-${config.server.name}` },
      ]),
    });

    new ec2.CfnEIPAssociation(this, 'ElasticIPAssociation', {
      instanceId: this.instance.ref,
      allocationId: eip.attrAllocationId,
    });

    NagSuppressions.addResourceSuppressions(this.instance, [
      { id: 'AwsSolutions-EC28', reason: 'Detailed monitoring is enabled via launch template monitoring.enabled=true' },
      { id: 'AwsSolutions-EC29', reason: 'Not using ASG or termination protection - CDK manages the instance lifecycle. World data is backed up to S3.' },
    ]);

    new cdk.CfnOutput(this, 'InstanceId', {
      value: this.instance.ref,
      description: `${config.workloadName} server EC2 instance ID`,
    });
  }

  private generateUserData(config: ValheimConfig, bucketName: string, password: string, controlBaseUrl: string, publicIp: string): string {
    const templatePath = path.join(__dirname, 'userdata', 'setup.sh');
    let script = fs.readFileSync(templatePath, 'utf8');

    const replacements: Record<string, string> = {
      '${SERVER_NAME}': config.server.name,
      '${WORLD_NAME}': config.server.world,
      '${SERVER_PASSWORD}': password,
      '${SERVER_PUBLIC}': config.server.public ? '1' : '0',
      '${CROSSPLAY}': config.server.crossplay ? 'true' : 'false',
      '${ADMIN_STEAM_IDS}': (config.server.adminSteamIds || []).join(' '),
      '${BANNED_STEAM_IDS}': (config.server.bannedSteamIds || []).join(' '),
      '${PERMITTED_STEAM_IDS}': (config.server.permittedSteamIds || []).join(' '),
      '${BACKUP_BUCKET}': bucketName,
      '${DISCORD_WEBHOOK_PARAM}': config.discord.enabled ? config.discord.webhookParameterName : '',
      '${BACKUP_CRON}': config.backup.schedule,
      '${CONTROL_BASE_URL}': controlBaseUrl,
      '${SERVER_PUBLIC_IP}': publicIp,
      '${WORKLOAD_NAME}': config.workloadName,
    };

    for (const [placeholder, value] of Object.entries(replacements)) {
      script = script.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
    }

    return script;
  }

  private generatePassword(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let password = '';
    for (let i = 0; i < 16; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }
}
