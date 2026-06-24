import { randomUUID } from 'crypto';
import type { AssetDb } from './asset-db';
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
