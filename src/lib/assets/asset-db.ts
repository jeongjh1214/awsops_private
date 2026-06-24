import type DatabaseType from 'better-sqlite3';
import { dirname, resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';

export type AssetDb = DatabaseType.Database;

const DEFAULT_DB_PATH = resolve(process.cwd(), 'data/awsops.db');
const nodeRequire = eval('require') as NodeRequire;
const requireFromProject = nodeRequire('module').createRequire(resolve(process.cwd(), 'package.json')) as NodeRequire;
const Database = requireFromProject('better-sqlite3') as typeof DatabaseType;

type ForeignKeyInfo = {
  table: string;
  from: string;
  to: string;
  on_delete: string;
};

export function resolveAssetDbPath(dbPath: string = process.env.AWSOPS_ASSET_DB_PATH || DEFAULT_DB_PATH): string {
  return resolve(process.cwd(), dbPath);
}

export function openAssetDb(dbPath: string = process.env.AWSOPS_ASSET_DB_PATH || DEFAULT_DB_PATH): AssetDb {
  const resolvedPath = resolveAssetDbPath(dbPath);
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateAssetDb(db);
  return db;
}

export function openAssetDbReadOnly(dbPath: string = process.env.AWSOPS_ASSET_DB_PATH || DEFAULT_DB_PATH): AssetDb {
  const resolvedPath = resolveAssetDbPath(dbPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`asset inventory database does not exist: ${resolvedPath}`);
  }

  const db = new Database(resolvedPath, { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = ON');
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
      asset_id text not null references asset_records(id) on delete cascade,
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

    create table if not exists s3_governance_records (
      stable_key text primary key,
      account_id text not null,
      account_name text not null default '',
      phase text not null default '',
      bucket_name text not null,
      owner_team text not null default '',
      purpose text not null default '',
      history text not null default '',
      contains_personal_info integer,
      pii_retention_aware integer,
      pii_retention_applied integer,
      pii_retention_period text not null default '',
      remarks text not null default '',
      updated_by text not null default '',
      updated_at text not null,
      created_at text not null,
      unique(account_id, bucket_name)
    );

    create table if not exists s3_governance_events (
      id text primary key,
      stable_key text not null,
      account_id text not null,
      bucket_name text not null,
      event_type text not null,
      event_source text not null,
      summary text not null,
      before_json text not null default '{}',
      after_json text not null default '{}',
      created_by text not null default '',
      created_at text not null,
      foreign key(stable_key) references s3_governance_records(stable_key) on delete cascade
    );
  `);

  ensureAssetChangeEventsForeignKey(db);

  db.exec(`
    create index if not exists idx_asset_records_lookup on asset_records(account_id, region, service, resource_type);
    create index if not exists idx_asset_records_active on asset_records(is_active, last_seen_at);
    create index if not exists idx_asset_events_asset on asset_change_events(asset_id, created_at);
    create index if not exists idx_s3_governance_records_account on s3_governance_records(account_id, bucket_name);
    create index if not exists idx_s3_governance_records_phase_owner on s3_governance_records(phase, owner_team);
    create index if not exists idx_s3_governance_events_record on s3_governance_events(stable_key, created_at);
  `);
}

function ensureAssetChangeEventsForeignKey(db: AssetDb): void {
  const foreignKeys = db.prepare('pragma foreign_key_list(asset_change_events)').all() as ForeignKeyInfo[];
  const hasAssetRecordForeignKey = foreignKeys.some((foreignKey) => (
    foreignKey.table === 'asset_records'
    && foreignKey.from === 'asset_id'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toLowerCase() === 'cascade'
  ));

  if (hasAssetRecordForeignKey) return;

  const legacyTable = `asset_change_events_without_asset_fk_${Date.now()}`;
  db.transaction(() => {
    db.exec(`
      alter table asset_change_events rename to ${legacyTable};

      create table asset_change_events (
        id text primary key,
        asset_id text not null references asset_records(id) on delete cascade,
        event_type text not null,
        event_source text not null,
        summary text not null,
        before_json text not null default '{}',
        after_json text not null default '{}',
        created_by text not null default '',
        created_at text not null
      );

      insert into asset_change_events (
        id, asset_id, event_type, event_source, summary, before_json,
        after_json, created_by, created_at
      )
      select
        id, asset_id, event_type, event_source, summary, before_json,
        after_json, created_by, created_at
      from ${legacyTable}
      where exists (
        select 1 from asset_records where asset_records.id = ${legacyTable}.asset_id
      );

      drop table ${legacyTable};
    `);
  })();
}
