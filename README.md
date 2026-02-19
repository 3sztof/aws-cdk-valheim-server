# Valheim Dedicated Server on AWS

AWS CDK project that deploys a cost-effective Valheim dedicated server with automatic backups, idle shutdown, and optional Discord notifications.

## Architecture

```
EC2 (t3a.large, Amazon Linux 2023)
  +-- Docker: lloesche/valheim-server
      +-- Native backup scheduling (BACKUPS_CRON)
      +-- Discord lifecycle hooks (server online/offline)
      +-- Player join/disconnect notifications (log filter)
  +-- S3 backup sync (POST_BACKUP_HOOK)
  +-- CloudWatch idle alarm --> Lambda (auto-stop)

API Gateway (public REST API)
  +-- Lambda: start/stop/status

S3 Bucket (world backups, 30-day lifecycle)
AWS Budgets (cost alerts by Project tag)
cdk-nag (AWS Solutions security checks)
```

## Prerequisites

- Node.js 18+
- AWS CLI configured with credentials
- AWS CDK CLI (`npm install -g aws-cdk`)

## Quick Start

```bash
# Install dependencies
make install

# Edit config.yaml with your server settings
vim config.yaml

# Bootstrap CDK (first time only)
make bootstrap

# Deploy
make deploy
```

## Make Targets

Run `make` with no arguments to see all available commands.

| Command | Description |
|---------|-------------|
| `make install` | Install npm dependencies |
| `make deploy` | Build and deploy to AWS |
| `make destroy` | Tear down the stack |
| `make diff` | Preview changes before deploying |
| `make synth` | Generate CloudFormation template |
| `make start` | Start the game server |
| `make stop` | Stop the game server |
| `make status` | Check server state and public IP |

## Project Structure

```
valheim-server/
+-- config.yaml                        # All server settings
+-- Makefile                            # CLI shortcuts
+-- bin/valheim-server.ts               # CDK app entry + cdk-nag
+-- lib/
|   +-- config.ts                       # YAML loader, types, validation
|   +-- valheim-server-stack.ts         # Main stack (VPC, wiring)
|   +-- constructs/
|       +-- server.ts                   # EC2 instance, security group, IAM
|       +-- backup.ts                   # S3 bucket with lifecycle rules
|       +-- control.ts                  # API Gateway + Lambda (start/stop/status)
|       +-- auto-shutdown.ts            # CloudWatch alarm --> Lambda (stop)
|       +-- budget.ts                   # AWS Budgets alerts
|       +-- userdata/setup.sh           # EC2 bootstrap script
```

## Configuration

All settings live in `config.yaml`. The file is commented inline - edit it before deploying.

### server

| Key | Default | Description |
|-----|---------|-------------|
| `name` | `MyValheimServer` | Server name shown in the browser |
| `world` | `Dedicated` | World name (save file name) |
| `password` | _(empty)_ | Server password (min 5 chars, auto-generated if empty) |
| `public` | `false` | Show in public server list |
| `crossplay` | `false` | Allow Xbox/PC crossplay |
| `adminSteamIds` | `[]` | SteamID64s with admin privileges |
| `bannedSteamIds` | `[]` | SteamID64s banned from the server |
| `permittedSteamIds` | `[]` | SteamID64 whitelist (empty = everyone allowed) |

### instance

| Key | Default | Description |
|-----|---------|-------------|
| `type` | `t3a.large` | EC2 instance type (2 vCPU, 8GB RAM) |
| `useSpot` | `true` | Use Spot instances for ~60% savings |
| `maxSpotPrice` | `0.05` | Max Spot price in USD/hour (0 = on-demand cap) |
| `volumeSize` | `20` | EBS volume size in GB |
| `region` | `eu-west-1` | AWS region |

### backup

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable S3 backups |
| `schedule` | `0 */6 * * *` | Backup cron (standard 5-field, used by Docker image's native scheduler) |
| `retentionDays` | `30` | Days to keep backups in S3 |
| `onShutdown` | `true` | Backup before server shutdown (handled by Docker image's graceful shutdown) |

### autoShutdown

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable idle auto-shutdown |
| `cpuThreshold` | `5` | CPU % below which server is considered idle |
| `evaluationPeriods` | `6` | Number of 5-min periods before shutdown (30 min default) |
| `scheduledShutdown` | _(empty)_ | Fixed shutdown cron (e.g. `0 4 * * *` for 4 AM UTC) |

### discord

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable Discord notifications |
| `webhookParameterName` | `/valheim-server/discord-webhook` | SSM parameter name storing the webhook URL |
| `notifyOnStart` | `true` | Notify when server starts (via POST_SERVER_LISTENING_HOOK) |
| `notifyOnStop` | `true` | Notify when server stops (via PRE_SERVER_SHUTDOWN_HOOK) |
| `notifyOnBackup` | `false` | Notify on backup completion |

Player join/disconnect notifications are automatically sent when Discord is enabled.

Set the webhook URL in SSM before enabling:

```bash
aws ssm put-parameter \
  --name "/valheim-server/discord-webhook" \
  --value "https://discord.com/api/webhooks/..." \
  --type SecureString
```

### budget

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable AWS Budget alerts |
| `monthlyLimit` | `10.00` | Monthly budget in USD |
| `alertEmails` | `[]` | Email addresses for alerts |
| `thresholds` | `[50, 80, 100]` | Alert at these % of budget |
| `forecastAlert` | `true` | Alert on forecasted overspend |
| `forecastThreshold` | `100` | Forecast % threshold |

### tags

Key-value pairs applied to all AWS resources. `Project` is required and used for cost filtering in AWS Cost Explorer.

Activate tags in **AWS Billing Console > Cost Allocation Tags** for them to appear in Cost Explorer.

## Connecting

1. `make start`
2. `make status` - note the public IP
3. In Valheim: Join Game > Join IP > `<ip>:2456`

If `server.public` is `true`, the server also appears in the public server list after a few minutes.

## Restoring from Backup

```bash
aws ssm start-session --target <instance-id>
/opt/valheim/scripts/restore.sh s3://<bucket>/backups/<file>.tar.gz
```

## Estimated Monthly Cost

| Component | Cost (20 hrs/week) |
|-----------|--------------------|
| EC2 t3a.large on-demand | ~$9 |
| EC2 t3a.large spot | ~$3 |
| S3 backups | ~$0.10 |
| API Gateway + Lambda | ~$0 (free tier) |
| **Total** | **~$3-9/month** |
