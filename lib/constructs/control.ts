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
      code: lambda.Code.fromInline(this.getControlLambdaCode()),
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

  private getControlLambdaCode(): string {
    return `
import boto3
import json
import os
import urllib.request

ec2 = boto3.client('ec2')
ssm = boto3.client('ssm')

INSTANCE_ID = os.environ['INSTANCE_ID']
DISCORD_WEBHOOK_PARAM = os.environ.get('DISCORD_WEBHOOK_PARAM', '')
NOTIFY_ON_START = os.environ.get('NOTIFY_ON_START', 'false') == 'true'
NOTIFY_ON_STOP = os.environ.get('NOTIFY_ON_STOP', 'false') == 'true'

def send_discord_notification(message, color=3447003):
    if not DISCORD_WEBHOOK_PARAM:
        return
    
    try:
        webhook_url = ssm.get_parameter(
            Name=DISCORD_WEBHOOK_PARAM,
            WithDecryption=True
        )['Parameter']['Value']
        
        payload = {
            'embeds': [{
                'title': 'Valheim Server',
                'description': message,
                'color': color
            }]
        }
        
        req = urllib.request.Request(
            webhook_url,
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        urllib.request.urlopen(req)
    except Exception as e:
        print(f'Discord notification failed: {e}')

def get_instance_status():
    response = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
    instance = response['Reservations'][0]['Instances'][0]
    state = instance['State']['Name']
    public_ip = instance.get('PublicIpAddress', 'N/A')
    return {'state': state, 'publicIp': public_ip, 'instanceId': INSTANCE_ID}

def handler(event, context):
    path = event.get('path', '')
    method = event.get('httpMethod', '')
    
    try:
        if '/start' in path and method == 'POST':
            ec2.start_instances(InstanceIds=[INSTANCE_ID])
            if NOTIFY_ON_START:
                send_discord_notification('Server is starting...', 3066993)
            return response(200, {'message': 'Server starting', 'instanceId': INSTANCE_ID})
        
        elif '/stop' in path and method == 'POST':
            ec2.stop_instances(InstanceIds=[INSTANCE_ID])
            if NOTIFY_ON_STOP:
                send_discord_notification('Server is stopping...', 15158332)
            return response(200, {'message': 'Server stopping', 'instanceId': INSTANCE_ID})
        
        elif '/status' in path and method == 'GET':
            status = get_instance_status()
            return response(200, status)
        
        else:
            return response(400, {'error': 'Unknown action'})
    
    except Exception as e:
        return response(500, {'error': str(e)})

def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        'body': json.dumps(body)
    }
`;
  }
}
