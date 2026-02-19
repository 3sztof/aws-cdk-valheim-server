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

export interface ValheimConfig {
  server: ServerConfig;
  instance: InstanceConfig;
  backup: BackupConfig;
  autoShutdown: AutoShutdownConfig;
  discord: DiscordConfig;
  tags: Record<string, string>;
  budget: BudgetConfig;
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
  const config = yaml.load(fileContents) as ValheimConfig;
  
  validateConfig(config);
  
  return config;
}

function validateConfig(config: ValheimConfig): void {
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
}
