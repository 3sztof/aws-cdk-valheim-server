import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { ValheimConfig } from '../config';

export interface ServerControlProps {
  config: ValheimConfig;
  instanceId: string;
}

export class ServerControl extends Construct {
  public readonly controlFunction: lambda.Function;
  public readonly api: apigateway.RestApi;
  // Set when domain.enabled=true; undefined otherwise.
  public customDomainBaseUrl: string | undefined;

  constructor(scope: Construct, id: string, props: ServerControlProps) {
    super(scope, id);

    const { config, instanceId } = props;

    // Lambda layer: aws-lambda-powertools installed via uv into lambda/control/layer/python/.
    // CDK local bundling runs uv at synth time; the output is zipped as the layer asset.
    const powertoolsLayer = new lambda.LayerVersion(this, 'PowertoolsLayer', {
      layerVersionName: 'valheim-control-powertools',
      description: 'aws-lambda-powertools for valheim-control (built by uv)',
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_13],
      compatibleArchitectures: [lambda.Architecture.X86_64],
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/control'), {
        bundling: {
          // Placeholder image - local bundler always runs first; Docker path is never used.
          image: cdk.DockerImage.fromRegistry('public.ecr.aws/amazonlinux/amazonlinux:2023'),
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const { spawnSync } = require('child_process');
                const fs = require('fs');
                const os = require('os');
                const uvWhich = spawnSync('which', ['uv'], { encoding: 'utf8' });
                if (uvWhich.status !== 0 || !uvWhich.stdout.trim()) throw new Error('uv not found in PATH');
                const uv = uvWhich.stdout.trim();

                const src = path.join(__dirname, '../../lambda/control');
                const exportResult = spawnSync(
                  uv, ['export', '--frozen', '--no-dev', '--no-emit-project', '--no-hashes', '--no-annotate', '--color', 'never'],
                  { cwd: src, encoding: 'utf8' },
                );
                if (exportResult.error) throw exportResult.error;
                if (exportResult.status !== 0) throw new Error('uv export failed: ' + exportResult.stderr);
                const reqs = exportResult.stdout.split('\n').filter((l: string) => l.trim() && !l.startsWith('#')).join('\n');
                // Write requirements to a temp file - avoids /dev/stdin issues in ts-node subprocess.
                const reqsFile = path.join(os.tmpdir(), 'cdk-layer-control-reqs.txt');
                fs.writeFileSync(reqsFile, reqs, 'utf8');
                fs.mkdirSync(`${outputDir}/python`, { recursive: true });
                const installResult = spawnSync(
                  uv, ['pip', 'install', '--no-cache', '--python', '3.13', '-r', reqsFile, '--target', `${outputDir}/python`],
                  { cwd: src, encoding: 'utf8' },
                );
                if (installResult.stdout) process.stdout.write(installResult.stdout);
                if (installResult.stderr) process.stderr.write(installResult.stderr);
                if (installResult.error) throw installResult.error;
                if (installResult.status !== 0) throw new Error('uv pip install failed (status ' + installResult.status + ')');
                return true;
              } catch (_e) {
                process.stderr.write('control layer tryBundle error: ' + (_e as Error).message + '\n');
                return false;
              }
            },
          },
        },
      }),
    });

    this.controlFunction = new lambda.Function(this, 'ControlFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/control')),
      timeout: cdk.Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      layers: [powertoolsLayer],
      environment: {
        INSTANCE_ID: instanceId,
        DISCORD_WEBHOOK_PARAM: config.discord.enabled ? config.discord.webhookParameterName : '',
        NOTIFY_ON_START: config.discord.notifyOnStart ? 'true' : 'false',
        NOTIFY_ON_STOP: config.discord.notifyOnStop ? 'true' : 'false',
        // Set after setupCustomDomain() runs; empty string when domain is not configured.
        CONTROL_BASE_URL: config.domain?.enabled
          ? `https://${config.domain.subdomain ? config.domain.subdomain + '.' : ''}${config.domain.hostedZoneName}/server/`
          : '',
        // Powertools configuration
        POWERTOOLS_SERVICE_NAME: 'valheim-control',
        POWERTOOLS_METRICS_NAMESPACE: 'ValheimServer',
        LOG_LEVEL: 'INFO',
      },
    });

    this.controlFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:StartInstances',
        'ec2:StopInstances',
      ],
      resources: [`arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:instance/${instanceId}`],
    }));

    this.controlFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances', 'ec2:DescribeInstanceStatus'],
      resources: ['*'],
    }));

    this.controlFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [
        `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:instance/${instanceId}`,
        `arn:aws:ssm:${cdk.Stack.of(this).region}::document/AWS-RunShellScript`,
      ],
    }));

    this.controlFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));

    if (config.discord.enabled) {
      this.controlFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${config.discord.webhookParameterName}`,
        ],
      }));
    }

    NagSuppressions.addResourceSuppressions(this.controlFunction, [
      { id: 'AwsSolutions-IAM4', reason: 'Lambda basic execution role is required for CloudWatch Logs', appliesTo: [
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      ]},
      { id: 'AwsSolutions-IAM5', reason: 'ec2:DescribeInstances and ssm:GetCommandInvocation require wildcard resource; X-Ray PutTraceSegments/PutTelemetryRecords require wildcard', appliesTo: ['Resource::*'] },
      { id: 'AwsSolutions-L1', reason: 'PYTHON_3_13 is the latest available runtime; cdk-nag may not recognize it yet' },
    ], true);

    const apiLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.RestApi(this, 'ControlApi', {
      restApiName: 'Valheim Server Control',
      description: 'API for controlling Valheim server',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(apiLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
    });

    const serverResource = this.api.root.addResource('server');

    serverResource.addResource('start').addMethod('GET',
      new apigateway.LambdaIntegration(this.controlFunction));

    serverResource.addResource('stop').addMethod('GET',
      new apigateway.LambdaIntegration(this.controlFunction));

    serverResource.addResource('status').addMethod('GET',
      new apigateway.LambdaIntegration(this.controlFunction));

    NagSuppressions.addResourceSuppressions(this.api, [
      { id: 'AwsSolutions-APIG2', reason: 'Request validation is handled in Lambda function code' },
      { id: 'AwsSolutions-APIG3', reason: 'WAF is unnecessary for a personal game server control API' },
      { id: 'AwsSolutions-APIG4', reason: 'Auth removed for ease of use on personal game server' },
      { id: 'AwsSolutions-COG4', reason: 'Auth removed for ease of use on personal game server' },
    ], true);

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'Server control API URL',
    });

    if (config.domain?.enabled) {
      this.setupCustomDomain(config);
    }
  }

  private setupCustomDomain(config: ValheimConfig): void {
    const domainCfg = config.domain!;
    const fqdn = domainCfg.subdomain
      ? `${domainCfg.subdomain}.${domainCfg.hostedZoneName}`
      : domainCfg.hostedZoneName;

    const hostedZone = domainCfg.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
          hostedZoneId: domainCfg.hostedZoneId,
          zoneName: domainCfg.hostedZoneName,
        })
      : route53.HostedZone.fromLookup(this, 'HostedZone', {
          domainName: domainCfg.hostedZoneName,
          privateZone: false,
        });

    // Certificate: import existing one by ARN if provided (unmanaged - CDK will not
    // create or delete it). Fall back to creating a new DNS-validated cert otherwise.
    const certificate = domainCfg.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'ApiCertificate', domainCfg.certificateArn)
      : new acm.Certificate(this, 'ApiCertificate', {
          domainName: fqdn,
          validation: acm.CertificateValidation.fromDns(hostedZone),
        });

    // Regional custom domain - keeps cert co-located with the API.
    const customDomain = new apigateway.DomainName(this, 'CustomDomain', {
      domainName: fqdn,
      certificate,
      endpointType: apigateway.EndpointType.REGIONAL,
      securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
    });

    // Map to the root path on the custom domain (no prefix).
    new apigateway.BasePathMapping(this, 'BasePathMapping', {
      domainName: customDomain,
      restApi: this.api,
      stage: this.api.deploymentStage,
      basePath: '',
    });

    // Route53 alias A record pointing the domain at the API Gateway regional endpoint.
    new route53.ARecord(this, 'ApiAliasRecord', {
      zone: hostedZone,
      recordName: domainCfg.subdomain || '',
      target: route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayDomain(customDomain),
      ),
    });

    this.customDomainBaseUrl = `https://${fqdn}/server/`;

    new cdk.CfnOutput(this, 'CustomDomainStart', {
      value: `https://${fqdn}/server/start`,
      description: 'Custom domain URL - start the server',
    });
    new cdk.CfnOutput(this, 'CustomDomainStop', {
      value: `https://${fqdn}/server/stop`,
      description: 'Custom domain URL - stop the server',
    });
    new cdk.CfnOutput(this, 'CustomDomainStatus', {
      value: `https://${fqdn}/server/status`,
      description: 'Custom domain URL - server status',
    });
    new cdk.CfnOutput(this, 'CustomDomainUrl', {
      value: this.customDomainBaseUrl,
      description: 'Custom domain base URL for server control',
    });
  }
}
