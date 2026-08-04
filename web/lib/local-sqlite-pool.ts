import { openPrivateSqliteDb, type PrivateSqliteDb } from './private-governance/sqlite-db';

export interface QueryResultLike<T = any> {
  rows: T[];
  rowCount: number;
}

export interface PoolClientLike {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResultLike<T>>;
  release(): void;
}

export interface PoolLike {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResultLike<T>>;
  connect(): Promise<PoolClientLike>;
}

interface InventoryRow {
  resource_id: string;
  region: string;
  account_id: string;
  resource_type: string;
  data: string | Record<string, unknown> | null;
  captured_at: string | null;
}

interface DiagnosisReportRow {
  id: number;
  worker_job_id: string | null;
  tier: string;
  status: string;
  requested_by: string;
  sources_used: string | string[] | null;
  summary: string | Record<string, unknown> | null;
  artifact_uri: string | null;
  error: string | null;
  created_at: string;
  model: string | null;
  title: string | null;
  tags: string | string[] | null;
  deleted_at: string | null;
  progress: string | Record<string, unknown> | null;
  parent_report_id?: number | null;
}

export function createLocalSqlitePool(): PoolLike {
  const db = openPrivateSqliteDb();
  ensureLocalAppSchema(db);

  const query = async <T = any>(sql: string, params: unknown[] = []): Promise<QueryResultLike<T>> => {
    syncAssetRecords(db);
    const normalized = normalizeSql(sql);

    if (isTxNoop(normalized)) return result([]);
    if (normalized.startsWith('select pg_advisory')) {
      return result([{ pg_advisory_xact_lock: '' }] as T[]);
    }

    const handled = queryLocalAppTables<T>(db, sql, normalized, params);
    if (handled) return handled;

    if (normalized.startsWith('select')) return result([]);
    if (normalized.startsWith('insert') || normalized.startsWith('update') || normalized.startsWith('delete')) {
      return result([]);
    }
    return result([]);
  };

  return {
    query,
    async connect() {
      return { query, release() {} };
    },
  };
}

function ensureLocalAppSchema(db: PrivateSqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_resources (
      resource_id TEXT NOT NULL,
      region TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT 'self',
      resource_type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(account_id, resource_type, resource_id, region)
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_resources_type_account
      ON inventory_resources(resource_type, account_id, region);

    CREATE TABLE IF NOT EXISTS inventory_sync_runs (
      resource_type TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT 'self',
      status TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      finished_at TEXT,
      row_count INTEGER,
      error TEXT,
      PRIMARY KEY(resource_type, account_id)
    );

    CREATE TABLE IF NOT EXISTS inventory_snapshots (
      account_id TEXT NOT NULL DEFAULT 'self',
      resource_type TEXT NOT NULL,
      resource_count INTEGER NOT NULL DEFAULT 0,
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      alias TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      is_host INTEGER NOT NULL DEFAULT 0,
      role_name TEXT NOT NULL DEFAULT 'AWSopsReadOnlyRole',
      external_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      all_regions INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '',
      last_verified_at TEXT
    );

    CREATE TABLE IF NOT EXISTS account_regions (
      account_id TEXT NOT NULL,
      region TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(account_id, region)
    );

    CREATE TABLE IF NOT EXISTS worker_jobs (
      job_id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      dry_run INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      plan_id TEXT,
      runtime TEXT,
      result TEXT,
      artifact_uri TEXT,
      error TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_jobs_idempotency
      ON worker_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS diagnosis_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_job_id TEXT,
      parent_report_id INTEGER,
      tier TEXT NOT NULL DEFAULT 'mid',
      status TEXT NOT NULL DEFAULT 'running',
      requested_by TEXT NOT NULL DEFAULT '',
      sources_used TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '{}',
      artifact_uri TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      model TEXT,
      title TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      deleted_at TEXT,
      progress TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS compliance_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      requested_by TEXT NOT NULL DEFAULT '',
      account TEXT NOT NULL DEFAULT 'self',
      pass_rate REAL,
      alarm INTEGER,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      worker_job_id TEXT
    );

    CREATE TABLE IF NOT EXISTS topology_nodes (
      account_id TEXT NOT NULL DEFAULT 'self',
      id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      meta TEXT NOT NULL DEFAULT '{}',
      run_id TEXT NOT NULL DEFAULT '',
      class TEXT NOT NULL DEFAULT 'flow',
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(account_id, id, class)
    );

    CREATE TABLE IF NOT EXISTS topology_edges (
      account_id TEXT NOT NULL DEFAULT 'self',
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      rel TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      class TEXT NOT NULL DEFAULT 'flow',
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  migrateLocalAppSchema(db);
}

function migrateLocalAppSchema(db: PrivateSqliteDb): void {
  const syncRunColumns = selectAll<{ name: string }>(db, 'PRAGMA table_info(inventory_sync_runs)')
    .map((column) => String(column.name));
  if (!syncRunColumns.includes('started_at')) {
    db.exec('ALTER TABLE inventory_sync_runs ADD COLUMN started_at TEXT');
  }
  ensureColumns(db, 'worker_jobs', {
    runtime: 'TEXT',
    result: 'TEXT',
    artifact_uri: 'TEXT',
    error: 'TEXT',
    attempt: 'INTEGER NOT NULL DEFAULT 0',
    updated_at: 'TEXT',
  });
  ensureColumns(db, 'asset_records', {
    account_name: "TEXT DEFAULT ''",
    arn: "TEXT DEFAULT ''",
    name: "TEXT DEFAULT ''",
    region: "TEXT DEFAULT ''",
    data_json: "TEXT NOT NULL DEFAULT '{}'",
    discovered_at: 'TEXT',
    last_seen_at: 'TEXT',
    is_active: 'INTEGER NOT NULL DEFAULT 1',
  });
}

function syncAssetRecords(db: PrivateSqliteDb): void {
  db.exec(`
    INSERT OR REPLACE INTO inventory_resources
      (account_id, resource_type, resource_id, region, data, captured_at)
    SELECT account_id, resource_type, resource_id, region, data_json, last_seen_at
      FROM asset_records
     WHERE is_active = 1
  `);
}

function queryLocalAppTables<T>(
  db: PrivateSqliteDb,
  sql: string,
  normalized: string,
  params: unknown[],
): QueryResultLike<T> | null {
  if (normalized.includes('from worker_jobs') && normalized.includes('group by status')) {
    return result(selectAll(db, 'SELECT status, count(*) AS n FROM worker_jobs GROUP BY status') as T[]);
  }
  if (normalized.startsWith('insert into worker_jobs')) {
    return insertWorkerJob<T>(db, params);
  }
  if (normalized.includes('from worker_jobs') && normalized.includes('where idempotency_key')) {
    return result(selectAll(db, 'SELECT job_id, status FROM worker_jobs WHERE idempotency_key = ?', [params[0]]) as T[]);
  }
  if (normalized.includes('from worker_jobs') && normalized.includes('where job_id')) {
    return result(selectAll(db, 'SELECT job_id, type, runtime, status, result, artifact_uri, error, dry_run, attempt, created_at, updated_at FROM worker_jobs WHERE job_id = ?', [params[0]]).map(mapJobRow) as T[]);
  }
  if (normalized.startsWith('update worker_jobs')) {
    return updateWorkerJob<T>(db, normalized, params);
  }
  if (normalized.includes('from compliance_runs') && normalized.includes('order by finished_at')) {
    return result(selectAll(db, 'SELECT pass_rate, alarm, finished_at FROM compliance_runs WHERE status = ? ORDER BY finished_at DESC LIMIT 1', ['succeeded']) as T[]);
  }
  if (normalized.includes('from compliance_runs') && normalized.includes('order by started_at')) {
    return result(selectAll(db, 'SELECT * FROM compliance_runs ORDER BY started_at DESC LIMIT 50') as T[]);
  }
  if (normalized.includes('from worker_jobs') && normalized.includes('order by created_at')) {
    return result(selectAll(db, 'SELECT * FROM worker_jobs ORDER BY created_at DESC LIMIT 50') as T[]);
  }

  const accountRows = handleAccounts<T>(db, normalized, params);
  if (accountRows) return accountRows;

  if (normalized.includes('from inventory_sync_runs')) {
    if (params.length === 0) {
      return result(selectAll(db, `SELECT resource_type, status, started_at, finished_at, row_count, error
        FROM inventory_sync_runs ORDER BY resource_type`) as T[]);
    }
    return result(selectAll(db, 'SELECT status, finished_at, row_count, error FROM inventory_sync_runs WHERE resource_type = ? AND account_id = ?', [params[0], 'self']) as T[]);
  }
  if (normalized.includes('from inventory_snapshots')) {
    return result(selectAll(db, `SELECT substr(captured_at, 1, 10) AS d, resource_type, SUM(resource_count) AS n
      FROM inventory_snapshots WHERE account_id = 'self' GROUP BY 1, 2 ORDER BY 1`) as T[]);
  }
  if (normalized.includes('from inventory_resources')) {
    return handleInventoryQuery<T>(db, sql, normalized, params);
  }
  if (normalized.includes('from topology_nodes') || normalized.includes('from topology_edges')) {
    return handleTopologyQuery<T>(db, normalized, params);
  }
  if (normalized.includes('diagnosis_reports')) {
    return handleDiagnosisQuery<T>(db, normalized, params);
  }

  return null;
}

function insertWorkerJob<T>(db: PrivateSqliteDb, params: unknown[]): QueryResultLike<T> {
  const [jobId, type, payloadJson, dryRun, idempotencyKey] = params;
  if (idempotencyKey) {
    const existing = selectAll<{ job_id: string; status: string }>(
      db,
      'SELECT job_id, status FROM worker_jobs WHERE idempotency_key = ?',
      [idempotencyKey],
    );
    if (existing.length > 0) return result([]);
  }
  db.prepare(`INSERT OR IGNORE INTO worker_jobs
    (job_id, type, payload, dry_run, idempotency_key, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP)`)
    .run([jobId, type, String(payloadJson ?? '{}'), dryRun ? 1 : 0, idempotencyKey ?? null]);
  return result([{ job_id: jobId }] as T[]);
}

function updateWorkerJob<T>(db: PrivateSqliteDb, normalized: string, params: unknown[]): QueryResultLike<T> {
  if (normalized.includes("set status = 'succeeded'") || normalized.includes("set status='succeeded'")) {
    db.prepare(`UPDATE worker_jobs
      SET status = 'succeeded', result = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?`).run([String(params[1] ?? '{}'), params[0]]);
    return result([]);
  }
  if (normalized.includes("set status='running'")) {
    db.prepare(`UPDATE worker_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP, attempt = attempt + 1 WHERE job_id = ?`)
      .run([params[0]]);
    return result([]);
  }
  return result([]);
}

function handleDiagnosisQuery<T>(db: PrivateSqliteDb, normalized: string, params: unknown[]): QueryResultLike<T> {
  if (normalized.startsWith('insert into diagnosis_reports')) {
    const tier = String(params[0] ?? 'mid');
    const requestedBy = String(params[1] ?? '');
    const model = String(params[2] ?? 'sonnet');
    const parent = selectAll<{ id: number }>(
      db,
      `SELECT id FROM diagnosis_reports
       WHERE tier = ? AND status = 'succeeded' AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [tier],
    )[0]?.id ?? null;
    const info = db.prepare(`INSERT INTO diagnosis_reports
      (worker_job_id, tier, requested_by, status, parent_report_id, model, sources_used, summary, tags, progress, created_at)
      VALUES (NULL, ?, ?, 'running', ?, ?, '[]', '{}', '[]', '{}', CURRENT_TIMESTAMP)`)
      .run([tier, requestedBy, parent, model]);
    return result([{ id: Number(info.lastInsertRowid) }] as T[]);
  }
  if (normalized.startsWith('update diagnosis_reports set worker_job_id')) {
    db.prepare('UPDATE diagnosis_reports SET worker_job_id = ? WHERE id = ?').run([params[0], params[1]]);
    return result([]);
  }
  if (normalized.startsWith("update diagnosis_reports set status = 'failed'")) {
    db.prepare("UPDATE diagnosis_reports SET status = 'failed', error = ? WHERE id = ? AND status = 'running'")
      .run([params[1], params[0]]);
    return result([]);
  }
  if (normalized.startsWith("update diagnosis_reports set status = 'succeeded'")) {
    db.prepare(`UPDATE diagnosis_reports
      SET status = 'succeeded', sources_used = ?, summary = ?, artifact_uri = NULL, error = NULL, progress = ?
      WHERE id = ? AND deleted_at IS NULL`)
      .run([String(params[1] ?? '[]'), String(params[2] ?? '{}'), String(params[3] ?? '{}'), params[0]]);
    return result([]);
  }
  if (normalized.startsWith('update diagnosis_reports set deleted_at')) {
    db.prepare('UPDATE diagnosis_reports SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL').run([params[0]]);
    return result([]);
  }
  if (normalized.startsWith('update diagnosis_reports set')) {
    return updateDiagnosisMeta<T>(db, normalized, params);
  }
  if (normalized.includes('join worker_jobs') && normalized.includes('idempotency_key')) {
    const rows = selectAll<{ id: number }>(db, `SELECT r.id
      FROM diagnosis_reports r JOIN worker_jobs j ON j.job_id = r.worker_job_id
      WHERE j.idempotency_key = ? AND r.deleted_at IS NULL
      ORDER BY r.id DESC LIMIT 1`, [params[0]]);
    return result(rows as T[]);
  }
  if (normalized.includes('left join worker_jobs')) {
    const limit = Number(params[0] ?? 50);
    const rows = selectAll<DiagnosisReportRow & { payload: string | null }>(db, `SELECT r.*, j.payload
      FROM diagnosis_reports r LEFT JOIN worker_jobs j ON j.job_id = r.worker_job_id
      WHERE r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT ?`, [limit]);
    return result(rows.map(mapDiagnosisReportRow) as T[]);
  }
  if (normalized.startsWith('select') && normalized.includes('from diagnosis_reports') && normalized.includes('where id')) {
    const rows = selectAll<DiagnosisReportRow>(db, 'SELECT * FROM diagnosis_reports WHERE id = ? AND deleted_at IS NULL', [params[0]]);
    return result(rows.map(mapDiagnosisReportRow) as T[]);
  }
  return result([]);
}

function updateDiagnosisMeta<T>(db: PrivateSqliteDb, normalized: string, params: unknown[]): QueryResultLike<T> {
  const id = params[params.length - 1];
  let cursor = 0;
  if (normalized.includes('title =')) {
    db.prepare('UPDATE diagnosis_reports SET title = ? WHERE id = ? AND deleted_at IS NULL').run([params[cursor++], id]);
  }
  if (normalized.includes('tags =')) {
    db.prepare('UPDATE diagnosis_reports SET tags = ? WHERE id = ? AND deleted_at IS NULL')
      .run([JSON.stringify(params[cursor] ?? []), id]);
  }
  return result([]);
}

function handleAccounts<T>(db: PrivateSqliteDb, normalized: string, params: unknown[]): QueryResultLike<T> | null {
  if (normalized.startsWith('insert into accounts')) {
    db.prepare(`INSERT OR IGNORE INTO accounts
      (account_id, alias, region, is_host, all_regions, status, last_verified_at)
      VALUES (?, ?, ?, 1, 1, 'verified', CURRENT_TIMESTAMP)`).run([params[0], params[1], params[2]]);
    return result([]);
  }
  if (normalized.startsWith('insert into account_regions')) {
    db.prepare(`INSERT OR REPLACE INTO account_regions (account_id, region, enabled, updated_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)`).run([params[0], params[1]]);
    return result([]);
  }
  if (normalized.startsWith('update accounts set status')) {
    db.prepare('UPDATE accounts SET status = ?, last_verified_at = CURRENT_TIMESTAMP WHERE account_id = ?')
      .run([normalized.includes("'verified'") ? 'verified' : 'error', params[0]]);
    return result([]);
  }
  if (normalized.startsWith('delete from accounts')) {
    db.prepare('DELETE FROM accounts WHERE account_id = ? AND is_host = 0').run([params[0]]);
    return result([]);
  }
  if (normalized.includes('from accounts')) {
    if (normalized.includes('count(*)')) {
      return result(selectAll(db, 'SELECT count(*) AS n FROM accounts WHERE enabled = 1') as T[]);
    }
    if (normalized.includes('where account_id')) {
      return result(selectAll(db, 'SELECT * FROM accounts WHERE account_id = ?', [params[0]]).map(mapAccount) as T[]);
    }
    if (normalized.includes('where is_host limit')) {
      return result(selectAll(db, 'SELECT * FROM accounts WHERE is_host = 1 LIMIT 1').map(mapAccount) as T[]);
    }
    if (normalized.includes('where enabled and not is_host')) {
      return result(selectAll(db, 'SELECT account_id FROM accounts WHERE enabled = 1 AND is_host = 0') as T[]);
    }
    return result(selectAll(db, 'SELECT * FROM accounts ORDER BY is_host DESC, alias ASC').map(mapAccount) as T[]);
  }
  return null;
}

function handleInventoryQuery<T>(
  db: PrivateSqliteDb,
  sql: string,
  normalized: string,
  params: unknown[],
): QueryResultLike<T> {
  const rows = selectAll<InventoryRow>(db, 'SELECT resource_id, region, account_id, resource_type, data, captured_at FROM inventory_resources')
    .map(mapInventoryRow);

  if (normalized.includes('select distinct account_id')) {
    return result(unique(rows.map((row) => row.account_id)).map((account_id) => ({ account_id })) as T[]);
  }
  if (normalized.includes('select distinct resource_type')) {
    return result(unique(rows.filter((row) => row.account_id === 'self').map((row) => row.resource_type)).map((resource_type) => ({ resource_type })) as T[]);
  }
  if (normalized.includes('select count(*)') && normalized.includes('resource_type in')) {
    const types = ['s3_public_access', 'security_group', 'ebs_volume', 'iam_user'];
    return result([{ n: rows.filter((row) => types.includes(row.resource_type)).length }] as T[]);
  }
  if (normalized.includes('select count(*)') && !normalized.includes('group by')) {
    const type = resourceTypeFromSql(sql);
    return result([{ n: rows.filter((row) => !type || row.resource_type === type).length }] as T[]);
  }
  if (normalized.includes("union all select 'ec2_stopped'")) {
    return result(inventorySplits(rows) as T[]);
  }
  if (normalized.includes('group by resource_type')) {
    return result(countBy(rows, 'resource_type').map(([resource_type, n]) => ({ resource_type, n })) as T[]);
  }
  if (normalized.includes("coalesce(nullif(data->>'instance_type'")) {
    const ec2 = rows.filter((row) => row.resource_type === 'ec2');
    return result(countBy(ec2, (row) => String(row.data.instance_type || 'unknown')).map(([t, n]) => ({ t, n })) as T[]);
  }
  if (normalized.includes("data->>'instance_state'='running'")) {
    return result(rows
      .filter((row) => row.resource_type === 'ec2' && row.account_id === 'self' && row.data.instance_state === 'running')
      .map((row) => ({ id: row.resource_id, name: row.data.name ?? null, itype: row.data.instance_type ?? null, az: row.data.placement_availability_zone ?? null })) as T[]);
  }
  if (normalized.includes("where resource_type='rds'")) {
    return result(rows
      .filter((row) => row.resource_type === 'rds' && row.account_id === 'self')
      .map((row) => ({ id: row.resource_id, engine: row.data.engine ?? null, clazz: row.data.class ?? null })) as T[]);
  }
  if (normalized.includes('select resource_id, region, account_id, data, captured_at')) {
    const type = String(params[0] ?? '');
    const limit = Number(params[params.length - 2] ?? 100);
    const offset = Number(params[params.length - 1] ?? 0);
    return result(rows
      .filter((row) => row.resource_type === type)
      .sort((a, b) => String(b.captured_at ?? '').localeCompare(String(a.captured_at ?? '')))
      .slice(offset, offset + limit)
      .map(({ resource_id, region, account_id, data, captured_at }) => ({ resource_id, region, account_id, data, captured_at })) as T[]);
  }
  if (normalized.includes('select resource_type, resource_id, region, data')) {
    const account = String(params[1] ?? params[0] ?? 'self');
    const types = Array.isArray(params[0]) ? params[0].map(String) : null;
    return result(rows
      .filter((row) => row.account_id === account)
      .filter((row) => !types || types.includes(row.resource_type))
      .map(({ resource_type, resource_id, region, data }) => ({ resource_type, resource_id, region, data })) as T[]);
  }
  if (normalized.includes('select resource_id as id')) {
    const type = resourceTypeFromSql(sql);
    return result(rows.filter((row) => !type || row.resource_type === type).map((row) => ({ id: row.resource_id })) as T[]);
  }
  return result([]);
}

function handleTopologyQuery<T>(db: PrivateSqliteDb, normalized: string, params: unknown[]): QueryResultLike<T> {
  if (normalized.includes('from topology_nodes')) {
    const cls = String(params[0] ?? 'flow');
    return result(selectAll(db, 'SELECT id, kind, label, meta, captured_at FROM topology_nodes WHERE class = ?', [cls]).map((row) => ({
      ...row,
      meta: parseJsonObject(row.meta),
    })) as T[]);
  }
  if (normalized.includes('from topology_edges')) {
    const cls = String(params[0] ?? 'flow');
    return result(selectAll(db, 'SELECT source, target, rel, confidence FROM topology_edges WHERE class = ?', [cls]) as T[]);
  }
  return result([]);
}

function inventorySplits(rows: ReturnType<typeof mapInventoryRow>[]): { k: string; n: number }[] {
  const count = (predicate: (row: ReturnType<typeof mapInventoryRow>) => boolean) => rows.filter(predicate).length;
  return [
    { k: 'ec2_running', n: count((row) => row.resource_type === 'ec2' && row.data.instance_state === 'running') },
    { k: 'ec2_stopped', n: count((row) => row.resource_type === 'ec2' && row.data.instance_state === 'stopped') },
    { k: 'ebs_unencrypted', n: count((row) => row.resource_type === 'ebs_volume' && String(row.data.encrypted) === 'false') },
    { k: 'iam_user_no_mfa', n: count((row) => row.resource_type === 'iam_user' && String(row.data.mfa_enabled) === 'false') },
    { k: 'sg_open_ingress', n: count((row) => row.resource_type === 'security_group' && JSON.stringify(row.data).includes('0.0.0.0/0')) },
    { k: 's3_public', n: count((row) => row.resource_type === 's3_public_access') },
    { k: 'cw_alarm', n: count((row) => row.resource_type === 'cloudwatch_alarm' && String(row.data.state_value).toLowerCase() === 'alarm') },
  ];
}

function selectAll<T extends Record<string, any> = Record<string, any>>(
  db: PrivateSqliteDb,
  sql: string,
  params: unknown[] = [],
): T[] {
  return db.prepare(sql).all(params) as T[];
}

function ensureColumns(db: PrivateSqliteDb, table: string, columns: Record<string, string>): void {
  const existing = new Set(
    selectAll<{ name: string }>(db, `PRAGMA table_info(${table})`).map((column) => String(column.name)),
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

function result<T>(rows: T[]): QueryResultLike<T> {
  return { rows, rowCount: rows.length };
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isTxNoop(normalized: string): boolean {
  return normalized === 'begin' || normalized === 'commit' || normalized === 'rollback';
}

function mapInventoryRow(row: InventoryRow) {
  return {
    ...row,
    data: parseJsonObject(row.data),
  };
}

function mapAccount(row: Record<string, any>) {
  return {
    ...row,
    is_host: Boolean(row.is_host),
    enabled: Boolean(row.enabled),
    all_regions: Boolean(row.all_regions),
  };
}

function mapJobRow(row: Record<string, any>) {
  return {
    ...row,
    dry_run: Boolean(row.dry_run),
    attempt: Number(row.attempt ?? 0),
    payload: parseJsonObject(row.payload),
    result: parseJsonObject(row.result),
  };
}

function mapDiagnosisReportRow(row: DiagnosisReportRow & { payload?: string | null }) {
  const payload = parseJsonObject(row.payload);
  return {
    ...row,
    account: typeof payload.account === 'string' ? payload.account : null,
    sources_used: parseJsonArray(row.sources_used),
    summary: parseJsonObject(row.summary),
    tags: parseJsonArray(row.tags),
    progress: parseJsonObject(row.progress),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function countBy<T>(rows: T[], key: keyof T | ((row: T) => string)): [string, number][] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = typeof key === 'function' ? key(row) : String(row[key]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function resourceTypeFromSql(sql: string): string | null {
  return sql.match(/resource_type\s*=\s*'([^']+)'/i)?.[1] ?? null;
}
