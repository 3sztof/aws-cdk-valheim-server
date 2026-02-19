import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
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
      { id: 'AwsSolutions-IAM5', reason: 'ec2:DescribeInstances requires wildcard resource', appliesTo: ['Resource::*'] },
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
    
    serverResource.addResource('start').addMethod('POST', 
      new apigateway.LambdaIntegration(this.controlFunction));
    
    serverResource.addResource('stop').addMethod('POST',
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
  }
}
