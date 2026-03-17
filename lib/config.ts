import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface ServerConfig {
  name: string;
  world: string;
  password: string;
  public: boolean;
  crossplay: boolean;
  adminSteamIds: string[];
  bannedSteamIds: string[];
  permittedSteamIds: string[];
}

export interface InstanceConfig {
  type: string;
  useSpot: boolean;
  maxSpotPrice: number;
  volumeSize: number;
  region: string;
}

export interface BackupConfig {
  enabled: boolean;
  schedule: string;
  retentionDays: number;
  onShutdown: boolean;
}

export interface AutoShutdownConfig {
  enabled: boolean;
  cpuThreshold: number;
  evaluationPeriods: number;
  scheduledShutdown: string;
}

export interface DiscordConfig {
  enabled: boolean;
  webhookParameterName: string;
  notifyOnStart: boolean;
  notifyOnStop: boolean;
  notifyOnBackup: boolean;
}

export interface BudgetConfig {
  enabled: boolean;
  monthlyLimit: number;
  alertEmails: string[];
  thresholds: number[];
  forecastAlert: boolean;
  forecastThreshold: number;
}

export interface DomainConfig {
  enabled: boolean;
  // The Route53 hosted zone domain name, e.g. "example.com"
  hostedZoneName: string;
  // The Route53 hosted zone ID - optional, avoids a lookup during synth
  hostedZoneId?: string;
  // Optional subdomain prefix. If omitted, the API is served at the zone apex.
  // e.g. set to "valheim" -> served at "valheim.example.com/valheim/*"
  // Leave empty (or omit) to use the apex domain directly.
  subdomain?: string;
  // ARN of an existing ACM certificate for the domain. When provided, CDK imports
  // it (read-only) instead of creating a new one. Avoids recreation on cdk destroy.
  certificateArn?: string;
}

export interface ValheimConfig {
  // Workload name used as a prefix for all AWS resource names, tags, and
  // identifiers. Defaults to "valheim". Change this to avoid the game name
  // appearing in the AWS console (e.g. set to "gameserver" or "ds").
  workloadName: string;
  server: ServerConfig;
  instance: InstanceConfig;
  backup: BackupConfig;
  autoShutdown: AutoShutdownConfig;
  discord: DiscordConfig;
  tags: Record<string, string>;
  budget: BudgetConfig;
  domain?: DomainConfig;
}

export function toEventBridgeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 6) {
    return parts.join(' ');
  }
  if (parts.length === 5) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const ebDayOfWeek = dayOfWeek === '*' ? '?' : dayOfWeek;
    const ebDayOfMonth = ebDayOfWeek === '?' ? dayOfMonth : (dayOfMonth === '*' ? '?' : dayOfMonth);
    return `${minute} ${hour} ${ebDayOfMonth} ${month} ${ebDayOfWeek} *`;
  }
  throw new Error(`Invalid cron expression: "${cron}". Expected 5 fields (unix) or 6 fields (EventBridge).`);
}

export function loadConfig(configPath?: string): ValheimConfig {
  const resolvedPath = configPath || path.join(process.cwd(), 'config.yaml');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Config file not found: ${resolvedPath}\n` +
      `Run "make init" to create config.yaml from the template.`
    );
  }

  const fileContents = fs.readFileSync(resolvedPath, 'utf8');
  const raw = yaml.load(fileContents) as Record<string, unknown>;

  // js-yaml preserves YAML key names verbatim (snake_case), but the TypeScript
  // interface uses camelCase. Read workload_name from the raw parsed object and
  // normalise it onto the camelCase field before casting to ValheimConfig.
  const workloadNameRaw = (raw['workload_name'] ?? raw['workloadName'] ?? 'valheim') as string;
  delete raw['workload_name'];
  raw['workloadName'] = workloadNameRaw;

  const config = raw as unknown as ValheimConfig;

  // Apply defaults before validation so validators can rely on them.
  config.workloadName = config.workloadName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'valheim';

  // Default the Discord webhook SSM parameter path from workloadName so the
  // config never needs a hardcoded game name in the parameter path.
  if (config.discord?.enabled && !config.discord.webhookParameterName) {
    config.discord.webhookParameterName = `/${config.workloadName}/discord-webhook`;
  }

  validateConfig(config);

  return config;
}

function validateConfig(config: ValheimConfig): void {
  if (!config.workloadName || config.workloadName.length < 2) {
    throw new Error('workload_name must be at least 2 characters');
  }
  if (config.workloadName.length > 32) {
    throw new Error('workload_name must be 32 characters or fewer (used as resource name prefix)');
  }

  if (!config.server?.name) {
    throw new Error('server.name is required');
  }

  if (!config.server?.world) {
    throw new Error('server.world is required');
  }

  if (!config.instance?.type) {
    throw new Error('instance.type is required');
  }

  if (!config.instance?.region) {
    throw new Error('instance.region is required');
  }

  if (config.instance?.volumeSize && config.instance.volumeSize < 8) {
    throw new Error('instance.volumeSize must be at least 8 GB');
  }

  if (!config.tags?.Project) {
    throw new Error('tags.Project is required for cost allocation');
  }

  if (config.budget?.enabled) {
    if (!config.budget.monthlyLimit || config.budget.monthlyLimit <= 0) {
      throw new Error('budget.monthlyLimit must be a positive number');
    }
    if (!config.budget.alertEmails?.length) {
      throw new Error('budget.alertEmails must have at least one email when budget is enabled');
    }
    if (!config.budget.thresholds?.length) {
      throw new Error('budget.thresholds must have at least one threshold when budget is enabled');
    }
  }

  if (config.domain?.enabled) {
    if (!config.domain.hostedZoneName) {
      throw new Error('domain.hostedZoneName is required when domain is enabled');
    }
  }
}
