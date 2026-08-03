import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';

export interface PrivateRuntimeConfig {
  activeEnvironment: string;
  agent: {
    provider: string;
    modelId: string;
    langgraphApiUrl: string;
    mcpServerUrl: string;
  };
  assetInventory?: {
    enabled?: boolean;
    dbProvider?: string;
    sqlitePath?: string;
  };
  localAuth?: {
    enabled?: boolean;
    email?: string;
    password?: string;
    groups?: string[];
    sessionSecret?: string;
  };
  environments: Record<string, {
    endpointMode?: string;
    bedrockProfile?: string;
    awsProfile?: string;
    endpointUrls?: Record<string, string>;
  }>;
}

const DEFAULT_CONFIG: PrivateRuntimeConfig = {
  activeEnvironment: 'local',
  agent: {
    provider: 'agentcore',
    modelId: 'anthropic.claude-sonnet-4-6',
    langgraphApiUrl: 'http://127.0.0.1:7000',
    mcpServerUrl: 'http://127.0.0.1:7100',
  },
  environments: {},
};

let cache: { path: string; mtimeMs: number; value: PrivateRuntimeConfig } | null = null;

export function resolvePrivateRuntimeConfigPath(): string | null {
  const candidates = [
    process.env.AWSOPS_CONFIG,
    resolve(process.cwd(), 'data/config.json'),
    resolve(process.cwd(), '../data/config.json'),
  ].filter((path): path is string => !!path);
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function getPrivateRuntimeConfig(): PrivateRuntimeConfig {
  const configPath = resolvePrivateRuntimeConfigPath();
  if (!configPath) return DEFAULT_CONFIG;
  const stat = statMtime(configPath);
  if (cache && cache.path === configPath && cache.mtimeMs === stat) return cache.value;
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<PrivateRuntimeConfig>;
  const value = {
    ...DEFAULT_CONFIG,
    ...raw,
    agent: { ...DEFAULT_CONFIG.agent, ...(raw.agent ?? {}) },
    environments: raw.environments ?? {},
  };
  cache = { path: configPath, mtimeMs: stat, value };
  return value;
}

export function isLocalPrivateAgentEnabled(): boolean {
  if (process.env.AWSOPS_AGENT_PROVIDER === 'local-mcp-langgraph') return true;
  if (process.env.AWSOPS_AGENT_PROVIDER === 'agentcore') return false;
  return getPrivateRuntimeConfig().agent.provider === 'local-mcp-langgraph';
}

function statMtime(path: string): number {
  try {
    return Number(statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}
