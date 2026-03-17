import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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

    // Lambda layer: aws-lambda-powertools installed via uv into lambda/auto-shutdown/layer/python/.
    // CDK local bundling runs uv at synth time; the output is zipped as the layer asset.
    const powertoolsLayer = new lambda.LayerVersion(this, 'PowertoolsLayer', {
      layerVersionName: `${config.workloadName}-autoshutdown-powertools`,
      description: `aws-lambda-powertools for ${config.workloadName}-autoshutdown (built by uv)`,
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_13],
      compatibleArchitectures: [lambda.Architecture.X86_64],
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/auto-shutdown'), {
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
                const src = path.join(__dirname, '../../lambda/auto-shutdown');
                const exportResult = spawnSync(
                  uv, ['export', '--frozen', '--no-dev', '--no-emit-project', '--no-hashes', '--no-annotate', '--color', 'never'],
                  { cwd: src, encoding: 'utf8' },
                );
                if (exportResult.error) throw exportResult.error;
                if (exportResult.status !== 0) throw new Error('uv export failed: ' + exportResult.stderr);
                const reqs = exportResult.stdout.split('\n').filter((l: string) => l.trim() && !l.startsWith('#')).join('\n');
                // Write requirements to a temp file - avoids /dev/stdin issues in ts-node subprocess.
                const reqsFile = path.join(os.tmpdir(), 'cdk-layer-autoshutdown-reqs.txt');
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
                process.stderr.write('autoshutdown layer tryBundle error: ' + (_e as Error).message + '\n');
                return false;
              }
            },
          },
        },
      }),
    });

    const stopLambda = new lambda.Function(this, 'StopFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/auto-shutdown')),
      environment: {
        INSTANCE_ID: instanceId,
        CONTAINER_NAME: config.workloadName,
        // Powertools configuration
        POWERTOOLS_SERVICE_NAME: `${config.workloadName}-autoshutdown`,
        POWERTOOLS_METRICS_NAMESPACE: config.workloadName,
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
      alarmName: `${config.workloadName}-server-idle`,
      alarmDescription: `Triggers when ${config.workloadName} server CPU is below threshold (idle)`,
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
