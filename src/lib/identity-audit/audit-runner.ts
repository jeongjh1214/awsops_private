import { getConfig } from '../app-config';
import { openAssetDb, type AssetDb } from '../assets/asset-db';
import {
  collectIdentityCenterState as defaultCollectIdentityCenterState,
  type IdentityCenterCollectorConfig,
} from './aws-collector';
import { resolveIdentityAuditConfig, type ResolvedIdentityAuditConfig } from './config';
import {
  fetchOrganizationPositionsForUsers as defaultFetchOrganizationPositionsForUsers,
  type OrganizationApiRuntimeConfig,
  type OrganizationPosition,
} from './org-api';
import {
  completeIdentityAuditRun,
  createIdentityAuditRun,
  persistIdentityAuditSnapshot,
} from './repository';
import type {
  CollectedIdentityCenterState,
  IdentityAuditPersistSummary,
} from './types';

export interface RunIdentityAuditResult {
  runId: string;
  status: 'completed';
  summary: IdentityAuditPersistSummary;
}

export interface RunIdentityAuditDependencies {
  now?: () => string;
  openDb?: () => AssetDb;
  resolveConfig?: () => ResolvedIdentityAuditConfig;
  collectIdentityCenterState?: (
    config: IdentityCenterCollectorConfig,
  ) => Promise<CollectedIdentityCenterState>;
  fetchOrganizationPositionsForUsers?: (
    displayNames: string[],
    config: OrganizationApiRuntimeConfig,
  ) => Promise<Map<string, OrganizationPosition>>;
  getOrganizationApiKey?: (envName: string) => string | undefined;
}

let running = false;

export async function runIdentityAudit(
  dependencies: RunIdentityAuditDependencies = {},
): Promise<RunIdentityAuditResult> {
  if (running) {
    throw new Error('identity audit is already running');
  }

  running = true;
  const now = dependencies.now ?? (() => new Date().toISOString());
  let db: AssetDb | undefined;
  let runId: string | undefined;

  try {
    db = (dependencies.openDb ?? defaultOpenDb)();
    const run = createIdentityAuditRun(db, now());
    runId = run.id;

    const config = (dependencies.resolveConfig ?? resolveIdentityAuditConfig)();
    if (!config.enabled) {
      throw new Error('identity audit is disabled');
    }
    if (!config.profile) {
      throw new Error('identity audit AWS profile is not configured');
    }

    const organizationApi = config.organizationApi;
    const apiKeyEnv = organizationApi?.apiKeyEnv || 'KREW_API_KEY';
    const apiKey = (dependencies.getOrganizationApiKey ?? defaultGetOrganizationApiKey)(apiKeyEnv);
    if (!apiKey) {
      throw new Error(`${apiKeyEnv} is required for identity audit organization API`);
    }

    const collectIdentityCenterState = dependencies.collectIdentityCenterState
      ?? defaultCollectIdentityCenterState;
    const fetchOrganizationPositionsForUsers = dependencies.fetchOrganizationPositionsForUsers
      ?? defaultFetchOrganizationPositionsForUsers;
    const identityState = await collectIdentityCenterState({
      profile: config.profile,
      region: config.region ?? 'ap-northeast-2',
      endpointUrls: config.endpointUrls,
    });
    const displayNames = identityState.users.map((user) => user.displayName);
    const positions = await fetchOrganizationPositionsForUsers(displayNames, {
      baseUrl: organizationApi?.baseUrl || 'https://knock-api.kakaopay.com/papi/v1/krew',
      apiKey,
      concurrency: organizationApi?.concurrency ?? 10,
      timeoutMs: organizationApi?.timeoutMs ?? 5000,
      retryCount: organizationApi?.retryCount ?? 2,
    });
    const collectedAt = now();
    const summary = persistIdentityAuditSnapshot(db, {
      runId,
      collectedAt,
      users: identityState.users.map((user) => {
        const position = positions.get(user.displayName);
        return {
          displayName: user.displayName,
          identityStoreUserId: user.identityStoreUserId,
          userName: user.userName,
          email: user.email,
          orgCode: position?.orgCode ?? '',
          orgName: position?.orgName ?? '',
          rawOrg: position?.raw ?? null,
        };
      }),
      assignments: identityState.assignments,
    });

    completeIdentityAuditRun(db, runId, 'completed', now());
    return {
      runId,
      status: 'completed',
      summary,
    };
  } catch (error) {
    if (db && runId) {
      completeIdentityAuditRun(db, runId, 'failed', now(), toErrorMessage(error));
    }
    throw error;
  } finally {
    try {
      db?.close();
    } finally {
      running = false;
    }
  }
}

function defaultOpenDb(): AssetDb {
  return openAssetDb(getConfig().assetInventory?.sqlitePath);
}

function defaultGetOrganizationApiKey(envName: string): string | undefined {
  return process.env[envName];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'identity audit failed';
}
