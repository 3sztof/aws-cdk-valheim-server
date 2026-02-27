# Valheim Dedicated Server on AWS

AWS CDK project that deploys a cost-effective Valheim dedicated server on EC2 with automatic S3 backups, idle auto-shutdown, a public REST API for server control, and optional Discord notifications.

> **Disclaimer:** This project is provided as-is, without warranty of any kind. You use it at your own risk. The author is not responsible for any costs, data loss, or other issues arising from its use. Always review infrastructure changes before deploying to your AWS account.

## Architecture

```
VPC (public subnet, no NAT gateway)
  +-- EC2 (t3a.large, Amazon Linux 2023, gp3 EBS, IMDSv2)
        +-- Elastic IP (static public IP - survives stop/start)
        +-- Docker: lloesche/valheim-server
              +-- Automatic game server updates
              +-- Native backup scheduling (BACKUPS_CRON)
              +-- S3 backup sync (POST_BACKUP_HOOK)
              +-- Discord lifecycle hooks (server online/offline)
              +-- Player join/death/raid notifications (log filter)
        +-- SSM Session Manager (no SSH required)
        +-- CloudWatch idle alarm --> Lambda (auto-stop, player-presence check)

API Gateway (public REST API, no auth)
  +-- Lambda (Python 3.13): GET /server/start   - starts EC2, Discord notification
                            GET /server/stop    - checks for active players, stops if idle
                            GET /server/status  - returns state, IP, recent logs, control links
  +-- HTML pages served to browsers; JSON returned to curl/API clients
  +-- Optional: custom domain via Route53 + ACM (regional cert, no us-east-1 required)

S3 Bucket
  +-- World backups with lifecycle rules (configurable retention)
  +-- Versioning enabled, SSE-S3 encryption, access logging

AWS Budgets (monthly cost alerts by Project tag)
cdk-nag (AWS Solutions security checks at synth time)
```

## Prerequisites

### Required tools

| Tool | Version | Purpose | Install |
|------|---------|---------|---------|
| [Node.js](https://nodejs.org/) | 18+ | Runs the CDK CLI and compiles the TypeScript infrastructure code | [nodejs.org](https://nodejs.org/en/download) |
| [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html) | v2 | Synthesizes and deploys CloudFormation stacks | `npm install -g aws-cdk` |
| [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) | v2 | Authenticates to AWS; used by Makefile helper commands | [Installation guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| [Python](https://www.python.org/) | 3.9+ | Required for pre-commit hooks (ruff linter) | [python.org](https://www.python.org/downloads/) |
| `uv` | 0.9+ | Builds Python Lambda layer dependencies at CDK synth time | [astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/) |
| [pre-commit](https://pre-commit.com/) | any | Runs linters and type checkers on every commit | `pip install pre-commit` |
| [Git](https://git-scm.com/) | any | Version control; needed for pre-commit hooks to register | [git-scm.com](https://git-scm.com/downloads) |
| [Make](https://www.gnu.org/software/make/) | any | Runs the Makefile shortcuts (`make deploy`, `make start`, etc.) | Pre-installed on macOS/Linux; [Windows](https://gnuwin32.sourceforge.net/packages/make.htm) |

### AWS account setup

You need an AWS account with credentials configured locally. The fastest path:

```bash
# Install the AWS CLI, then run:
aws configure
# Enter your Access Key ID, Secret Access Key, default region (e.g. eu-central-1), and output format (json)
```

If your organisation uses SSO or named profiles, set `AWS_PROFILE` before running any `make` command.

The IAM user or role you deploy with needs broad permissions (EC2, S3, Lambda, API Gateway, IAM, CloudFormation, SSM, CloudWatch, Budgets). For a personal account, `AdministratorAccess` is the simplest option.

### Background knowledge

You do not need to be an AWS expert to use this project - the goal is that `make deploy` just works. That said, some familiarity with the following will help if you need to debug or customise things:

- **AWS / IAM** - understanding that resources have permissions attached to them, and that `make destroy` will delete everything
- **CloudFormation / CDK** - this project synthesizes a CloudFormation stack; if a deploy fails mid-way, the AWS Console > CloudFormation page is the best place to see why
- **EC2** - the game server runs on a virtual machine; knowing the difference between *stopped* (instance off, not billed for compute) and *running* is useful
- **S3** - world backups land in an S3 bucket; you can browse them in the AWS Console if you ever need to restore manually
- **SSM Session Manager** - the Makefile commands (`make logs`, `make world-upload`, etc.) run shell commands on the EC2 instance over SSM without requiring SSH or an open port

None of the above is strictly required to get started. The README covers every command you need.

## Technology stack

| Layer | Technology | Role |
|-------|-----------|------|
| Infrastructure-as-code | [AWS CDK v2](https://docs.aws.amazon.com/cdk/v2/guide/) (TypeScript) | Defines and deploys all AWS resources |
| Game server runtime | [lloesche/valheim-server-docker](https://github.com/lloesche/valheim-server-docker) | Manages the Valheim dedicated server process inside Docker |
| Compute | AWS EC2 (t3a.large, Amazon Linux 2023) | Hosts the Docker container |
| Networking | AWS VPC, Elastic IP, Security Group | Public subnet, static IP that survives stop/start |
| Control API | AWS API Gateway + AWS Lambda (Python 3.13) | REST endpoints for start / stop / status |
| Observability | [AWS Lambda Powertools](https://docs.powertools.aws.dev/lambda/python/) (Logger, Metrics, Tracer) + AWS X-Ray | Structured JSON logs, custom CloudWatch metrics, distributed tracing |
| Auto-shutdown | AWS CloudWatch Alarm + Lambda | Stops the instance after 30 min of low CPU with player-presence check |
| Backups | AWS S3 + Docker hook | World files backed up on schedule and on shutdown |
| Notifications | Discord webhooks via SSM Parameter Store | Server lifecycle and in-game event alerts |
| Custom domain | AWS Route53 + ACM + API Gateway custom domain | Optional HTTPS endpoint on your own domain |
| Cost control | AWS Budgets | Monthly spend alerts by email |
| Security checks | [cdk-nag](https://github.com/cdklabs/cdk-nag) | AWS Solutions security rules enforced at synth time |
| Code quality | [ruff](https://docs.astral.sh/ruff/) + [ty](https://github.com/astral-sh/ty) + [tsc](https://www.typescriptlang.org/) + pre-commit | Python lint/format/types and TypeScript type checking on every commit |

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
| `make install` | Install npm dependencies, pre-commit hooks, and uv (if not present) |
| `make bootstrap` | Bootstrap CDK (first time per account/region) |
| `make layer-deps-update` | Regenerate `uv.lock` files for both Lambda layers after changing `pyproject.toml` |

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
| `make logs` | Show last 50 lines of Valheim container logs via SSM |
| `make logs-tail` | Stream Valheim container logs live in terminal (Ctrl+C to exit) |

### World Management

| Command | Description |
|---------|-------------|
| `make world-list` | List world files on the server |
| `make world-download` | Download world files to `./.worlds/` |
| `make world-upload` | Upload world files from `./.worlds/` (warns on name mismatch, stops server first) |
| `make world-reset` | Delete all world files from the server (fresh start) |
| `make world-restore` | Restore world from the latest S3 backup (stops server first) |
| `make backup` | Trigger a manual backup to S3 |
| `make share` | Print browser-clickable start/stop/status URLs |
## Project Structure

```
.
+-- config.yaml.example             # Config template (copy to config.yaml)
+-- config.yaml                     # Your settings - gitignored, never committed
+-- Makefile                        # CLI shortcuts
+-- bin/
|   +-- valheim-server.ts           # CDK app entry point + cdk-nag setup
+-- lib/
|   +-- config.ts                   # YAML loader, TypeScript types, validation
|   +-- valheim-server-stack.ts     # Root stack (VPC, wiring, outputs)
|   +-- constructs/
|       +-- server.ts               # EC2, Elastic IP, launch template, IAM role, security group
|       +-- backup.ts               # S3 bucket with lifecycle and access logging
|       +-- control.ts              # API Gateway + Lambda (start/stop/status)
|       +-- auto-shutdown.ts        # CloudWatch alarm + optional scheduled shutdown
|       +-- budget.ts               # AWS Budgets cost alerts
|       +-- userdata/setup.sh       # EC2 bootstrap script (Docker, Valheim container)
+-- lambda/
|   +-- control/
|   |   +-- index.py               # Start/stop/status handler, HTML + JSON responses
|   |   +-- player_check.py        # Player-presence check via valheim-is-idle (SSM)
|   |   +-- pyproject.toml         # uv project - layer dependencies
|   |   +-- uv.lock                # Pinned lockfile for reproducible layer builds
|   +-- auto-shutdown/
|       +-- index.py               # CloudWatch alarm handler
|       +-- player_check.py        # Player-presence check via valheim-is-idle (SSM)
|       +-- pyproject.toml         # uv project - layer dependencies
|       +-- uv.lock                # Pinned lockfile for reproducible layer builds
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

Both the idle alarm and the `/server/stop` API endpoint run a player-presence check before stopping the instance. The check calls `valheim-is-idle` inside the container via SSM - the same script the container uses internally, which handles crossplay vs. non-crossplay automatically. If players are active, the stop is skipped and the caller receives a clear message. If the check itself fails (SSM unreachable, container not running), the stop is also skipped rather than risking disconnecting active players.

### Discord

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable Discord notifications |
| `webhookParameterName` | `/valheim-server/discord-webhook` | SSM SecureString parameter containing the webhook URL |
| `notifyOnStart` | `true` | Notify when server becomes available |
| `notifyOnStop` | `true` | Notify when server stops |
| `notifyOnBackup` | `true` | Notify on backup completion |

Player join, death, and raid notifications are sent automatically when Discord is enabled (via the container's log filter hooks). Server start notifications include the static IP and clickable control links when `domain.enabled: true`.

Store the webhook URL in SSM before deploying with Discord enabled. To change the URL later, update the SSM parameter — `start.sh` fetches it fresh on every container start so no redeploy is needed:

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
  subdomain: "valheim"  # results in valheim.<zone>/server/start|stop|status
| `certificateArn` | _(optional)_ | ARN of an existing ACM cert. When set, CDK imports it read-only and will not create or delete it on deploy/destroy |

When enabled, CDK will:
1. Provision a new ACM certificate (DNS-validated) - or import an existing one if `certificateArn` is set
2. Create a regional API Gateway custom domain with no base path prefix, exposing `<domain>/server/start`, `<domain>/server/stop`, and `<domain>/server/status`
3. Add a Route53 alias A record pointing the domain at the API Gateway endpoint

Example config for `example.com/server/start`:

```yaml
domain:
  enabled: true
  hostedZoneName: "example.com"
  hostedZoneId: "ZXXXXXXXXXXXXXXXXXXXXX"
  subdomain: ""
  certificateArn: "arn:aws:acm:eu-central-1:123456789012:certificate/your-cert-id"
```

The server has a **static Elastic IP** that does not change between stop/start cycles. Save this address in Valheim's "Add Server" screen and it will always work.

```bash
make start          # Start the EC2 instance
make status         # Confirm it is online and get the static IP
```

Then in Valheim: **Join Game > Join IP** > `<static-ip>:2456`

If `server.public: true`, the server also appears in the Community server list after a few minutes (search by name).

## World Management

World files are stored locally in `.worlds/` (gitignored). The file names must match `server.world` in `config.yaml` - if they don't, `make world-upload` will warn you before proceeding.

### Upload an Existing World

Place your world files (`.fwl` and `.db`) in `.worlds/`. The file name (without extension) must match `server.world` in `config.yaml`.

Local world files are typically found at:
- **Windows:** `%USERPROFILE%\AppData\LocalLow\IronGate\Valheim\worlds_local\`
- **macOS:** `~/Library/Application Support/unity.IronGate.Valheim/worlds_local/`
- **Linux:** `~/.config/unity3d/IronGate/Valheim/worlds_local/`

Then run:

```bash
make world-upload   # Warns on name mismatch, takes a backup, stops server, uploads, restarts
```

`world-upload` reads `server.world` from `config.yaml` and compares it against the filenames in `.worlds/`. If they don't match it shows both names and explains the fix options before asking whether to proceed.

### Download World Files

```bash
make world-download   # Downloads world files to ./.worlds/
```

### Restore from S3 Backup

```bash
make world-restore   # Finds the latest backup in S3, shows the path, stops server, restores, restarts
```

Backups are `.zip` files stored at `s3://<bucket>/backups/` by the container's `POST_BACKUP_HOOK`. `world-restore` always picks the most recent one by filename (which is timestamp-ordered). The full S3 path is shown before you confirm.

### Reset to a Fresh World

```bash
make world-reset   # Stops server, deletes all world files, restarts (generates a new world)
```

Requires typing `yes` in full to confirm. Run `make backup` first if you want to preserve the current world.

### Manual Backup

```bash
make backup   # Triggers the container's backup script, uploads result to S3
```

## Estimated Monthly Cost

Estimates based on ~20 hours/week of play in `eu-central-1`.

| Component | On-Demand | Spot |
|-----------|-----------|------|
| EC2 t3a.large | ~$9/mo | ~$3/mo |
| EBS gp3 20 GB | ~$1.60/mo | ~$1.60/mo |
| Elastic IP | ~$0 (free while running) | ~$0 (free while running) |
| S3 backups | ~$0.10/mo | ~$0.10/mo |
| API Gateway + Lambda | ~$0 (free tier) | ~$0 (free tier) |
| **Total** | **~$11/mo** | **~$5/mo** |

The Elastic IP incurs a small charge (~$0.005/hr) only when the instance is stopped. With auto-shutdown enabled this is negligible.

Enable Spot instances with `instance.useSpot: true` in `config.yaml` for maximum savings.

## Credits

The game server itself runs inside the [lloesche/valheim-server-docker](https://github.com/lloesche/valheim-server-docker) container image (Apache 2.0), which handles Valheim server lifecycle, automatic updates, backups, and Discord event hooks. This project provides the AWS infrastructure to run and manage it cost-effectively.

## License

Copyright 2026 Krzysztof Wilczynski. Licensed under the [Apache License, Version 2.0](LICENSE).

## Support the Maintainer

If this project saved you time, consider buying me a coffee.

[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/3sztof)
