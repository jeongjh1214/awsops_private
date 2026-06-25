import { randomUUID } from 'crypto';
import type { AssetDb } from './asset-db';

export interface S3GovernanceFilters {
  accountId?: string;
  phase?: string;
  ownerTeam?: string;
  active?: boolean;
  containsPersonalInfo?: boolean;
  piiRetentionAware?: boolean;
  piiRetentionApplied?: boolean;
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
  stable_key: string;
  account_id: string;
  account_name: string;
  phase: string;
  bucket_name: string;
  owner_team: string;
  purpose: string;
  history: string;
  contains_personal_info: number | null;
  pii_retention_aware: number | null;
  pii_retention_applied: number | null;
  pii_retention_period: string;
  remarks: string;
  updated_by: string;
  updated_at: string;
  created_at: string;
  asset_id: string | null;
  asset_region: string | null;
  asset_status: string | null;
  asset_is_active: number | null;
  asset_last_seen_at: string | null;
}

export interface S3GovernanceEventRow {
  id: string;
  stable_key: string;
  account_id: string;
  bucket_name: string;
  event_type: string;
  event_source: string;
  summary: string;
  before_json: string;
  after_json: string;
  created_by: string;
  created_at: string;
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

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface S3AssetSeedRow {
  account_id: string;
  account_name: string;
  bucket_name: string;
}

export function makeS3GovernanceStableKey(accountId: string, bucketName: string): string {
  return `${accountId.trim()}:${bucketName.trim()}`;
}

export function listS3GovernanceRecords(
  db: AssetDb,
  filters: S3GovernanceFilters = {},
): S3GovernanceListResult {
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);
  const query = makeListWhereClause(filters);

  const rows = db.prepare(`
    select
      g.*,
      r.id as asset_id,
      r.region as asset_region,
      r.status as asset_status,
      r.is_active as asset_is_active,
      r.last_seen_at as asset_last_seen_at
    from s3_governance_records g
    left join asset_records r
      on r.account_id = g.account_id
      and r.service = 's3'
      and r.resource_type = 's3_bucket'
      and r.resource_id = g.bucket_name
    ${query.whereSql}
    order by coalesce(r.is_active, 0) desc, g.account_id asc, g.bucket_name asc
    limit @limit offset @offset
  `).all({ ...query.params, limit, offset }) as S3GovernanceRow[];

  const totalRow = db.prepare(`
    select count(*) as total
    from s3_governance_records g
    left join asset_records r
      on r.account_id = g.account_id
      and r.service = 's3'
      and r.resource_type = 's3_bucket'
      and r.resource_id = g.bucket_name
    ${query.whereSql}
  `).get(query.params) as { total: number };

  return {
    rows,
    total: totalRow.total,
    limit,
    offset,
  };
}

export function getS3GovernanceRecord(db: AssetDb, stableKey: string): S3GovernanceDetail | null {
  const row = db.prepare(`
    select
      g.*,
      r.id as asset_id,
      r.region as asset_region,
      r.status as asset_status,
      r.is_active as asset_is_active,
      r.last_seen_at as asset_last_seen_at
    from s3_governance_records g
    left join asset_records r
      on r.account_id = g.account_id
      and r.service = 's3'
      and r.resource_type = 's3_bucket'
      and r.resource_id = g.bucket_name
    where g.stable_key = @stableKey
  `).get({ stableKey }) as S3GovernanceRow | undefined;

  if (!row) return null;

  const events = db.prepare(`
    select *
    from s3_governance_events
    where stable_key = @stableKey
    order by created_at desc, id desc
    limit 100
  `).all({ stableKey }) as S3GovernanceEventRow[];

  return { ...row, events };
}

export function updateS3GovernanceRecord(
  db: AssetDb,
  input: S3GovernanceUpdateInput,
  now: string = new Date().toISOString(),
): boolean {
  const accountId = input.accountId.trim();
  const bucketName = input.bucketName.trim();
  if (!accountId || !bucketName) return false;

  const stableKey = makeS3GovernanceStableKey(accountId, bucketName);
  const existing = getStoredGovernanceRecord(db, stableKey);
  const before = existing
    ? sqlRowToSnapshot(existing)
    : defaultGovernanceSnapshot(stableKey, accountId, bucketName, now);
  const after = applyGovernanceInput(before, input, now);
  const eventType = existing ? 'governance_updated' : 'governance_created';

  db.transaction(() => {
    db.prepare(`
      insert into s3_governance_records (
        stable_key,
        account_id,
        account_name,
        phase,
        bucket_name,
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
      ) values (
        @stableKey,
        @accountId,
        @accountName,
        @phase,
        @bucketName,
        @ownerTeam,
        @purpose,
        @history,
        @containsPersonalInfoSql,
        @piiRetentionAwareSql,
        @piiRetentionAppliedSql,
        @piiRetentionPeriod,
        @remarks,
        @updatedBy,
        @updatedAt,
        @createdAt
      )
      on conflict(stable_key) do update set
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
    `).run(snapshotToSqlParams(after));

    db.prepare(`
      insert into s3_governance_events (
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
      ) values (
        @id,
        @stableKey,
        @accountId,
        @bucketName,
        @eventType,
        'user',
        @summary,
        @beforeJson,
        @afterJson,
        @createdBy,
        @createdAt
      )
    `).run({
      id: randomUUID(),
      stableKey,
      accountId,
      bucketName,
      eventType,
      summary: `${eventType === 'governance_created' ? 'Created' : 'Updated'} S3 governance record for ${bucketName}`,
      beforeJson: JSON.stringify(existing ? before : {}),
      afterJson: JSON.stringify(after),
      createdBy: after.updatedBy,
      createdAt: now,
    });
  })();

  return true;
}

export function seedS3GovernanceRecordsFromAssets(
  db: AssetDb,
  input: S3GovernanceSeedInput = {},
  now: string = new Date().toISOString(),
): S3GovernanceSeedSummary {
  const accountId = input.accountId?.trim();
  const params: Record<string, unknown> = {};
  const accountCondition = accountId ? 'and account_id = @accountId' : '';
  if (accountId) params.accountId = accountId;

  const assets = db.prepare(`
    select
      account_id,
      account_name,
      resource_id as bucket_name
    from asset_records
    where service = 's3'
      and resource_type = 's3_bucket'
      ${accountCondition}
    order by account_id asc, resource_id asc
  `).all(params) as S3AssetSeedRow[];

  let created = 0;
  let skipped = 0;
  const updatedBy = input.updatedBy?.trim() || 'asset-seed';

  db.transaction(() => {
    for (const asset of assets) {
      const stableKey = makeS3GovernanceStableKey(asset.account_id, asset.bucket_name);
      if (getStoredGovernanceRecord(db, stableKey)) {
        skipped += 1;
        continue;
      }

      const snapshot = defaultGovernanceSnapshot(stableKey, asset.account_id, asset.bucket_name, now);
      snapshot.accountName = asset.account_name;
      snapshot.updatedBy = updatedBy;

      db.prepare(`
        insert into s3_governance_records (
          stable_key,
          account_id,
          account_name,
          phase,
          bucket_name,
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
        ) values (
          @stableKey,
          @accountId,
          @accountName,
          @phase,
          @bucketName,
          @ownerTeam,
          @purpose,
          @history,
          @containsPersonalInfoSql,
          @piiRetentionAwareSql,
          @piiRetentionAppliedSql,
          @piiRetentionPeriod,
          @remarks,
          @updatedBy,
          @updatedAt,
          @createdAt
        )
      `).run(snapshotToSqlParams(snapshot));

      db.prepare(`
        insert into s3_governance_events (
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
        ) values (
          @id,
          @stableKey,
          @accountId,
          @bucketName,
          'governance_seeded',
          'sync',
          @summary,
          '{}',
          @afterJson,
          @createdBy,
          @createdAt
        )
      `).run({
        id: randomUUID(),
        stableKey,
        accountId: asset.account_id,
        bucketName: asset.bucket_name,
        summary: `Seeded S3 governance record from collected asset ${asset.bucket_name}`,
        afterJson: JSON.stringify(snapshot),
        createdBy: updatedBy,
        createdAt: now,
      });

      created += 1;
    }
  })();

  return {
    scanned: assets.length,
    created,
    skipped,
  };
}

function makeListWhereClause(filters: S3GovernanceFilters): {
  whereSql: string;
  params: Record<string, unknown>;
} {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  addTextFilter(conditions, params, 'g.account_id', 'accountId', filters.accountId);
  addTextFilter(conditions, params, 'g.phase', 'phase', filters.phase);
  addTextFilter(conditions, params, 'g.owner_team', 'ownerTeam', filters.ownerTeam);
  addBooleanFilter(conditions, params, 'g.contains_personal_info', 'containsPersonalInfo', filters.containsPersonalInfo);
  addBooleanFilter(conditions, params, 'g.pii_retention_aware', 'piiRetentionAware', filters.piiRetentionAware);
  addBooleanFilter(conditions, params, 'g.pii_retention_applied', 'piiRetentionApplied', filters.piiRetentionApplied);

  if (filters.active !== undefined) {
    conditions.push(filters.active
      ? 'coalesce(r.is_active, 0) = 1'
      : 'coalesce(r.is_active, 0) = 0');
  }

  const q = filters.q?.trim();
  if (q) {
    conditions.push(`(
      g.account_name like @q
      or g.account_id like @q
      or g.bucket_name like @q
      or g.owner_team like @q
      or g.purpose like @q
      or g.history like @q
      or g.remarks like @q
    )`);
    params.q = `%${q}%`;
  }

  return {
    whereSql: conditions.length ? `where ${conditions.join(' and ')}` : '',
    params,
  };
}

function addTextFilter(
  conditions: string[],
  params: Record<string, unknown>,
  column: string,
  paramName: string,
  value?: string,
): void {
  if (value === undefined || value.trim() === '') return;
  conditions.push(`${column} = @${paramName}`);
  params[paramName] = value.trim();
}

function addBooleanFilter(
  conditions: string[],
  params: Record<string, unknown>,
  column: string,
  paramName: string,
  value?: boolean,
): void {
  if (value === undefined) return;
  conditions.push(`${column} = @${paramName}`);
  params[paramName] = value ? 1 : 0;
}

function getStoredGovernanceRecord(db: AssetDb, stableKey: string): S3GovernanceRow | undefined {
  return db.prepare('select * from s3_governance_records where stable_key = @stableKey')
    .get({ stableKey }) as S3GovernanceRow | undefined;
}

function defaultGovernanceSnapshot(
  stableKey: string,
  accountId: string,
  bucketName: string,
  now: string,
): S3GovernanceSnapshot {
  return {
    stableKey,
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

function sqlRowToSnapshot(row: S3GovernanceRow): S3GovernanceSnapshot {
  return {
    stableKey: row.stable_key,
    accountId: row.account_id,
    accountName: row.account_name,
    phase: row.phase,
    bucketName: row.bucket_name,
    ownerTeam: row.owner_team,
    purpose: row.purpose,
    history: row.history,
    containsPersonalInfo: toNullableBoolean(row.contains_personal_info),
    piiRetentionAware: toNullableBoolean(row.pii_retention_aware),
    piiRetentionApplied: toNullableBoolean(row.pii_retention_applied),
    piiRetentionPeriod: row.pii_retention_period,
    remarks: row.remarks,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
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

function snapshotToSqlParams(snapshot: S3GovernanceSnapshot): Record<string, unknown> {
  return {
    stableKey: snapshot.stableKey,
    accountId: snapshot.accountId,
    accountName: snapshot.accountName,
    phase: snapshot.phase,
    bucketName: snapshot.bucketName,
    ownerTeam: snapshot.ownerTeam,
    purpose: snapshot.purpose,
    history: snapshot.history,
    containsPersonalInfoSql: nullableBooleanToSql(snapshot.containsPersonalInfo),
    piiRetentionAwareSql: nullableBooleanToSql(snapshot.piiRetentionAware),
    piiRetentionAppliedSql: nullableBooleanToSql(snapshot.piiRetentionApplied),
    piiRetentionPeriod: snapshot.piiRetentionPeriod,
    remarks: snapshot.remarks,
    updatedBy: snapshot.updatedBy,
    updatedAt: snapshot.updatedAt,
    createdAt: snapshot.createdAt,
  };
}

function nullableBooleanToSql(value: boolean | null): number | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

function toNullableBoolean(value: number | null): boolean | null {
  if (value === null) return null;
  return value === 1;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value as number)));
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value as number));
}
