# Valheim Dedicated Server on AWS

AWS CDK project that deploys a cost-effective Valheim dedicated server on EC2 with automatic S3 backups, idle auto-shutdown, a public REST API for server control, and optional Discord notifications.

## Architecture

```
VPC (public subnet, no NAT gateway)
  +-- EC2 (t3a.large, Amazon Linux 2023, gp3 EBS, IMDSv2)
        +-- Docker: lloesche/valheim-server
              +-- Automatic game server updates
              +-- Native backup scheduling (BACKUPS_CRON)
              +-- S3 backup sync (POST_BACKUP_HOOK)
              +-- Discord lifecycle hooks (server online/offline)
              +-- Player join/disconnect notifications (log filter)
        +-- SSM Session Manager (no SSH required)
        +-- CloudWatch idle alarm --> Lambda (auto-stop)

API Gateway (public REST API, no auth)
  +-- Lambda (Python 3.13): GET /server/start   - starts EC2, Discord notification w/ control links
                            GET /server/stop    - stops EC2, Discord notification
                            GET /server/status  - returns state, public IP, recent container logs, control links
  +-- Optional: custom domain via Route53 + ACM (regional cert, no us-east-1 required)

S3 Bucket
  +-- World backups with lifecycle rules (configurable retention)
  +-- Versioning enabled, SSE-S3 encryption, access logging

AWS Budgets (monthly cost alerts by Project tag)
cdk-nag (AWS Solutions security checks at synth time)
```

## Prerequisites

- Node.js 18+
- AWS CLI configured with credentials
- AWS CDK CLI: `npm install -g aws-cdk`
- Python + pip (for pre-commit hooks): `pip install pre-commit`

## Quick Start

```bash
# 1. Install dependencies and pre-commit hooks
make install

# 2. Create config.yaml from the template
make init

# 3. Edit config.yaml with your server settings
vim config.yaml

# 4. Bootstrap CDK (first time per account/region only)
make bootstrap

# 5. Deploy
make deploy
```

After deploying, `make deploy` prints the API URL and instance ID as stack outputs. Run `make share` to see all browser-clickable links, including the custom domain if configured.

## Make Targets

Run `make` with no arguments to see all available commands.

### Setup

| Command | Description |
|---------|-------------|
| `make init` | Create `config.yaml` from template |
| `make install` | Install npm dependencies and pre-commit hooks |
| `make bootstrap` | Bootstrap CDK (first time per account/region) |

### Stack

| Command | Description |
|---------|-------------|
| `make deploy` | Build and deploy to AWS |
| `make destroy` | Tear down the entire stack |
| `make diff` | Preview changes before deploying |
| `make synth` | Generate CloudFormation template |
| `make build` | Compile TypeScript only |
| `make clean` | Remove build artifacts |

### Server

| Command | Description |
|---------|-------------|
| `make start` | Start the EC2 instance (and game server) |
| `make stop` | Stop the EC2 instance |
| `make status` | Check instance state and public IP |
| `make logs` | Tail Valheim container logs via SSM |

### World Management

| Command | Description |
|---------|-------------|
| `make world-list` | List world files on the server |
| `make world-download` | Download world files to `./worlds/` |
| `make world-upload` | Upload world files from `./worlds/` (stops server first) |
| `make backup` | Trigger a manual backup to S3 |
| `make share` | Print browser-clickable start/stop/status URLs (uses custom domain if deployed, falls back to raw API Gateway URL) |

## Project Structure

```
aws-cdk-valheim-server/
+-- config.yaml.example             # Config template (copy to config.yaml)
+-- config.yaml                     # Your settings - gitignored, never committed
+-- Makefile                        # CLI shortcuts
+-- bin/
|   +-- valheim-server.ts           # CDK app entry point + cdk-nag setup
+-- lib/
|   +-- config.ts                   # YAML loader, TypeScript types, validation
|   +-- valheim-server-stack.ts     # Root stack (VPC, wiring, outputs)
|   +-- constructs/
|       +-- server.ts               # EC2, launch template, IAM role, security group
|       +-- backup.ts               # S3 bucket with lifecycle and access logging
|       +-- control.ts              # API Gateway + Lambda (start/stop/status)
|       +-- auto-shutdown.ts        # CloudWatch alarm + optional scheduled shutdown
|       +-- budget.ts               # AWS Budgets cost alerts
|       +-- userdata/setup.sh       # EC2 bootstrap script (Docker, Valheim container)
```

## Configuration

All settings live in `config.yaml` (copy from `config.yaml.example` via `make init`). The file is fully commented — edit it before deploying.

### Server

| Key | Default | Description |
|-----|---------|-------------|
| `name` | `MyValheimServer` | Server name shown in the browser |
| `world` | `MyWorld` | World name (save file name, no extension) |
| `password` | _(empty)_ | Server password (min 5 chars); auto-generated and stored in SSM if empty |
| `public` | `true` | Show in public server list |
| `crossplay` | `true` | Allow Xbox/PC crossplay (opens UDP port 2458) |
| `adminSteamIds` | `[]` | SteamID64s with admin privileges |
| `bannedSteamIds` | `[]` | SteamID64s banned from the server |
| `permittedSteamIds` | `[]` | SteamID64 whitelist (empty = everyone allowed) |

### Instance

| Key | Default | Description |
|-----|---------|-------------|
| `type` | `t3a.large` | EC2 instance type (2 vCPU, 8 GB RAM - minimum recommended) |
| `useSpot` | `false` | Use Spot instances for ~60-70% cost savings (rare interruptions) |
| `maxSpotPrice` | `0.05` | Max Spot price in USD/hour (0 = on-demand price cap) |
| `volumeSize` | `20` | EBS volume size in GB (gp3, encrypted) |
| `region` | `eu-central-1` | AWS region to deploy in |

### Backup

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable automatic S3 backups |
| `schedule` | `0 */6 * * *` | Backup cron expression (UTC, 5-field standard) |
| `retentionDays` | `30` | Days to keep backups in S3 |
| `onShutdown` | `true` | Backup on graceful server shutdown |

### Auto-Shutdown

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable idle auto-shutdown via CloudWatch alarm |
| `cpuThreshold` | `5` | CPU % below which server is considered idle |
| `evaluationPeriods` | `6` | Number of 5-minute periods before shutdown triggers (default: 30 min) |
| `scheduledShutdown` | _(empty)_ | Fixed daily shutdown cron (e.g. `0 4 * * *` = 4:00 AM UTC) |

### Discord

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable Discord notifications |
| `webhookParameterName` | `/valheim-server/discord-webhook` | SSM SecureString parameter containing the webhook URL |
| `notifyOnStart` | `true` | Notify when server becomes available |
| `notifyOnStop` | `true` | Notify when server stops |
| `notifyOnBackup` | `true` | Notify on backup completion |

Player join/disconnect notifications are sent automatically when Discord is enabled (via the container's log filter hook). When `domain.enabled: true`, start notifications also include a control links block with clickable start/stop/status URLs.

Store the webhook URL in SSM before deploying with Discord enabled:

```bash
aws ssm put-parameter \
  --name "/valheim-server/discord-webhook" \
  --value "https://discord.com/api/webhooks/..." \
  --type SecureString
```

### Budget

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable AWS Budget alerts |
| `monthlyLimit` | `10.00` | Monthly budget limit in USD |
| `alertEmails` | `[]` | Email addresses to notify on threshold breach |
| `thresholds` | `[50, 80, 100]` | Alert at these percentages of the monthly budget |
| `forecastAlert` | `true` | Also alert when forecasted spend will exceed budget |
| `forecastThreshold` | `100` | Forecast alert threshold (% of budget) |

### Tags

Key-value pairs applied to all AWS resources. `Project` is required and used for cost filtering in AWS Cost Explorer.

After deploying, activate user-defined tags in **AWS Billing Console > Cost Allocation Tags** for them to appear in Cost Explorer (takes up to 24 hours).

### Domain (optional)

Integrates the control API with an existing Route53 domain so you can open links in a browser instead of running curl.

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable custom domain integration |
| `hostedZoneName` | _(required)_ | Existing Route53 public hosted zone name, e.g. `example.com` |
| `hostedZoneId` | _(optional)_ | Hosted zone ID - avoids a lookup at synth time (faster deploys) |
| `subdomain` | _(empty)_ | Subdomain prefix. Empty = serve from the zone apex. `"valheim"` = `valheim.<zone>/valheim/server/start\|stop\|status` |

When enabled, CDK will:
1. Provision a new ACM certificate (DNS-validated, auto-created CNAME in Route53)
2. Create a regional API Gateway custom domain mapping the base path `valheim` to the API stage, exposing `<domain>/valheim/server/start`, `<domain>/valheim/server/stop`, and `<domain>/valheim/server/status`
3. Add a Route53 alias A record pointing the domain at the API Gateway endpoint

Example config for `example.com/valheim/server/start`:

```yaml
domain:
  enabled: true
  hostedZoneName: "example.com"
  hostedZoneId: "ZXXXXXXXXXXXXXXXXXXXXX"
  subdomain: ""
```

## Connecting

```bash
make start          # Start the EC2 instance
make status         # Get the public IP
```

Then in Valheim: **Join Game > Join IP** > `<ip>:2456`

If `server.public: true`, the server also appears in the Community server list after a few minutes (search by name).

## World Management

### Upload an Existing World

Place your world files (`.fwl` and `.db`) in `./worlds/` — the world name must match `server.world` in `config.yaml`.

Local world files are typically found at:
- **Windows:** `%USERPROFILE%\AppData\LocalLow\IronGate\Valheim\worlds_local\`
- **macOS:** `~/Library/Application Support/unity.IronGate.Valheim/worlds_local/`
- **Linux:** `~/.config/unity3d/IronGate/Valheim/worlds_local/`

Then run:

```bash
make world-upload   # Takes a backup first, stops server, uploads, restarts
```

### Download World Files

```bash
make world-download   # Downloads world files to ./worlds/
```

### Restore from S3 Backup

```bash
make start
# Connect via SSM:
aws ssm start-session --target <instance-id>
# On the instance:
aws s3 ls s3://<bucket>/backups/
aws s3 cp s3://<bucket>/backups/<file>.tar.gz /tmp/
# Stop the container, extract, restart
```

## Estimated Monthly Cost

Estimates based on ~20 hours/week of play in `eu-central-1`.

| Component | On-Demand | Spot |
|-----------|-----------|------|
| EC2 t3a.large | ~$9/mo | ~$3/mo |
| EBS gp3 20 GB | ~$1.60/mo | ~$1.60/mo |
| S3 backups | ~$0.10/mo | ~$0.10/mo |
| API Gateway + Lambda | ~$0 (free tier) | ~$0 (free tier) |
| **Total** | **~$11/mo** | **~$5/mo** |

Enable Spot instances with `instance.useSpot: true` in `config.yaml` for maximum savings.

## Credits

The game server itself runs inside the [lloesche/valheim-server-docker](https://github.com/lloesche/valheim-server-docker) container image (Apache 2.0), which handles Valheim server lifecycle, automatic updates, backups, and Discord event hooks. This project provides the AWS infrastructure to run and manage it cost-effectively.

## License

Copyright 2026 Krzysztof Wilczynski. Licensed under the [Apache License, Version 2.0](LICENSE).
