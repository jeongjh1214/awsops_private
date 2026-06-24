import type DatabaseType from 'better-sqlite3';
import { dirname, resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';

export type AssetDb = DatabaseType.Database;

const DEFAULT_DB_PATH = resolve(process.cwd(), 'data/awsops.db');
const requireFromProject = createRequire(resolve(process.cwd(), 'package.json'));
const Database = requireFromProject('better-sqlite3') as typeof DatabaseType;

export function openAssetDb(dbPath: string = process.env.AWSOPS_ASSET_DB_PATH || DEFAULT_DB_PATH): AssetDb {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateAssetDb(db);
  return db;
}

export function migrateAssetDb(db: AssetDb): void {
  db.exec(`
    create table if not exists asset_records (
      id text primary key,
      provider text not null,
      account_id text not null,
      account_name text not null,
      region text not null,
      service text not null,
      resource_type text not null,
      resource_id text not null,
      resource_name text not null,
      arn text not null,
      status text not null,
      native_state text not null,
      tags_json text not null,
      source_table text not null,
      source_updated_at text not null,
      first_discovered_at text not null,
      last_seen_at text not null,
      is_active integer not null default 1,
      last_hash text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists asset_metadata (
      asset_id text primary key references asset_records(id) on delete cascade,
      owner_team text not null default '',
      owner_person text not null default '',
      business_system text not null default '',
      module_name text not null default '',
      phase text not null default 'unknown',
      purpose text not null default '',
      criticality text not null default '',
      security_grade text not null default '',
      cost_center text not null default '',
      contains_personal_info integer,
      remarks text not null default '',
      updated_by text not null default '',
      updated_at text not null default ''
    );

    create table if not exists asset_custom_field_definitions (
      id text primary key,
      key text not null unique,
      label text not null,
      type text not null,
      options_json text not null default '[]',
      required integer not null default 0,
      applies_to_services_json text not null default '[]',
      applies_to_resource_types_json text not null default '[]',
      display_order integer not null default 0,
      active integer not null default 1,
      created_by text not null default '',
      created_at text not null,
      updated_at text not null
    );

    create table if not exists asset_custom_field_values (
      asset_id text not null references asset_records(id) on delete cascade,
      field_id text not null references asset_custom_field_definitions(id) on delete cascade,
      value_json text not null,
      updated_by text not null default '',
      updated_at text not null,
      primary key (asset_id, field_id)
    );

    create table if not exists asset_change_events (
      id text primary key,
      asset_id text not null,
      event_type text not null,
      event_source text not null,
      summary text not null,
      before_json text not null default '{}',
      after_json text not null default '{}',
      created_by text not null default '',
      created_at text not null
    );

    create table if not exists asset_sync_runs (
      id text primary key,
      status text not null,
      started_at text not null,
      finished_at text,
      summary_json text not null default '{}',
      error text not null default ''
    );

    create index if not exists idx_asset_records_lookup on asset_records(account_id, region, service, resource_type);
    create index if not exists idx_asset_records_active on asset_records(is_active, last_seen_at);
    create index if not exists idx_asset_events_asset on asset_change_events(asset_id, created_at);
  `);
}
