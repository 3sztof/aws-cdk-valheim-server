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

    this.controlFunction = new lambda.Function(this, 'ControlFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/control')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        INSTANCE_ID: instanceId,
        DISCORD_WEBHOOK_PARAM: config.discord.enabled ? config.discord.webhookParameterName : '',
        NOTIFY_ON_START: config.discord.notifyOnStart ? 'true' : 'false',
        NOTIFY_ON_STOP: config.discord.notifyOnStop ? 'true' : 'false',
        // Set after setupCustomDomain() runs; empty string when domain is not configured.
        CONTROL_BASE_URL: config.domain?.enabled
          ? `https://${config.domain.subdomain ? config.domain.subdomain + '.' : ''}${config.domain.hostedZoneName}/valheim/server/`
          : '',
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
      { id: 'AwsSolutions-IAM5', reason: 'ec2:DescribeInstances and ssm:GetCommandInvocation require wildcard resource', appliesTo: ['Resource::*'] },
      { id: 'AwsSolutions-L1', reason: 'PYTHON_3_13 is the latest available runtime; cdk-nag may not recognize it yet' },
    ], true);

    const apiLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.RestApi(this, 'ControlApi', {
      restApiName: 'Valheim Server Control',
      description: 'API for controlling Valheim server',
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

    // Regional certificate (same region as stack - no us-east-1 cross-region requirement).
    const certificate = new acm.Certificate(this, 'ApiCertificate', {
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

    // Map /valheim path prefix on the custom domain to the prod stage.
    new apigateway.BasePathMapping(this, 'BasePathMapping', {
      domainName: customDomain,
      restApi: this.api,
      stage: this.api.deploymentStage,
      basePath: 'valheim',
    });

    // Route53 alias A record pointing the domain at the API Gateway regional endpoint.
    new route53.ARecord(this, 'ApiAliasRecord', {
      zone: hostedZone,
      recordName: domainCfg.subdomain || '',
      target: route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayDomain(customDomain),
      ),
    });

    this.customDomainBaseUrl = `https://${fqdn}/valheim/server/`;

    new cdk.CfnOutput(this, 'CustomDomainStart', {
      value: `https://${fqdn}/valheim/server/start`,
      description: 'Custom domain URL - start the server',
    });
    new cdk.CfnOutput(this, 'CustomDomainStop', {
      value: `https://${fqdn}/valheim/server/stop`,
      description: 'Custom domain URL - stop the server',
    });
    new cdk.CfnOutput(this, 'CustomDomainStatus', {
      value: `https://${fqdn}/valheim/server/status`,
      description: 'Custom domain URL - server status',
    });
    new cdk.CfnOutput(this, 'CustomDomainUrl', {
      value: this.customDomainBaseUrl,
      description: 'Custom domain base URL for server control',
    });
  }
}
