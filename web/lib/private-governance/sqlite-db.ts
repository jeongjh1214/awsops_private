import { existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { getPrivateRuntimeConfig, resolvePrivateRuntimeConfigPath } from '../private-runtime-config';

export interface PrivateSqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface PrivateSqliteStatement {
  all(params?: Record<string, unknown> | unknown[]): Record<string, unknown>[];
  get(params?: Record<string, unknown> | unknown[]): Record<string, unknown> | undefined;
  run(params?: Record<string, unknown> | unknown[]): PrivateSqliteRunResult;
}

export interface PrivateSqliteDb {
  close(): void;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  prepare(sql: string): PrivateSqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

type BetterSqlite3Factory = new (
  filename: string,
  options?: { fileMustExist?: boolean; readonly?: boolean },
) => PrivateSqliteDb;

export function openPrivateSqliteDb(): PrivateSqliteDb {
  const sqlitePath = resolvePrivateSqlitePath();
  mkdirSync(dirname(sqlitePath), { recursive: true });

  const Database = loadBetterSqlite3();
  const db = new Database(sqlitePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensurePrivateSqliteSchema(db);
  return db;
}

export function resolvePrivateSqlitePath(): string {
  const configured = process.env.AWSOPS_PRIVATE_SQLITE_PATH
    ?? process.env.AWSOPS_ASSET_DB_PATH
    ?? getPrivateRuntimeConfig().assetInventory?.sqlitePath;

  if (configured?.trim()) return resolveConfigRelativePath(configured.trim());

  const configPath = resolvePrivateRuntimeConfigPath();
  if (configPath) return resolve(dirname(configPath), 'awsops.db');
  return resolve(process.cwd(), 'data/awsops.db');
}

function resolveConfigRelativePath(path: string): string {
  if (isAbsolute(path)) return path;
  if (path === 'data' || path.startsWith('data/')) return resolve(process.cwd(), path);
  const configPath = resolvePrivateRuntimeConfigPath();
  const baseDir = configPath ? dirname(configPath) : process.cwd();
  return resolve(baseDir, path);
}

function loadBetterSqlite3(): BetterSqlite3Factory {
  const nodeRequire = eval('require') as NodeRequire;
  const { createRequire } = nodeRequire('module') as typeof import('module');
  const candidatePackageJson = [
    resolve(process.cwd(), 'package.json'),
    resolve(process.cwd(), 'web/package.json'),
  ].find((path) => existsSync(path)) ?? resolve(process.cwd(), 'package.json');
  const requireFromProject = createRequire(candidatePackageJson);
  return requireFromProject('better-sqlite3') as BetterSqlite3Factory;
}

function ensurePrivateSqliteSchema(db: PrivateSqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      account_name TEXT DEFAULT '',
      service TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      arn TEXT DEFAULT '',
      name TEXT DEFAULT '',
      region TEXT DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      discovered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(account_id, service, resource_type, resource_id)
    );

    CREATE TABLE IF NOT EXISTS s3_governance_records (
      stable_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      bucket_name TEXT NOT NULL,
      account_name TEXT NOT NULL DEFAULT '',
      phase TEXT NOT NULL DEFAULT '',
      owner_team TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT '',
      history TEXT NOT NULL DEFAULT '',
      contains_personal_info INTEGER,
      pii_retention_aware INTEGER,
      pii_retention_applied INTEGER,
      pii_retention_period TEXT NOT NULL DEFAULT '',
      remarks TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(account_id, bucket_name)
    );

    CREATE TABLE IF NOT EXISTS s3_governance_events (
      id TEXT PRIMARY KEY,
      stable_key TEXT NOT NULL,
      account_id TEXT NOT NULL,
      bucket_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_source TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      before_json TEXT NOT NULL DEFAULT '{}',
      after_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY(stable_key) REFERENCES s3_governance_records(stable_key) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_asset_records_s3
      ON asset_records(account_id, service, resource_type, resource_id, is_active, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_s3_governance_account_bucket
      ON s3_governance_records(account_id, bucket_name);
    CREATE INDEX IF NOT EXISTS idx_s3_governance_events_stable_key
      ON s3_governance_events(stable_key, created_at DESC);
  `);
}
