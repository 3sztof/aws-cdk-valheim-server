import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { LayerVersion } from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { ValheimConfig, toEventBridgeCron } from '../config';

export interface AutoShutdownProps {
  config: ValheimConfig;
  instanceId: string;
  controlFunction: lambda.IFunction;
}

export class AutoShutdown extends Construct {
  public readonly idleAlarm?: cloudwatch.Alarm;
  public readonly scheduledRule?: events.Rule;

  constructor(scope: Construct, id: string, props: AutoShutdownProps) {
    super(scope, id);

    const { config, instanceId, controlFunction } = props;

    if (!config.autoShutdown.enabled) {
      return;
    }

    // AWS Lambda Powertools for Python - managed layer (always latest for this runtime).
    const powertoolsLayer = LayerVersion.fromLayerVersionArn(
      this,
      'PowertoolsLayer',
      `arn:aws:lambda:${cdk.Stack.of(this).region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313:13`,
    );

    const stopLambda = new lambda.Function(this, 'StopFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/auto-shutdown')),
      environment: {
        INSTANCE_ID: instanceId,
        // Powertools configuration
        POWERTOOLS_SERVICE_NAME: 'valheim-autoshutdown',
        POWERTOOLS_METRICS_NAMESPACE: 'ValheimServer',
        LOG_LEVEL: 'INFO',
      },
      tracing: lambda.Tracing.ACTIVE,
      layers: [powertoolsLayer],
      timeout: cdk.Duration.seconds(60),
    });

    stopLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:StopInstances'],
      resources: [`arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:instance/${instanceId}`],
    }));

    stopLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [
        `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:instance/${instanceId}`,
        `arn:aws:ssm:${cdk.Stack.of(this).region}::document/AWS-RunShellScript`,
      ],
    }));

    stopLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));

    NagSuppressions.addResourceSuppressions(stopLambda, [
      { id: 'AwsSolutions-IAM4', reason: 'Lambda basic execution role is required for CloudWatch Logs', appliesTo: [
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      ]},
      { id: 'AwsSolutions-L1', reason: 'PYTHON_3_13 is the latest available runtime; cdk-nag may not recognize it yet' },
      { id: 'AwsSolutions-IAM5', reason: 'ssm:GetCommandInvocation requires wildcard resource - CommandId is not known at policy creation time; X-Ray PutTraceSegments/PutTelemetryRecords require wildcard', appliesTo: ['Resource::*'] },
    ], true);

    this.idleAlarm = new cloudwatch.Alarm(this, 'IdleAlarm', {
      alarmName: 'valheim-server-idle',
      alarmDescription: 'Triggers when Valheim server CPU is below threshold (idle)',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        dimensionsMap: {
          InstanceId: instanceId,
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: config.autoShutdown.cpuThreshold,
      evaluationPeriods: config.autoShutdown.evaluationPeriods,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.idleAlarm.addAlarmAction(new cloudwatchActions.LambdaAction(stopLambda));

    if (config.autoShutdown.scheduledShutdown) {
      this.scheduledRule = new events.Rule(this, 'ScheduledShutdown', {
        schedule: events.Schedule.expression(`cron(${toEventBridgeCron(config.autoShutdown.scheduledShutdown)})`),
        description: 'Scheduled server shutdown',
      });

      this.scheduledRule.addTarget(new targets.LambdaFunction(stopLambda));
    }
  }
}
