import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '@/lib/db';
import { getPrivateGovernanceDbProvider } from './private-db-provider';
import { openPrivateSqliteDb, type PrivateSqliteDb } from './sqlite-db';

export interface S3GovernanceFilters {
  accountId?: string;
  phase?: string;
  ownerTeam?: string;
  active?: boolean;
  containsPersonalInfo?: boolean | null;
  piiRetentionAware?: boolean | null;
  piiRetentionApplied?: boolean | null;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface S3GovernanceUpdateInput {
  accountId: string;
  accountName?: string;
  phase?: string;
  bucketName: string;
  ownerTeam?: string;
  purpose?: string;
  history?: string;
  containsPersonalInfo?: boolean | null;
  piiRetentionAware?: boolean | null;
  piiRetentionApplied?: boolean | null;
  piiRetentionPeriod?: string;
  remarks?: string;
  updatedBy?: string;
}

export interface S3GovernanceSeedInput {
  accountId?: string;
  updatedBy?: string;
}

export interface S3GovernanceSeedSummary {
  scanned: number;
  created: number;
  skipped: number;
}

export interface S3GovernanceListResult {
  rows: S3GovernanceRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface S3GovernanceDetail extends S3GovernanceRow {
  events: S3GovernanceEventRow[];
}

export interface S3GovernanceRow {
  stableKey: string;
  accountId: string;
  accountName: string;
  phase: string;
  bucketName: string;
  ownerTeam: string;
  purpose: string;
  history: string;
  containsPersonalInfo: boolean | null;
  piiRetentionAware: boolean | null;
  piiRetentionApplied: boolean | null;
  piiRetentionPeriod: string;
  remarks: string;
  updatedBy: string;
  updatedAt: string;
  createdAt: string;
  assetRegion: string | null;
  assetCapturedAt: string | null;
  assetData: Record<string, unknown> | null;
  active: boolean;
}

export interface S3GovernanceEventRow {
  id: string;
  stableKey: string;
  accountId: string;
  bucketName: string;
  eventType: string;
  eventSource: string;
  summary: string;
  beforeJson: Record<string, unknown>;
  afterJson: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

interface S3GovernanceSnapshot {
  stableKey: string;
  accountId: string;
  accountName: string;
  phase: string;
  bucketName: string;
  ownerTeam: string;
  purpose: string;
  history: string;
  containsPersonalInfo: boolean | null;
  piiRetentionAware: boolean | null;
  piiRetentionApplied: boolean | null;
  piiRetentionPeriod: string;
  remarks: string;
  updatedBy: string;
  updatedAt: string;
  createdAt: string;
}

interface S3InventorySeedRow {
  account_id: string;
  account_name: string | null;
  bucket_name: string;
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export function makeS3GovernanceStableKey(accountId: string, bucketName: string): string {
  return `${accountId.trim()}:${bucketName.trim()}`;
}

export async function listS3GovernanceRecords(
  filters: S3GovernanceFilters = {},
): Promise<S3GovernanceListResult> {
  if (getPrivateGovernanceDbProvider() === 'sqlite') {
    return listS3GovernanceRecordsSqlite(filters);
  }
  return listS3GovernanceRecordsAurora(filters);
}

async function listS3GovernanceRecordsAurora(
  filters: S3GovernanceFilters = {},
): Promise<S3GovernanceListResult> {
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);
  const query = makeListWhereClause(filters);
  const pageParams = [...query.params, limit, offset];

  const rowsResult = await getPool().query(
    `
      SELECT
        g.*,
        r.region AS asset_region,
        r.captured_at AS asset_captured_at,
        r.data AS asset_data,
        (r.resource_id IS NOT NULL) AS active
      FROM s3_governance_records g
      LEFT JOIN LATERAL (
        SELECT resource_id, region, captured_at, data
        FROM inventory_resources r
        WHERE r.resource_type = 's3'
          AND r.account_id = g.account_id
          AND r.resource_id = g.bucket_name
        ORDER BY r.captured_at DESC
        LIMIT 1
      ) r ON true
      ${query.whereSql}
      ORDER BY active DESC, g.account_id ASC, g.bucket_name ASC
      LIMIT $${query.params.length + 1} OFFSET $${query.params.length + 2}
    `,
    pageParams,
  );

  const totalResult = await getPool().query(
    `
      SELECT COUNT(*)::int AS total
      FROM s3_governance_records g
      LEFT JOIN LATERAL (
        SELECT resource_id
        FROM inventory_resources r
        WHERE r.resource_type = 's3'
          AND r.account_id = g.account_id
          AND r.resource_id = g.bucket_name
        ORDER BY r.captured_at DESC
        LIMIT 1
      ) r ON true
      ${query.whereSql}
    `,
    query.params,
  );

  return {
    rows: rowsResult.rows.map(mapGovernanceRow),
    total: Number(totalResult.rows[0]?.total ?? 0),
    limit,
    offset,
  };
}

export async function getS3GovernanceRecord(stableKey: string): Promise<S3GovernanceDetail | null> {
  if (getPrivateGovernanceDbProvider() === 'sqlite') {
    return getS3GovernanceRecordSqlite(stableKey);
  }
  return getS3GovernanceRecordAurora(stableKey);
}

async function getS3GovernanceRecordAurora(stableKey: string): Promise<S3GovernanceDetail | null> {
  const key = parseStableKey(stableKey);
  if (!key) return null;

  const rowResult = await getPool().query(
    `
      SELECT
        g.*,
        r.region AS asset_region,
        r.captured_at AS asset_captured_at,
        r.data AS asset_data,
        (r.resource_id IS NOT NULL) AS active
      FROM s3_governance_records g
      LEFT JOIN LATERAL (
        SELECT resource_id, region, captured_at, data
        FROM inventory_resources r
        WHERE r.resource_type = 's3'
          AND r.account_id = g.account_id
          AND r.resource_id = g.bucket_name
        ORDER BY r.captured_at DESC
        LIMIT 1
      ) r ON true
      WHERE g.account_id = $1 AND g.bucket_name = $2
    `,
    [key.accountId, key.bucketName],
  );
  const row = rowResult.rows[0];
  if (!row) return null;

  const eventsResult = await getPool().query(
    `
      SELECT *
      FROM s3_governance_events
      WHERE account_id = $1 AND bucket_name = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `,
    [key.accountId, key.bucketName],
  );

  return {
    ...mapGovernanceRow(row),
    events: eventsResult.rows.map(mapGovernanceEventRow),
  };
}

export async function updateS3GovernanceRecord(
  input: S3GovernanceUpdateInput,
  now: string = new Date().toISOString(),
): Promise<boolean> {
  if (getPrivateGovernanceDbProvider() === 'sqlite') {
    return updateS3GovernanceRecordSqlite(input, now);
  }
  return updateS3GovernanceRecordAurora(input, now);
}

async function updateS3GovernanceRecordAurora(
  input: S3GovernanceUpdateInput,
  now: string,
): Promise<boolean> {
  const accountId = input.accountId.trim();
  const bucketName = input.bucketName.trim();
  if (!accountId || !bucketName) return false;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const existing = await getStoredGovernanceSnapshot(client, accountId, bucketName);
    const before = existing ?? defaultGovernanceSnapshot(accountId, bucketName, now);
    const after = applyGovernanceInput(before, input, now);
    const eventType = existing ? 'governance_updated' : 'governance_created';

    await client.query(
      `
        INSERT INTO s3_governance_records (
          account_id,
          bucket_name,
          account_name,
          phase,
          owner_team,
          purpose,
          history,
          contains_personal_info,
          pii_retention_aware,
          pii_retention_applied,
          pii_retention_period,
          remarks,
          updated_by,
          updated_at,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15
        )
        ON CONFLICT (account_id, bucket_name) DO UPDATE SET
          account_name = EXCLUDED.account_name,
          phase = EXCLUDED.phase,
          owner_team = EXCLUDED.owner_team,
          purpose = EXCLUDED.purpose,
          history = EXCLUDED.history,
          contains_personal_info = EXCLUDED.contains_personal_info,
          pii_retention_aware = EXCLUDED.pii_retention_aware,
          pii_retention_applied = EXCLUDED.pii_retention_applied,
          pii_retention_period = EXCLUDED.pii_retention_period,
          remarks = EXCLUDED.remarks,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at
      `,
      snapshotToSqlParams(after),
    );

    await client.query(
      `
        INSERT INTO s3_governance_events (
          account_id,
          bucket_name,
          event_type,
          event_source,
          summary,
          before_json,
          after_json,
          created_by,
          created_at
        ) VALUES ($1, $2, $3, 'user', $4, $5::jsonb, $6::jsonb, $7, $8)
      `,
      [
        accountId,
        bucketName,
        eventType,
        `${eventType === 'governance_created' ? 'Created' : 'Updated'} S3 governance record for ${bucketName}`,
        JSON.stringify(existing ? before : {}),
        JSON.stringify(after),
        after.updatedBy,
        now,
      ],
    );

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function seedS3GovernanceRecordsFromInventory(
  input: S3GovernanceSeedInput = {},
  now: string = new Date().toISOString(),
): Promise<S3GovernanceSeedSummary> {
  if (getPrivateGovernanceDbProvider() === 'sqlite') {
    return seedS3GovernanceRecordsFromInventorySqlite(input, now);
  }
  return seedS3GovernanceRecordsFromInventoryAurora(input, now);
}

async function seedS3GovernanceRecordsFromInventoryAurora(
  input: S3GovernanceSeedInput,
  now: string,
): Promise<S3GovernanceSeedSummary> {
  const accountId = input.accountId?.trim();
  const params: unknown[] = [];
  const accountCondition = accountId ? `AND account_id = $${pushParam(params, accountId)}` : '';
  const updatedBy = input.updatedBy?.trim() || 'inventory-seed';

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const assetsResult = await client.query(
      `
        SELECT DISTINCT ON (account_id, resource_id)
          account_id,
          NULLIF(data->>'account_name', '') AS account_name,
          resource_id AS bucket_name
        FROM inventory_resources
        WHERE resource_type = 's3'
          ${accountCondition}
        ORDER BY account_id ASC, resource_id ASC, captured_at DESC
      `,
      params,
    );
    const assets = assetsResult.rows as S3InventorySeedRow[];

    let created = 0;
    let skipped = 0;
    for (const asset of assets) {
      const existing = await getStoredGovernanceSnapshot(client, asset.account_id, asset.bucket_name);
      if (existing) {
        skipped += 1;
        continue;
      }

      const snapshot = {
        ...defaultGovernanceSnapshot(asset.account_id, asset.bucket_name, now),
        accountName: asset.account_name ?? '',
        updatedBy,
      };

      await client.query(
        `
          INSERT INTO s3_governance_records (
            account_id,
            bucket_name,
            account_name,
            phase,
            owner_team,
            purpose,
            history,
            contains_personal_info,
            pii_retention_aware,
            pii_retention_applied,
            pii_retention_period,
            remarks,
            updated_by,
            updated_at,
            created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14, $15
          )
        `,
        snapshotToSqlParams(snapshot),
      );

      await client.query(
        `
          INSERT INTO s3_governance_events (
            account_id,
            bucket_name,
            event_type,
            event_source,
            summary,
            before_json,
            after_json,
            created_by,
            created_at
          ) VALUES ($1, $2, 'governance_seeded', 'sync', $3, '{}'::jsonb, $4::jsonb, $5, $6)
        `,
        [
          asset.account_id,
          asset.bucket_name,
          `Seeded S3 governance record from inventory resource ${asset.bucket_name}`,
          JSON.stringify(snapshot),
          updatedBy,
          now,
        ],
      );

      created += 1;
    }

    await client.query('COMMIT');
    return { scanned: assets.length, created, skipped };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function listS3GovernanceRecordsSqlite(
  filters: S3GovernanceFilters = {},
): Promise<S3GovernanceListResult> {
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);
  const query = makeSqliteListWhereClause(filters);

  return withPrivateSqliteDb((db) => {
    const rows = db.prepare(`
      SELECT
        g.*,
        r.region AS asset_region,
        r.last_seen_at AS asset_captured_at,
        r.data_json AS asset_data,
        coalesce(r.is_active, 0) AS active
      FROM s3_governance_records g
      LEFT JOIN asset_records r
        ON r.id = (
          SELECT latest.id
          FROM asset_records latest
          WHERE latest.service = 's3'
            AND latest.resource_type IN ('s3', 's3_bucket')
            AND latest.account_id = g.account_id
            AND latest.resource_id = g.bucket_name
          ORDER BY latest.last_seen_at DESC, latest.id DESC
          LIMIT 1
        )
      ${query.whereSql}
      ORDER BY active DESC, g.account_id ASC, g.bucket_name ASC
      LIMIT @limit OFFSET @offset
    `).all({ ...query.params, limit, offset });

    const totalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM s3_governance_records g
      LEFT JOIN asset_records r
        ON r.id = (
          SELECT latest.id
          FROM asset_records latest
          WHERE latest.service = 's3'
            AND latest.resource_type IN ('s3', 's3_bucket')
            AND latest.account_id = g.account_id
            AND latest.resource_id = g.bucket_name
          ORDER BY latest.last_seen_at DESC, latest.id DESC
          LIMIT 1
        )
      ${query.whereSql}
    `).get(query.params);

    return {
      rows: rows.map(mapGovernanceRow),
      total: Number(totalRow?.total ?? 0),
      limit,
      offset,
    };
  });
}

async function getS3GovernanceRecordSqlite(stableKey: string): Promise<S3GovernanceDetail | null> {
  const key = parseStableKey(stableKey);
  if (!key) return null;

  return withPrivateSqliteDb((db) => {
    const row = db.prepare(`
      SELECT
        g.*,
        r.region AS asset_region,
        r.last_seen_at AS asset_captured_at,
        r.data_json AS asset_data,
        coalesce(r.is_active, 0) AS active
      FROM s3_governance_records g
      LEFT JOIN asset_records r
        ON r.id = (
          SELECT latest.id
          FROM asset_records latest
          WHERE latest.service = 's3'
            AND latest.resource_type IN ('s3', 's3_bucket')
            AND latest.account_id = g.account_id
            AND latest.resource_id = g.bucket_name
          ORDER BY latest.last_seen_at DESC, latest.id DESC
          LIMIT 1
        )
      WHERE g.account_id = @accountId AND g.bucket_name = @bucketName
    `).get({ accountId: key.accountId, bucketName: key.bucketName });
    if (!row) return null;

    const events = db.prepare(`
      SELECT *
      FROM s3_governance_events
      WHERE stable_key = @stableKey
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `).all({ stableKey });

    return {
      ...mapGovernanceRow(row),
      events: events.map(mapGovernanceEventRow),
    };
  });
}

async function updateS3GovernanceRecordSqlite(
  input: S3GovernanceUpdateInput,
  now: string,
): Promise<boolean> {
  const accountId = input.accountId.trim();
  const bucketName = input.bucketName.trim();
  if (!accountId || !bucketName) return false;

  return withPrivateSqliteDb((db) => {
    const writeRecord = db.transaction(() => {
      const existing = getStoredGovernanceSnapshotSqlite(db, accountId, bucketName);
      const before = existing ?? defaultGovernanceSnapshot(accountId, bucketName, now);
      const after = applyGovernanceInput(before, input, now);
      const eventType = existing ? 'governance_updated' : 'governance_created';

      upsertGovernanceSnapshotSqlite(db, after);
      insertGovernanceEventSqlite(db, {
        stableKey: after.stableKey,
        accountId,
        bucketName,
        eventType,
        eventSource: 'user',
        summary: `${eventType === 'governance_created' ? 'Created' : 'Updated'} S3 governance record for ${bucketName}`,
        beforeJson: existing ? before : {},
        afterJson: after,
        createdBy: after.updatedBy,
        createdAt: now,
      });
    });

    writeRecord();
    return true;
  });
}

async function seedS3GovernanceRecordsFromInventorySqlite(
  input: S3GovernanceSeedInput,
  now: string,
): Promise<S3GovernanceSeedSummary> {
  const accountId = input.accountId?.trim();
  const updatedBy = input.updatedBy?.trim() || 'inventory-seed';

  return withPrivateSqliteDb((db) => {
    const params = accountId ? { accountId } : {};
    const accountCondition = accountId ? 'AND account_id = @accountId' : '';
    const assets = db.prepare(`
      SELECT
        account_id,
        max(coalesce(account_name, '')) AS account_name,
        resource_id AS bucket_name
      FROM asset_records
      WHERE service = 's3'
        AND resource_type IN ('s3', 's3_bucket')
        AND coalesce(is_active, 0) = 1
        ${accountCondition}
      GROUP BY account_id, resource_id
      ORDER BY account_id ASC, resource_id ASC
    `).all(params) as unknown as S3InventorySeedRow[];

    let created = 0;
    let skipped = 0;
    const seedRecords = db.transaction(() => {
      for (const asset of assets) {
        const existing = getStoredGovernanceSnapshotSqlite(db, asset.account_id, asset.bucket_name);
        if (existing) {
          skipped += 1;
          continue;
        }

        const snapshot = {
          ...defaultGovernanceSnapshot(asset.account_id, asset.bucket_name, now),
          accountName: asset.account_name ?? '',
          updatedBy,
        };

        upsertGovernanceSnapshotSqlite(db, snapshot);
        insertGovernanceEventSqlite(db, {
          stableKey: snapshot.stableKey,
          accountId: asset.account_id,
          bucketName: asset.bucket_name,
          eventType: 'governance_seeded',
          eventSource: 'sync',
          summary: `Seeded S3 governance record from inventory resource ${asset.bucket_name}`,
          beforeJson: {},
          afterJson: snapshot,
          createdBy: updatedBy,
          createdAt: now,
        });
        created += 1;
      }
    });

    seedRecords();
    return { scanned: assets.length, created, skipped };
  });
}

function makeListWhereClause(filters: S3GovernanceFilters): {
  whereSql: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  addTextFilter(conditions, params, 'g.account_id', filters.accountId);
  addTextFilter(conditions, params, 'g.phase', filters.phase);
  addTextFilter(conditions, params, 'g.owner_team', filters.ownerTeam);
  addBooleanFilter(conditions, params, 'g.contains_personal_info', filters.containsPersonalInfo);
  addBooleanFilter(conditions, params, 'g.pii_retention_aware', filters.piiRetentionAware);
  addBooleanFilter(conditions, params, 'g.pii_retention_applied', filters.piiRetentionApplied);

  if (filters.active !== undefined) {
    conditions.push(filters.active ? 'r.resource_id IS NOT NULL' : 'r.resource_id IS NULL');
  }

  const q = filters.q?.trim();
  if (q) {
    const placeholder = `$${pushParam(params, `%${q}%`)}`;
    conditions.push(`(
      g.account_name ILIKE ${placeholder}
      OR g.account_id ILIKE ${placeholder}
      OR g.bucket_name ILIKE ${placeholder}
      OR g.owner_team ILIKE ${placeholder}
      OR g.purpose ILIKE ${placeholder}
      OR g.history ILIKE ${placeholder}
      OR g.remarks ILIKE ${placeholder}
    )`);
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function makeSqliteListWhereClause(filters: S3GovernanceFilters): {
  whereSql: string;
  params: Record<string, unknown>;
} {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  addSqliteTextFilter(conditions, params, 'g.account_id', 'accountId', filters.accountId);
  addSqliteTextFilter(conditions, params, 'g.phase', 'phase', filters.phase);
  addSqliteTextFilter(conditions, params, 'g.owner_team', 'ownerTeam', filters.ownerTeam);
  addSqliteBooleanFilter(conditions, params, 'g.contains_personal_info', 'containsPersonalInfo', filters.containsPersonalInfo);
  addSqliteBooleanFilter(conditions, params, 'g.pii_retention_aware', 'piiRetentionAware', filters.piiRetentionAware);
  addSqliteBooleanFilter(conditions, params, 'g.pii_retention_applied', 'piiRetentionApplied', filters.piiRetentionApplied);

  if (filters.active !== undefined) {
    conditions.push(filters.active ? 'coalesce(r.is_active, 0) = 1' : 'coalesce(r.is_active, 0) = 0');
  }

  const q = filters.q?.trim();
  if (q) {
    params.q = `%${q.toLowerCase()}%`;
    conditions.push(`(
      lower(g.account_name) LIKE @q
      OR lower(g.account_id) LIKE @q
      OR lower(g.bucket_name) LIKE @q
      OR lower(g.owner_team) LIKE @q
      OR lower(g.purpose) LIKE @q
      OR lower(g.history) LIKE @q
      OR lower(g.remarks) LIKE @q
    )`);
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function addTextFilter(conditions: string[], params: unknown[], column: string, value?: string): void {
  const trimmed = value?.trim();
  if (!trimmed) return;
  conditions.push(`${column} = $${pushParam(params, trimmed)}`);
}

function addBooleanFilter(
  conditions: string[],
  params: unknown[],
  column: string,
  value?: boolean | null,
): void {
  if (value === undefined) return;
  if (value === null) {
    conditions.push(`${column} IS NULL`);
    return;
  }
  conditions.push(`${column} = $${pushParam(params, value)}`);
}

function addSqliteTextFilter(
  conditions: string[],
  params: Record<string, unknown>,
  column: string,
  name: string,
  value?: string,
): void {
  const trimmed = value?.trim();
  if (!trimmed) return;
  conditions.push(`${column} = @${name}`);
  params[name] = trimmed;
}

function addSqliteBooleanFilter(
  conditions: string[],
  params: Record<string, unknown>,
  column: string,
  name: string,
  value?: boolean | null,
): void {
  if (value === undefined) return;
  if (value === null) {
    conditions.push(`${column} IS NULL`);
    return;
  }
  conditions.push(`${column} = @${name}`);
  params[name] = sqliteNullableBoolean(value);
}

async function getStoredGovernanceSnapshot(
  queryable: Queryable,
  accountId: string,
  bucketName: string,
): Promise<S3GovernanceSnapshot | null> {
  const result = await queryable.query(
    `
      SELECT *
      FROM s3_governance_records
      WHERE account_id = $1 AND bucket_name = $2
    `,
    [accountId, bucketName],
  );
  const row = result.rows[0];
  return row ? sqlRowToSnapshot(row) : null;
}

function getStoredGovernanceSnapshotSqlite(
  db: PrivateSqliteDb,
  accountId: string,
  bucketName: string,
): S3GovernanceSnapshot | null {
  const row = db.prepare(`
    SELECT *
    FROM s3_governance_records
    WHERE account_id = @accountId AND bucket_name = @bucketName
  `).get({ accountId, bucketName });
  return row ? sqlRowToSnapshot(row) : null;
}

function defaultGovernanceSnapshot(
  accountId: string,
  bucketName: string,
  now: string,
): S3GovernanceSnapshot {
  return {
    stableKey: makeS3GovernanceStableKey(accountId, bucketName),
    accountId,
    accountName: '',
    phase: '',
    bucketName,
    ownerTeam: '',
    purpose: '',
    history: '',
    containsPersonalInfo: null,
    piiRetentionAware: null,
    piiRetentionApplied: null,
    piiRetentionPeriod: '',
    remarks: '',
    updatedBy: '',
    updatedAt: now,
    createdAt: now,
  };
}

function sqlRowToSnapshot(row: Record<string, unknown>): S3GovernanceSnapshot {
  const accountId = String(row.account_id ?? '');
  const bucketName = String(row.bucket_name ?? '');
  return {
    stableKey: makeS3GovernanceStableKey(accountId, bucketName),
    accountId,
    accountName: String(row.account_name ?? ''),
    phase: String(row.phase ?? ''),
    bucketName,
    ownerTeam: String(row.owner_team ?? ''),
    purpose: String(row.purpose ?? ''),
    history: String(row.history ?? ''),
    containsPersonalInfo: toNullableBoolean(row.contains_personal_info),
    piiRetentionAware: toNullableBoolean(row.pii_retention_aware),
    piiRetentionApplied: toNullableBoolean(row.pii_retention_applied),
    piiRetentionPeriod: String(row.pii_retention_period ?? ''),
    remarks: String(row.remarks ?? ''),
    updatedBy: String(row.updated_by ?? ''),
    updatedAt: toIsoString(row.updated_at),
    createdAt: toIsoString(row.created_at),
  };
}

function applyGovernanceInput(
  before: S3GovernanceSnapshot,
  input: S3GovernanceUpdateInput,
  now: string,
): S3GovernanceSnapshot {
  const after = { ...before, updatedAt: now };

  applyStringField(after, input, 'accountName');
  applyStringField(after, input, 'phase');
  applyStringField(after, input, 'ownerTeam');
  applyStringField(after, input, 'purpose');
  applyStringField(after, input, 'history');
  applyStringField(after, input, 'piiRetentionPeriod');
  applyStringField(after, input, 'remarks');
  applyStringField(after, input, 'updatedBy');

  applyNullableBooleanField(after, input, 'containsPersonalInfo');
  applyNullableBooleanField(after, input, 'piiRetentionAware');
  applyNullableBooleanField(after, input, 'piiRetentionApplied');

  return after;
}

function applyStringField<K extends keyof S3GovernanceUpdateInput & keyof S3GovernanceSnapshot>(
  target: S3GovernanceSnapshot,
  input: S3GovernanceUpdateInput,
  key: K,
): void {
  if (input[key] !== undefined) {
    target[key] = String(input[key] ?? '').trim() as S3GovernanceSnapshot[K];
  }
}

function applyNullableBooleanField<K extends keyof S3GovernanceUpdateInput & keyof S3GovernanceSnapshot>(
  target: S3GovernanceSnapshot,
  input: S3GovernanceUpdateInput,
  key: K,
): void {
  if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined) {
    target[key] = input[key] as S3GovernanceSnapshot[K];
  }
}

function snapshotToSqlParams(snapshot: S3GovernanceSnapshot): unknown[] {
  return [
    snapshot.accountId,
    snapshot.bucketName,
    snapshot.accountName,
    snapshot.phase,
    snapshot.ownerTeam,
    snapshot.purpose,
    snapshot.history,
    snapshot.containsPersonalInfo,
    snapshot.piiRetentionAware,
    snapshot.piiRetentionApplied,
    snapshot.piiRetentionPeriod,
    snapshot.remarks,
    snapshot.updatedBy,
    snapshot.updatedAt,
    snapshot.createdAt,
  ];
}

function snapshotToSqliteParams(snapshot: S3GovernanceSnapshot): Record<string, unknown> {
  return {
    stableKey: snapshot.stableKey,
    accountId: snapshot.accountId,
    bucketName: snapshot.bucketName,
    accountName: snapshot.accountName,
    phase: snapshot.phase,
    ownerTeam: snapshot.ownerTeam,
    purpose: snapshot.purpose,
    history: snapshot.history,
    containsPersonalInfo: sqliteNullableBoolean(snapshot.containsPersonalInfo),
    piiRetentionAware: sqliteNullableBoolean(snapshot.piiRetentionAware),
    piiRetentionApplied: sqliteNullableBoolean(snapshot.piiRetentionApplied),
    piiRetentionPeriod: snapshot.piiRetentionPeriod,
    remarks: snapshot.remarks,
    updatedBy: snapshot.updatedBy,
    updatedAt: snapshot.updatedAt,
    createdAt: snapshot.createdAt,
  };
}

function upsertGovernanceSnapshotSqlite(db: PrivateSqliteDb, snapshot: S3GovernanceSnapshot): void {
  db.prepare(`
    INSERT INTO s3_governance_records (
      stable_key,
      account_id,
      bucket_name,
      account_name,
      phase,
      owner_team,
      purpose,
      history,
      contains_personal_info,
      pii_retention_aware,
      pii_retention_applied,
      pii_retention_period,
      remarks,
      updated_by,
      updated_at,
      created_at
    ) VALUES (
      @stableKey,
      @accountId,
      @bucketName,
      @accountName,
      @phase,
      @ownerTeam,
      @purpose,
      @history,
      @containsPersonalInfo,
      @piiRetentionAware,
      @piiRetentionApplied,
      @piiRetentionPeriod,
      @remarks,
      @updatedBy,
      @updatedAt,
      @createdAt
    )
    ON CONFLICT(stable_key) DO UPDATE SET
      account_name = excluded.account_name,
      phase = excluded.phase,
      owner_team = excluded.owner_team,
      purpose = excluded.purpose,
      history = excluded.history,
      contains_personal_info = excluded.contains_personal_info,
      pii_retention_aware = excluded.pii_retention_aware,
      pii_retention_applied = excluded.pii_retention_applied,
      pii_retention_period = excluded.pii_retention_period,
      remarks = excluded.remarks,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(snapshotToSqliteParams(snapshot));
}

function insertGovernanceEventSqlite(
  db: PrivateSqliteDb,
  event: {
    stableKey: string;
    accountId: string;
    bucketName: string;
    eventType: string;
    eventSource: string;
    summary: string;
    beforeJson: unknown;
    afterJson: unknown;
    createdBy: string;
    createdAt: string;
  },
): void {
  db.prepare(`
    INSERT INTO s3_governance_events (
      id,
      stable_key,
      account_id,
      bucket_name,
      event_type,
      event_source,
      summary,
      before_json,
      after_json,
      created_by,
      created_at
    ) VALUES (
      @id,
      @stableKey,
      @accountId,
      @bucketName,
      @eventType,
      @eventSource,
      @summary,
      @beforeJson,
      @afterJson,
      @createdBy,
      @createdAt
    )
  `).run({
    id: randomUUID(),
    stableKey: event.stableKey,
    accountId: event.accountId,
    bucketName: event.bucketName,
    eventType: event.eventType,
    eventSource: event.eventSource,
    summary: event.summary,
    beforeJson: JSON.stringify(event.beforeJson),
    afterJson: JSON.stringify(event.afterJson),
    createdBy: event.createdBy,
    createdAt: event.createdAt,
  });
}

function mapGovernanceRow(row: Record<string, unknown>): S3GovernanceRow {
  const snapshot = sqlRowToSnapshot(row);
  const active = Boolean(row.active);
  return {
    ...snapshot,
    assetRegion: stringOrNull(row.asset_region),
    assetCapturedAt: row.asset_captured_at == null ? null : toIsoString(row.asset_captured_at),
    assetData: normalizeNullableJsonObject(row.asset_data),
    active,
  };
}

function mapGovernanceEventRow(row: Record<string, unknown>): S3GovernanceEventRow {
  const accountId = String(row.account_id ?? '');
  const bucketName = String(row.bucket_name ?? '');
  return {
    id: String(row.id ?? ''),
    stableKey: makeS3GovernanceStableKey(accountId, bucketName),
    accountId,
    bucketName,
    eventType: String(row.event_type ?? ''),
    eventSource: String(row.event_source ?? ''),
    summary: String(row.summary ?? ''),
    beforeJson: normalizeJsonObject(row.before_json),
    afterJson: normalizeJsonObject(row.after_json),
    createdBy: String(row.created_by ?? ''),
    createdAt: toIsoString(row.created_at),
  };
}

function parseStableKey(stableKey: string): { accountId: string; bucketName: string } | null {
  const idx = stableKey.indexOf(':');
  if (idx <= 0 || idx === stableKey.length - 1) return null;
  return {
    accountId: stableKey.slice(0, idx).trim(),
    bucketName: stableKey.slice(idx + 1).trim(),
  };
}

function pushParam(params: unknown[], value: unknown): number {
  params.push(value);
  return params.length;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value as number)));
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value as number));
}

function toNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  return String(value).toLowerCase() === 'true';
}

function sqliteNullableBoolean(value: boolean | null): number | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

function stringOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeNullableJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || value === '') return null;
  return normalizeJsonObject(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withPrivateSqliteDb<T>(fn: (db: PrivateSqliteDb) => T): T {
  const db = openPrivateSqliteDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
