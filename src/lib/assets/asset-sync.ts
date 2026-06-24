import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { openAssetDb as defaultOpenAssetDb, type AssetDb } from './asset-db';
import { normalizeEc2Instance, normalizeS3Bucket } from './asset-normalizers';
import type { AssetRecord } from './asset-types';

export interface AssetSyncSummary {
  discovered: number;
  changed: number;
  rediscovered: number;
}

export interface AssetMissingScope {
  accountIds?: string[];
  regions?: string[];
  services?: string[];
  resourceTypes?: string[];
  sourceTables?: string[];
}

type SteampipeRow = Record<string, unknown>;

export interface AssetSyncQuery {
  sql: string;
  normalize: (row: SteampipeRow, now: string) => AssetRecord;
  missingScope: AssetMissingScope;
}

export interface AssetSyncSelection {
  selected: string[];
  unsupported: string[];
}

export interface AssetSyncResourceTypesInput {
  resourceTypes?: string[];
  error?: string;
}

export interface AssetSyncFailure {
  resourceType: string;
  error: string;
}

export interface AssetSyncRunSummary {
  selected: string[];
  unsupported: string[];
  discovered: number;
  changed: number;
  rediscovered: number;
  missing: number;
  failed: AssetSyncFailure[];
  startedAt: string;
  finishedAt: string;
  skipped?: boolean;
  reason?: string;
}

export interface RunAssetSyncOptions {
  resourceTypes?: string[];
  accountId?: string;
  now?: string;
  sqlitePath?: string;
  dependencies?: {
    runQuery?: RunQuery;
    listS3Buckets?: ListS3Buckets;
    getAssetInventoryConfig?: () => Partial<AssetInventoryRuntimeConfig> | undefined;
    openAssetDb?: (dbPath?: string) => AssetDb;
  };
}

export type RunQuery = <T = Record<string, unknown>>(
  sql: string,
  opts?: { bustCache?: boolean; accountId?: string },
) => Promise<{ rows: T[]; error?: string }>;

export type ListS3Buckets = (opts?: { accountId?: string }) => Promise<{ rows: SteampipeRow[]; error?: string }>;

export interface AssetInventoryRuntimeConfig {
  enabled: boolean;
  dbProvider: 'sqlite' | string;
  sqlitePath: string;
  syncOnDemandOnly: boolean;
  adminTokenHash: string;
  supportedResourceTypes: string[];
}

const DEFAULT_ASSET_SYNC_CONFIG: AssetInventoryRuntimeConfig = {
  enabled: true,
  dbProvider: 'sqlite',
  sqlitePath: 'data/awsops.db',
  syncOnDemandOnly: true,
  adminTokenHash: '',
  supportedResourceTypes: ['ec2_instance', 's3_bucket'],
};

export const ASSET_SYNC_QUERIES: Record<string, AssetSyncQuery> = {
  ec2_instance: {
    sql: `
      SELECT
        account_id,
        '' AS account_name,
        region,
        tags ->> 'Name' AS name,
        instance_id AS id,
        instance_id,
        arn,
        instance_state AS status,
        instance_state,
        tags,
        COALESCE(state_transition_time::text, launch_time::text) AS source_updated_at
      FROM
        aws_ec2_instance
    `,
    normalize: normalizeEc2Instance,
    missingScope: {
      services: ['ec2'],
      resourceTypes: ['ec2_instance'],
      sourceTables: ['aws_ec2_instance'],
    },
  },
  s3_bucket: {
    sql: `
      SELECT
        account_id,
        '' AS account_name,
        region,
        name,
        name AS id,
        arn,
        'available' AS status,
        tags,
        creation_date::text AS source_updated_at
      FROM
        aws_s3_bucket
    `,
    normalize: normalizeS3Bucket,
    missingScope: {
      services: ['s3'],
      resourceTypes: ['s3_bucket'],
      sourceTables: ['aws_s3_bucket'],
    },
  },
};

export function selectAssetSyncResourceTypes(requested?: string[], configured?: string[]): AssetSyncSelection {
  const supported = Object.keys(ASSET_SYNC_QUERIES);
  const supportedSet = new Set(supported);
  const configuredProvided = Array.isArray(configured);
  const configuredSet = configuredProvided
    ? new Set(uniqueStrings(configured).filter((resourceType) => supportedSet.has(resourceType)))
    : supportedSet;
  const allowed = supported.filter((resourceType) => configuredSet.has(resourceType));
  const allowedSet = new Set(allowed);
  const requestedProvided = Array.isArray(requested);
  const candidates = requestedProvided ? uniqueStrings(requested) : allowed;
  const selected = candidates.filter((resourceType) => allowedSet.has(resourceType));
  const unsupported = requestedProvided
    ? candidates.filter((resourceType) => !allowedSet.has(resourceType))
    : [];

  return { selected, unsupported };
}

export function parseAssetSyncResourceTypesInput(value: unknown): AssetSyncResourceTypesInput {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((resourceType) => typeof resourceType !== 'string')) {
    return { error: 'resourceTypes must be an array of strings' };
  }
  return { resourceTypes: value };
}

export async function runAssetSync(options: RunAssetSyncOptions = {}): Promise<AssetSyncRunSummary> {
  const assetConfig = {
    ...DEFAULT_ASSET_SYNC_CONFIG,
    ...(options.dependencies?.getAssetInventoryConfig?.() ?? loadAssetInventoryConfig()),
  };
  const startedAt = options.now ?? new Date().toISOString();

  if (!assetConfig.enabled) {
    return {
      selected: [],
      unsupported: [],
      discovered: 0,
      changed: 0,
      rediscovered: 0,
      missing: 0,
      failed: [],
      startedAt,
      finishedAt: new Date().toISOString(),
      skipped: true,
      reason: 'asset inventory sync is disabled',
    };
  }

  if (assetConfig.dbProvider !== 'sqlite') {
    return {
      selected: [],
      unsupported: [],
      discovered: 0,
      changed: 0,
      rediscovered: 0,
      missing: 0,
      failed: [],
      startedAt,
      finishedAt: new Date().toISOString(),
      skipped: true,
      reason: `asset inventory dbProvider ${assetConfig.dbProvider} is not supported`,
    };
  }

  const selection = selectAssetSyncResourceTypes(options.resourceTypes, assetConfig.supportedResourceTypes);
  const summary: AssetSyncRunSummary = {
    selected: selection.selected,
    unsupported: selection.unsupported,
    discovered: 0,
    changed: 0,
    rediscovered: 0,
    missing: 0,
    failed: selection.unsupported.map((resourceType) => ({
      resourceType,
      error: 'unsupported resource type',
    })),
    startedAt,
    finishedAt: '',
  };
  const dbPath = options.sqlitePath ?? assetConfig.sqlitePath;
  const runId = randomUUID();
  let db: AssetDb | undefined;

  try {
    const openAssetDb = options.dependencies?.openAssetDb ?? loadOpenAssetDb();
    const runQuery = options.dependencies?.runQuery ?? loadRunQuery();
    db = openAssetDb(resolve(process.cwd(), dbPath));
    insertSyncRun(db, runId, startedAt, summary);

    for (const resourceType of summary.selected) {
      const query = ASSET_SYNC_QUERIES[resourceType];
      try {
        const listS3Buckets = resourceType === 's3_bucket'
          ? options.dependencies?.listS3Buckets ?? loadListS3Buckets()
          : undefined;
        const result = resourceType === 's3_bucket'
          ? await listS3Buckets!({ accountId: options.accountId })
          : await runQuery<SteampipeRow>(query.sql, {
              bustCache: true,
              accountId: options.accountId,
            });
        if (result.error) {
          summary.failed.push({ resourceType, error: result.error });
          continue;
        }

        const assets = result.rows.map((row) => query.normalize(row, startedAt));
        const seenIds = new Set(assets.map((asset) => asset.id));
        const upsertSummary = upsertDiscoveredAssets(db, assets, startedAt);
        summary.discovered += upsertSummary.discovered;
        summary.changed += upsertSummary.changed;
        summary.rediscovered += upsertSummary.rediscovered;
        summary.missing += markMissingAssets(db, seenIds, startedAt, query.missingScope);
      } catch (err) {
        summary.failed.push({
          resourceType,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    summary.finishedAt = new Date().toISOString();
    safeUpdateSyncRun(db, runId, syncRunStatus(summary), summary);
    return summary;
  } catch (err) {
    summary.finishedAt = new Date().toISOString();
    summary.failed.push({
      resourceType: 'asset_sync',
      error: err instanceof Error ? err.message : String(err),
    });
    if (db) safeUpdateSyncRun(db, runId, syncRunStatus(summary), summary);
    return summary;
  } finally {
    db?.close();
  }
}

interface AssetRecordRow {
  id: string;
  provider: string;
  account_id: string;
  account_name: string;
  region: string;
  service: string;
  resource_type: string;
  resource_id: string;
  resource_name: string;
  arn: string;
  status: string;
  native_state: string;
  tags_json: string;
  source_table: string;
  source_updated_at: string;
  first_discovered_at: string;
  last_seen_at: string;
  is_active: number;
  last_hash: string;
  created_at: string;
  updated_at: string;
}

type AssetEventType = 'discovered' | 'changed' | 'missing' | 'restored';

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function loadRunQuery(): RunQuery {
  const cjsModule = typeof module === 'object' && typeof module.require === 'function'
    ? module
    : undefined;
  if (!cjsModule) {
    throw new Error('asset sync runQuery dependency is unavailable; pass dependencies.runQuery');
  }
  return (loadCjsDependency(cjsModule, ['./steampipe', '../steampipe']) as { runQuery: RunQuery }).runQuery;
}

function loadListS3Buckets(): ListS3Buckets {
  const cjsModule = typeof module === 'object' && typeof module.require === 'function'
    ? module
    : undefined;
  if (!cjsModule) {
    throw new Error('S3 asset sync dependency is unavailable; pass dependencies.listS3Buckets');
  }
  return (loadCjsDependency(cjsModule, ['./s3-sdk-sync', '../s3-sdk-sync']) as { listS3Buckets: ListS3Buckets }).listS3Buckets;
}

function loadAssetInventoryConfig(): Partial<AssetInventoryRuntimeConfig> | undefined {
  const cjsModule = typeof module === 'object' && typeof module.require === 'function'
    ? module
    : undefined;
  if (!cjsModule) {
    throw new Error('asset inventory config dependency is unavailable; pass dependencies.getAssetInventoryConfig');
  }
  const { getConfig } = loadCjsDependency(cjsModule, ['./app-config', '../app-config']) as {
    getConfig: () => { assetInventory?: Partial<AssetInventoryRuntimeConfig> };
  };
  return getConfig().assetInventory;
}

function loadOpenAssetDb(): (dbPath?: string) => AssetDb {
  return defaultOpenAssetDb;
}

function loadCjsDependency(cjsModule: NodeModule, moduleIds: string[]): unknown {
  const errors: string[] = [];

  for (const moduleId of moduleIds) {
    try {
      return cjsModule.require(moduleId);
    } catch (err) {
      errors.push(`${moduleId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`unable to load asset sync dependency (${errors.join('; ')})`);
}

function insertSyncRun(db: AssetDb, runId: string, startedAt: string, summary: AssetSyncRunSummary): void {
  db.prepare(`
    insert into asset_sync_runs (
      id, status, started_at, summary_json
    ) values (
      @id, 'running', @startedAt, @summaryJson
    )
  `).run({
    id: runId,
    startedAt,
    summaryJson: JSON.stringify(summary),
  });
}

function updateSyncRun(
  db: AssetDb,
  runId: string,
  status: 'completed' | 'partial' | 'failed',
  summary: AssetSyncRunSummary,
): void {
  db.prepare(`
    update asset_sync_runs set
      status = @status,
      finished_at = @finishedAt,
      summary_json = @summaryJson,
      error = @error
    where id = @id
  `).run({
    id: runId,
    status,
    finishedAt: summary.finishedAt,
    summaryJson: JSON.stringify(summary),
    error: summary.failed.map((failure) => `${failure.resourceType}: ${failure.error}`).join('\n'),
  });
}

function safeUpdateSyncRun(
  db: AssetDb,
  runId: string,
  status: 'completed' | 'partial' | 'failed',
  summary: AssetSyncRunSummary,
): void {
  try {
    updateSyncRun(db, runId, status, summary);
  } catch {
    // The sync summary is the primary result; run history is best-effort.
  }
}

function syncRunStatus(summary: AssetSyncRunSummary): 'completed' | 'partial' | 'failed' {
  if (summary.failed.length === 0) return 'completed';
  if (summary.selected.length === 0) return 'failed';
  const selectedFailures = summary.failed.filter((failure) => summary.selected.includes(failure.resourceType));
  if (selectedFailures.length >= summary.selected.length) return 'failed';
  return 'partial';
}

export function upsertDiscoveredAssets(db: AssetDb, assets: AssetRecord[], now: string): AssetSyncSummary {
  const summary: AssetSyncSummary = { discovered: 0, changed: 0, rediscovered: 0 };
  const findAsset = db.prepare('select * from asset_records where id = ?');
  const insertAsset = db.prepare(`
    insert into asset_records (
      id, provider, account_id, account_name, region, service, resource_type,
      resource_id, resource_name, arn, status, native_state, tags_json,
      source_table, source_updated_at, first_discovered_at, last_seen_at,
      is_active, last_hash, created_at, updated_at
    ) values (
      @id, @provider, @accountId, @accountName, @region, @service, @resourceType,
      @resourceId, @resourceName, @arn, @status, @nativeState, @tagsJson,
      @sourceTable, @sourceUpdatedAt, @firstDiscoveredAt, @lastSeenAt,
      @isActive, @lastHash, @createdAt, @updatedAt
    )
  `);
  const updateAsset = db.prepare(`
    update asset_records set
      account_name = @accountName,
      resource_name = @resourceName,
      arn = @arn,
      status = @status,
      native_state = @nativeState,
      tags_json = @tagsJson,
      source_table = @sourceTable,
      source_updated_at = @sourceUpdatedAt,
      last_seen_at = @lastSeenAt,
      is_active = @isActive,
      last_hash = @lastHash,
      updated_at = @updatedAt
    where id = @id
  `);
  const touchAsset = db.prepare(`
    update asset_records set
      source_updated_at = @sourceUpdatedAt,
      last_seen_at = @lastSeenAt,
      is_active = 1,
      updated_at = @updatedAt
    where id = @id
  `);
  const insertEvent = makeInsertEventStatement(db);

  db.transaction((records: AssetRecord[]) => {
    for (const asset of records) {
      const existing = findAsset.get(asset.id) as AssetRecordRow | undefined;
      const normalizedAsset = withSyncTimestamps(asset, now);

      if (!existing) {
        insertAsset.run(toSqlParams(normalizedAsset));
        insertEvent.run(makeEventParams({
          assetId: normalizedAsset.id,
          eventType: 'discovered',
          summary: `Discovered ${normalizedAsset.resourceType} ${normalizedAsset.resourceName}`,
          afterJson: normalizedAsset,
          now,
        }));
        summary.discovered += 1;
        continue;
      }

      const changed = existing.last_hash !== normalizedAsset.lastHash;
      const wasInactive = existing.is_active === 0;

      const nextAsset = {
        ...normalizedAsset,
        firstDiscoveredAt: existing.first_discovered_at,
        createdAt: existing.created_at,
        isActive: true,
      };

      if (changed || wasInactive) {
        updateAsset.run(toSqlParams(nextAsset));
      } else {
        touchAsset.run({
          id: normalizedAsset.id,
          sourceUpdatedAt: normalizedAsset.sourceUpdatedAt,
          lastSeenAt: now,
          updatedAt: now,
        });
      }

      if (changed) {
        insertEvent.run(makeEventParams({
          assetId: normalizedAsset.id,
          eventType: 'changed',
          summary: `Changed ${normalizedAsset.resourceType} ${normalizedAsset.resourceName}`,
          beforeJson: rowToAssetRecord(existing),
          afterJson: nextAsset,
          now,
        }));
        summary.changed += 1;
      }

      if (wasInactive) {
        insertEvent.run(makeEventParams({
          assetId: normalizedAsset.id,
          eventType: 'restored',
          summary: `Restored ${normalizedAsset.resourceType} ${normalizedAsset.resourceName}`,
          beforeJson: rowToAssetRecord(existing),
          afterJson: nextAsset,
          now,
        }));
        summary.rediscovered += 1;
      }
    }
  })(assets);

  return summary;
}

export function markMissingAssets(db: AssetDb, seenIds: Set<string>, now: string, scope?: AssetMissingScope): number {
  const activeAssetsQuery = makeActiveAssetsQuery(scope);
  const activeAssets = db.prepare(activeAssetsQuery.sql);
  const markInactive = db.prepare('update asset_records set is_active = 0, updated_at = ? where id = ?');
  const insertEvent = makeInsertEventStatement(db);
  let missing = 0;

  db.transaction(() => {
    const rows = activeAssets.all(activeAssetsQuery.params) as AssetRecordRow[];
    for (const row of rows) {
      if (seenIds.has(row.id)) continue;

      markInactive.run(now, row.id);
      insertEvent.run(makeEventParams({
        assetId: row.id,
        eventType: 'missing',
        summary: `Missing ${row.resource_type} ${row.resource_name}`,
        beforeJson: rowToAssetRecord(row),
        afterJson: { ...rowToAssetRecord(row), isActive: false, updatedAt: now },
        now,
      }));
      missing += 1;
    }
  })();

  return missing;
}

function makeActiveAssetsQuery(scope?: AssetMissingScope): { sql: string; params: Record<string, string> } {
  const conditions = ['is_active = 1'];
  const params: Record<string, string> = {};

  addInCondition(conditions, params, 'account_id', 'accountId', scope?.accountIds);
  addInCondition(conditions, params, 'region', 'region', scope?.regions);
  addInCondition(conditions, params, 'service', 'service', scope?.services);
  addInCondition(conditions, params, 'resource_type', 'resourceType', scope?.resourceTypes);
  addInCondition(conditions, params, 'source_table', 'sourceTable', scope?.sourceTables);

  return {
    sql: `select * from asset_records where ${conditions.join(' and ')}`,
    params,
  };
}

function addInCondition(
  conditions: string[],
  params: Record<string, string>,
  column: string,
  paramPrefix: string,
  values?: string[],
): void {
  if (!values?.length) return;

  const placeholders = values.map((value, index) => {
    const name = `${paramPrefix}${index}`;
    params[name] = value;
    return `@${name}`;
  });
  conditions.push(`${column} in (${placeholders.join(', ')})`);
}

function makeInsertEventStatement(db: AssetDb) {
  return db.prepare(`
    insert into asset_change_events (
      id, asset_id, event_type, event_source, summary, before_json,
      after_json, created_by, created_at
    ) values (
      @id, @assetId, @eventType, 'sync', @summary, @beforeJson,
      @afterJson, 'sync', @createdAt
    )
  `);
}

function withSyncTimestamps(asset: AssetRecord, now: string): AssetRecord {
  return {
    ...asset,
    lastSeenAt: now,
    updatedAt: now,
  };
}

function toSqlParams(asset: AssetRecord): Record<string, unknown> {
  return {
    id: asset.id,
    provider: asset.provider,
    accountId: asset.accountId,
    accountName: asset.accountName,
    region: asset.region,
    service: asset.service,
    resourceType: asset.resourceType,
    resourceId: asset.resourceId,
    resourceName: asset.resourceName,
    arn: asset.arn,
    status: asset.status,
    nativeState: asset.nativeState,
    tagsJson: JSON.stringify(asset.tags),
    sourceTable: asset.sourceTable,
    sourceUpdatedAt: asset.sourceUpdatedAt,
    firstDiscoveredAt: asset.firstDiscoveredAt,
    lastSeenAt: asset.lastSeenAt,
    isActive: asset.isActive ? 1 : 0,
    lastHash: asset.lastHash,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

function makeEventParams(input: {
  assetId: string;
  eventType: AssetEventType;
  summary: string;
  beforeJson?: unknown;
  afterJson?: unknown;
  now: string;
}): Record<string, unknown> {
  return {
    id: randomUUID(),
    assetId: input.assetId,
    eventType: input.eventType,
    summary: input.summary,
    beforeJson: JSON.stringify(input.beforeJson ?? {}),
    afterJson: JSON.stringify(input.afterJson ?? {}),
    createdAt: input.now,
  };
}

function rowToAssetRecord(row: AssetRecordRow): AssetRecord {
  return {
    id: row.id,
    provider: 'aws',
    accountId: row.account_id,
    accountName: row.account_name,
    region: row.region,
    service: row.service,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resourceName: row.resource_name,
    arn: row.arn,
    status: row.status,
    nativeState: row.native_state,
    tags: parseTags(row.tags_json),
    sourceTable: row.source_table,
    sourceUpdatedAt: row.source_updated_at,
    firstDiscoveredAt: row.first_discovered_at,
    lastSeenAt: row.last_seen_at,
    isActive: row.is_active === 1,
    lastHash: row.last_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTags(tagsJson: string): Record<string, unknown> {
  try {
    const tags = JSON.parse(tagsJson) as unknown;
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return {};
    return tags as Record<string, unknown>;
  } catch {
    return {};
  }
}
