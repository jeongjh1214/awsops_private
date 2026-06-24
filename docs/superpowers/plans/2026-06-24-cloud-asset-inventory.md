# Cloud Asset Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private-VM-friendly Cloud Asset Inventory module that discovers AWS resources through Steampipe, stores human-managed asset metadata and custom fields in a local SQLite DB, and lets AI answer read-only questions from that asset data.

**Architecture:** Keep AWS discovery read-only through existing Steampipe `runQuery()` calls. Store managed metadata, custom field definitions, values, sync runs, and change events in `data/awsops.db` through a small server-only asset DB layer. Build the UI as a dense operational table plus detail drawer, and keep AI read-only by exposing an internal asset query helper to `/api/ai`.

**Tech Stack:** Next.js App Router, TypeScript, `better-sqlite3`, existing Steampipe pg Pool, existing Tailwind/nav patterns, Node `crypto`, CSV import/export using standard web APIs.

---

## File Structure

- Create `src/lib/assets/asset-types.ts`: shared asset, metadata, custom field, sync, and CSV types.
- Create `src/lib/assets/asset-id.ts`: deterministic asset ID and hashing helpers.
- Create `src/lib/assets/asset-db.ts`: SQLite connection, migrations, CRUD helpers.
- Create `src/lib/assets/asset-normalizers.ts`: Steampipe row to normalized asset conversion.
- Create `src/lib/assets/asset-sync.ts`: read-only sync orchestration through `runQuery()`.
- Create `src/lib/assets/asset-admin.ts`: admin token hash and header validation.
- Create `src/lib/assets/asset-csv.ts`: CSV export/import preview/apply helpers.
- Create `src/lib/assets/asset-ai.ts`: read-only query helper used by AI route.
- Create `src/app/api/assets/route.ts`: list, sync, export/import entrypoint.
- Create `src/app/api/assets/[id]/route.ts`: asset detail and metadata update.
- Create `src/app/api/assets/custom-fields/route.ts`: custom field list/create.
- Create `src/app/api/assets/custom-fields/[id]/route.ts`: custom field update/deactivate.
- Create `src/app/assets/page.tsx`: Cloud Assets UI.
- Modify `src/components/layout/Sidebar.tsx`: add Cloud Assets nav item.
- Modify `src/lib/app-config.ts`: add `assetInventory` config shape.
- Modify `src/app/api/ai/route.ts`: add read-only asset inventory route.
- Modify `docs/examples/config.vm-private.example.json`: document asset inventory config.
- Modify `docs/TROUBLESHOOTING.md`: add asset DB/sync troubleshooting.
- Add tests under `tests/assets/`.

## Task 1: SQLite Storage Foundation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/lib/assets/asset-types.ts`
- Create: `src/lib/assets/asset-id.ts`
- Create: `src/lib/assets/asset-db.ts`
- Test: `tests/assets/test_asset_db.mjs`

- [ ] **Step 1: Install SQLite dependency**

Run:

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

Expected: `package.json` and `package-lock.json` include `better-sqlite3` and `@types/better-sqlite3`.

- [ ] **Step 2: Write failing storage test**

Create `tests/assets/test_asset_db.mjs`:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-assets-db-'));
const dbPath = join(outDir, 'assets.db');
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
    'src/lib/assets/asset-types.ts',
    'src/lib/assets/asset-id.ts',
    'src/lib/assets/asset-db.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const { openAssetDb } = require(join(outDir, 'asset-db.js'));
  const { makeAssetId, stableJsonHash } = require(join(outDir, 'asset-id.js'));

  const db = openAssetDb(dbPath);
  assert.equal(db.prepare("select name from sqlite_master where type='table' and name='asset_records'").get().name, 'asset_records');

  const assetId = makeAssetId({
    provider: 'aws',
    accountId: '123456789012',
    region: 'ap-northeast-2',
    service: 'ec2',
    resourceType: 'ec2_instance',
    resourceId: 'i-123',
  });

  db.prepare(`
    insert into asset_records (
      id, provider, account_id, account_name, region, service, resource_type,
      resource_id, resource_name, arn, status, native_state, tags_json,
      source_table, source_updated_at, first_discovered_at, last_seen_at,
      is_active, last_hash, created_at, updated_at
    ) values (
      @id, 'aws', '123456789012', 'Prod', 'ap-northeast-2', 'ec2', 'ec2_instance',
      'i-123', 'app-01', '', 'running', 'running', '{}',
      'aws_ec2_instance', @now, @now, @now, 1, @hash, @now, @now
    )
  `).run({ id: assetId, now: '2026-06-24T00:00:00.000Z', hash: stableJsonHash({ state: 'running' }) });

  const row = db.prepare('select id, resource_name, is_active from asset_records where id = ?').get(assetId);
  assert.equal(row.resource_name, 'app-01');
  assert.equal(row.is_active, 1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
```

- [ ] **Step 3: Run failing storage test**

Run:

```bash
node tests/assets/test_asset_db.mjs
```

Expected: FAIL because `src/lib/assets/asset-db.ts` does not exist.

- [ ] **Step 4: Add asset types**

Create `src/lib/assets/asset-types.ts`:

```ts
export type AssetFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'multi_select'
  | 'boolean'
  | 'date'
  | 'number'
  | 'url'
  | 'owner';

export interface AssetIdentityInput {
  provider: 'aws';
  accountId: string;
  region: string;
  service: string;
  resourceType: string;
  resourceId: string;
}

export interface AssetRecord extends AssetIdentityInput {
  id: string;
  accountName: string;
  resourceName: string;
  arn: string;
  status: string;
  nativeState: string;
  tags: Record<string, unknown>;
  sourceTable: string;
  sourceUpdatedAt: string;
  firstDiscoveredAt: string;
  lastSeenAt: string;
  isActive: boolean;
  lastHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetMetadata {
  assetId: string;
  ownerTeam: string;
  ownerPerson: string;
  businessSystem: string;
  moduleName: string;
  phase: string;
  purpose: string;
  criticality: string;
  securityGrade: string;
  costCenter: string;
  containsPersonalInfo: boolean | null;
  remarks: string;
  updatedBy: string;
  updatedAt: string;
}

export interface AssetCustomFieldDefinition {
  id: string;
  key: string;
  label: string;
  type: AssetFieldType;
  options: string[];
  required: boolean;
  appliesToServices: string[];
  appliesToResourceTypes: string[];
  displayOrder: number;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetChangeEvent {
  id: string;
  assetId: string;
  eventType:
    | 'discovered'
    | 'rediscovered'
    | 'changed'
    | 'missing'
    | 'restored'
    | 'metadata_updated'
    | 'custom_field_updated'
    | 'custom_field_definition_changed';
  eventSource: 'sync' | 'user' | 'import' | 'admin';
  summary: string;
  beforeJson: string;
  afterJson: string;
  createdBy: string;
  createdAt: string;
}
```

- [ ] **Step 5: Add asset ID helper**

Create `src/lib/assets/asset-id.ts`:

```ts
import { createHash } from 'crypto';
import type { AssetIdentityInput } from './asset-types';

export function makeAssetId(input: AssetIdentityInput): string {
  return [
    input.provider,
    input.accountId,
    input.region || 'global',
    input.service,
    input.resourceType,
    input.resourceId,
  ].join(':');
}

export function stableJsonHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}
```

- [ ] **Step 6: Add SQLite migration helper**

Create `src/lib/assets/asset-db.ts`:

```ts
import Database from 'better-sqlite3';
import { dirname, resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';

export type AssetDb = Database.Database;

const DEFAULT_DB_PATH = resolve(process.cwd(), 'data/awsops.db');

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
```

- [ ] **Step 7: Run storage test**

Run:

```bash
node tests/assets/test_asset_db.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit storage foundation**

```bash
git add package.json package-lock.json src/lib/assets/asset-types.ts src/lib/assets/asset-id.ts src/lib/assets/asset-db.ts tests/assets/test_asset_db.mjs
git commit -m "feat: add asset inventory storage"
```

## Task 2: Asset Normalization And Sync

**Files:**
- Create: `src/lib/assets/asset-normalizers.ts`
- Create: `src/lib/assets/asset-sync.ts`
- Test: `tests/assets/test_asset_sync.mjs`

- [ ] **Step 1: Write failing sync test**

Create `tests/assets/test_asset_sync.mjs`:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-assets-sync-'));

try {
  execFileSync(resolve('node_modules/.bin/tsc'), [
    'src/lib/assets/asset-types.ts',
    'src/lib/assets/asset-id.ts',
    'src/lib/assets/asset-normalizers.ts',
    'src/lib/assets/asset-db.ts',
    'src/lib/assets/asset-sync.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const { normalizeEc2Instance } = require(join(outDir, 'asset-normalizers.js'));
  const { openAssetDb } = require(join(outDir, 'asset-db.js'));
  const { upsertDiscoveredAssets, markMissingAssets } = require(join(outDir, 'asset-sync.js'));

  const now = '2026-06-24T00:00:00.000Z';
  const asset = normalizeEc2Instance({
    account_id: '123456789012',
    account_name: 'Prod',
    region: 'ap-northeast-2',
    instance_id: 'i-123',
    tags: { Name: 'app-01' },
    arn: 'arn:aws:ec2:ap-northeast-2:123456789012:instance/i-123',
    instance_state: 'running',
    launch_time: now,
  }, now);

  assert.equal(asset.id, 'aws:123456789012:ap-northeast-2:ec2:ec2_instance:i-123');
  assert.equal(asset.resourceName, 'app-01');
  assert.equal(asset.status, 'running');

  const db = openAssetDb(join(outDir, 'assets.db'));
  const result = upsertDiscoveredAssets(db, [asset], now);
  assert.equal(result.discovered, 1);
  assert.equal(result.changed, 0);

  const missing = markMissingAssets(db, new Set(), now);
  assert.equal(missing, 1);
  assert.equal(db.prepare('select is_active from asset_records where id = ?').get(asset.id).is_active, 0);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run failing sync test**

Run:

```bash
node tests/assets/test_asset_sync.mjs
```

Expected: FAIL because `asset-normalizers.ts` and `asset-sync.ts` do not exist.

- [ ] **Step 3: Add normalizers**

Create `src/lib/assets/asset-normalizers.ts`:

```ts
import type { AssetRecord } from './asset-types';
import { makeAssetId, stableJsonHash } from './asset-id';

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function tagsName(tags: unknown): string {
  if (!tags || typeof tags !== 'object') return '';
  return str((tags as Record<string, unknown>).Name);
}

function baseAsset(input: {
  accountId: string;
  accountName: string;
  region: string;
  service: string;
  resourceType: string;
  resourceId: string;
  resourceName: string;
  arn: string;
  status: string;
  nativeState: string;
  tags: Record<string, unknown>;
  sourceTable: string;
  sourceUpdatedAt: string;
  now: string;
}): AssetRecord {
  const id = makeAssetId({
    provider: 'aws',
    accountId: input.accountId,
    region: input.region || 'global',
    service: input.service,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  });
  const hashInput = {
    resourceName: input.resourceName,
    status: input.status,
    nativeState: input.nativeState,
    tags: input.tags,
    arn: input.arn,
  };
  return {
    id,
    provider: 'aws',
    accountId: input.accountId,
    accountName: input.accountName,
    region: input.region || 'global',
    service: input.service,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceName: input.resourceName || input.resourceId,
    arn: input.arn,
    status: input.status,
    nativeState: input.nativeState,
    tags: input.tags,
    sourceTable: input.sourceTable,
    sourceUpdatedAt: input.sourceUpdatedAt,
    firstDiscoveredAt: input.now,
    lastSeenAt: input.now,
    isActive: true,
    lastHash: stableJsonHash(hashInput),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function normalizeEc2Instance(row: Row, now: string): AssetRecord {
  const tags = (row.tags && typeof row.tags === 'object' ? row.tags : {}) as Record<string, unknown>;
  return baseAsset({
    accountId: str(row.account_id),
    accountName: str(row.account_name),
    region: str(row.region),
    service: 'ec2',
    resourceType: 'ec2_instance',
    resourceId: str(row.instance_id),
    resourceName: tagsName(tags) || str(row.instance_id),
    arn: str(row.arn),
    status: str(row.instance_state),
    nativeState: str(row.instance_state),
    tags,
    sourceTable: 'aws_ec2_instance',
    sourceUpdatedAt: str(row.launch_time) || now,
    now,
  });
}

export function normalizeS3Bucket(row: Row, now: string): AssetRecord {
  return baseAsset({
    accountId: str(row.account_id),
    accountName: str(row.account_name),
    region: str(row.region) || 'global',
    service: 's3',
    resourceType: 's3_bucket',
    resourceId: str(row.name),
    resourceName: str(row.name),
    arn: str(row.arn),
    status: 'available',
    nativeState: 'available',
    tags: (row.tags && typeof row.tags === 'object' ? row.tags : {}) as Record<string, unknown>,
    sourceTable: 'aws_s3_bucket',
    sourceUpdatedAt: str(row.creation_date) || now,
    now,
  });
}
```

- [ ] **Step 4: Add sync upsert helpers**

Create `src/lib/assets/asset-sync.ts`:

```ts
import { randomUUID } from 'crypto';
import type { AssetRecord } from './asset-types';
import type { AssetDb } from './asset-db';

export interface AssetSyncSummary {
  discovered: number;
  changed: number;
  rediscovered: number;
}

export function upsertDiscoveredAssets(db: AssetDb, assets: AssetRecord[], now: string): AssetSyncSummary {
  const summary: AssetSyncSummary = { discovered: 0, changed: 0, rediscovered: 0 };
  const tx = db.transaction((items: AssetRecord[]) => {
    for (const asset of items) {
      const existing = db.prepare('select id, last_hash, is_active from asset_records where id = ?').get(asset.id) as
        | { id: string; last_hash: string; is_active: number }
        | undefined;

      if (!existing) {
        insertAsset(db, asset);
        insertEvent(db, asset.id, 'discovered', 'sync', `Discovered ${asset.service} ${asset.resourceName}`, '{}', JSON.stringify(asset), now);
        summary.discovered += 1;
        continue;
      }

      const changed = existing.last_hash !== asset.lastHash;
      const restored = existing.is_active === 0;
      db.prepare(`
        update asset_records
        set account_name = @accountName,
            resource_name = @resourceName,
            arn = @arn,
            status = @status,
            native_state = @nativeState,
            tags_json = @tagsJson,
            source_updated_at = @sourceUpdatedAt,
            last_seen_at = @lastSeenAt,
            is_active = 1,
            last_hash = @lastHash,
            updated_at = @updatedAt
        where id = @id
      `).run(toDbAsset(asset, now));

      if (changed) {
        insertEvent(db, asset.id, 'changed', 'sync', `Changed ${asset.service} ${asset.resourceName}`, '{}', JSON.stringify(asset), now);
        summary.changed += 1;
      } else if (restored) {
        insertEvent(db, asset.id, 'restored', 'sync', `Restored ${asset.service} ${asset.resourceName}`, '{}', JSON.stringify(asset), now);
        summary.rediscovered += 1;
      }
    }
  });
  tx(assets);
  return summary;
}

export function markMissingAssets(db: AssetDb, seenIds: Set<string>, now: string): number {
  const active = db.prepare('select id, service, resource_name from asset_records where is_active = 1').all() as Array<{
    id: string;
    service: string;
    resource_name: string;
  }>;
  let missing = 0;
  const tx = db.transaction(() => {
    for (const row of active) {
      if (seenIds.has(row.id)) continue;
      db.prepare('update asset_records set is_active = 0, updated_at = ? where id = ?').run(now, row.id);
      insertEvent(db, row.id, 'missing', 'sync', `Missing ${row.service} ${row.resource_name}`, '{}', '{}', now);
      missing += 1;
    }
  });
  tx();
  return missing;
}

function insertAsset(db: AssetDb, asset: AssetRecord): void {
  db.prepare(`
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
  `).run(toDbAsset(asset));
}

function toDbAsset(asset: AssetRecord, now: string = asset.updatedAt) {
  return {
    ...asset,
    tagsJson: JSON.stringify(asset.tags),
    isActive: asset.isActive ? 1 : 0,
    lastSeenAt: now,
    updatedAt: now,
  };
}

function insertEvent(
  db: AssetDb,
  assetId: string,
  eventType: string,
  eventSource: string,
  summary: string,
  beforeJson: string,
  afterJson: string,
  now: string,
): void {
  db.prepare(`
    insert into asset_change_events (
      id, asset_id, event_type, event_source, summary, before_json, after_json, created_by, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, 'system', ?)
  `).run(randomUUID(), assetId, eventType, eventSource, summary, beforeJson, afterJson, now);
}
```

- [ ] **Step 5: Run sync test**

Run:

```bash
node tests/assets/test_asset_sync.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit normalization and sync helpers**

```bash
git add src/lib/assets/asset-normalizers.ts src/lib/assets/asset-sync.ts tests/assets/test_asset_sync.mjs
git commit -m "feat: add asset discovery sync helpers"
```

## Task 3: Asset API Read/Write

**Files:**
- Create: `src/lib/assets/asset-repository.ts`
- Create: `src/app/api/assets/route.ts`
- Create: `src/app/api/assets/[id]/route.ts`
- Test: `tests/assets/test_asset_repository.mjs`

- [ ] **Step 1: Write repository test**

Create `tests/assets/test_asset_repository.mjs`:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-assets-repo-'));

try {
  execFileSync(resolve('node_modules/.bin/tsc'), [
    'src/lib/assets/asset-types.ts',
    'src/lib/assets/asset-id.ts',
    'src/lib/assets/asset-db.ts',
    'src/lib/assets/asset-repository.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const { openAssetDb } = require(join(outDir, 'asset-db.js'));
  const { listAssets, updateAssetMetadata } = require(join(outDir, 'asset-repository.js'));
  const db = openAssetDb(join(outDir, 'assets.db'));
  const now = '2026-06-24T00:00:00.000Z';

  db.prepare(`
    insert into asset_records (
      id, provider, account_id, account_name, region, service, resource_type,
      resource_id, resource_name, arn, status, native_state, tags_json,
      source_table, source_updated_at, first_discovered_at, last_seen_at,
      is_active, last_hash, created_at, updated_at
    ) values (
      'aws:123:ap-northeast-2:ec2:ec2_instance:i-1', 'aws', '123', 'Prod', 'ap-northeast-2', 'ec2', 'ec2_instance',
      'i-1', 'app-01', '', 'running', 'running', '{}',
      'aws_ec2_instance', @now, @now, @now, 1, 'hash', @now, @now
    )
  `).run({ now });

  updateAssetMetadata(db, 'aws:123:ap-northeast-2:ec2:ec2_instance:i-1', {
    ownerTeam: '플랫폼팀',
    moduleName: '인증',
    phase: 'prod',
    remarks: '핵심 업무',
    updatedBy: 'tester',
  }, now);

  const result = listAssets(db, { service: 'ec2', metadataMissing: false });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].owner_team, '플랫폼팀');
  assert.equal(result.rows[0].module_name, '인증');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run failing repository test**

Run:

```bash
node tests/assets/test_asset_repository.mjs
```

Expected: FAIL because `asset-repository.ts` does not exist.

- [ ] **Step 3: Add repository helpers**

Create `src/lib/assets/asset-repository.ts`:

```ts
import { randomUUID } from 'crypto';
import type { AssetDb } from './asset-db';

export interface AssetListFilters {
  accountId?: string;
  region?: string;
  service?: string;
  resourceType?: string;
  phase?: string;
  ownerTeam?: string;
  active?: boolean;
  metadataMissing?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export function listAssets(db: AssetDb, filters: AssetListFilters = {}) {
  const where: string[] = [];
  const params: Record<string, unknown> = {
    limit: Math.min(Math.max(filters.limit || 100, 1), 500),
    offset: Math.max(filters.offset || 0, 0),
  };

  if (filters.accountId) { where.push('r.account_id = @accountId'); params.accountId = filters.accountId; }
  if (filters.region) { where.push('r.region = @region'); params.region = filters.region; }
  if (filters.service) { where.push('r.service = @service'); params.service = filters.service; }
  if (filters.resourceType) { where.push('r.resource_type = @resourceType'); params.resourceType = filters.resourceType; }
  if (filters.phase) { where.push('coalesce(m.phase, "unknown") = @phase'); params.phase = filters.phase; }
  if (filters.ownerTeam) { where.push('coalesce(m.owner_team, "") = @ownerTeam'); params.ownerTeam = filters.ownerTeam; }
  if (typeof filters.active === 'boolean') { where.push('r.is_active = @active'); params.active = filters.active ? 1 : 0; }
  if (filters.metadataMissing) {
    where.push('(m.asset_id is null or m.owner_team = "" or m.module_name = "" or m.phase = "unknown")');
  }
  if (filters.q) {
    where.push('(r.resource_name like @q or r.resource_id like @q or r.arn like @q)');
    params.q = `%${filters.q}%`;
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const rows = db.prepare(`
    select
      r.*,
      coalesce(m.owner_team, '') as owner_team,
      coalesce(m.owner_person, '') as owner_person,
      coalesce(m.business_system, '') as business_system,
      coalesce(m.module_name, '') as module_name,
      coalesce(m.phase, 'unknown') as phase,
      coalesce(m.purpose, '') as purpose,
      coalesce(m.criticality, '') as criticality,
      coalesce(m.security_grade, '') as security_grade,
      coalesce(m.cost_center, '') as cost_center,
      m.contains_personal_info as contains_personal_info,
      coalesce(m.remarks, '') as remarks
    from asset_records r
    left join asset_metadata m on m.asset_id = r.id
    ${whereSql}
    order by r.is_active desc, r.last_seen_at desc
    limit @limit offset @offset
  `).all(params);
  const total = (db.prepare(`
    select count(*) as count
    from asset_records r
    left join asset_metadata m on m.asset_id = r.id
    ${whereSql}
  `).get(params) as { count: number }).count;
  return { rows, total, limit: params.limit, offset: params.offset };
}

export function updateAssetMetadata(
  db: AssetDb,
  assetId: string,
  input: Record<string, unknown>,
  now: string = new Date().toISOString(),
): void {
  const existing = db.prepare('select * from asset_metadata where asset_id = ?').get(assetId) || {};
  const next = {
    assetId,
    ownerTeam: String(input.ownerTeam ?? ''),
    ownerPerson: String(input.ownerPerson ?? ''),
    businessSystem: String(input.businessSystem ?? ''),
    moduleName: String(input.moduleName ?? ''),
    phase: String(input.phase ?? 'unknown'),
    purpose: String(input.purpose ?? ''),
    criticality: String(input.criticality ?? ''),
    securityGrade: String(input.securityGrade ?? ''),
    costCenter: String(input.costCenter ?? ''),
    containsPersonalInfo: input.containsPersonalInfo === null || input.containsPersonalInfo === undefined
      ? null
      : input.containsPersonalInfo ? 1 : 0,
    remarks: String(input.remarks ?? ''),
    updatedBy: String(input.updatedBy ?? 'internal'),
    updatedAt: now,
  };
  db.prepare(`
    insert into asset_metadata (
      asset_id, owner_team, owner_person, business_system, module_name, phase,
      purpose, criticality, security_grade, cost_center, contains_personal_info,
      remarks, updated_by, updated_at
    ) values (
      @assetId, @ownerTeam, @ownerPerson, @businessSystem, @moduleName, @phase,
      @purpose, @criticality, @securityGrade, @costCenter, @containsPersonalInfo,
      @remarks, @updatedBy, @updatedAt
    )
    on conflict(asset_id) do update set
      owner_team = excluded.owner_team,
      owner_person = excluded.owner_person,
      business_system = excluded.business_system,
      module_name = excluded.module_name,
      phase = excluded.phase,
      purpose = excluded.purpose,
      criticality = excluded.criticality,
      security_grade = excluded.security_grade,
      cost_center = excluded.cost_center,
      contains_personal_info = excluded.contains_personal_info,
      remarks = excluded.remarks,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(next);
  db.prepare(`
    insert into asset_change_events (
      id, asset_id, event_type, event_source, summary, before_json, after_json, created_by, created_at
    ) values (?, ?, 'metadata_updated', 'user', 'Updated asset metadata', ?, ?, ?, ?)
  `).run(randomUUID(), assetId, JSON.stringify(existing), JSON.stringify(next), next.updatedBy, now);
}
```

- [ ] **Step 4: Add API route skeletons**

Create `src/app/api/assets/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { openAssetDb } from '@/lib/assets/asset-db';
import { listAssets } from '@/lib/assets/asset-repository';

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const db = openAssetDb();
  const result = listAssets(db, {
    accountId: sp.get('accountId') || undefined,
    region: sp.get('region') || undefined,
    service: sp.get('service') || undefined,
    resourceType: sp.get('resourceType') || undefined,
    phase: sp.get('phase') || undefined,
    ownerTeam: sp.get('ownerTeam') || undefined,
    active: sp.get('active') === null ? undefined : sp.get('active') === 'true',
    metadataMissing: sp.get('metadataMissing') === 'true',
    q: sp.get('q') || undefined,
    limit: Number(sp.get('limit') || 100),
    offset: Number(sp.get('offset') || 0),
  });
  return NextResponse.json(result);
}
```

Create `src/app/api/assets/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { openAssetDb } from '@/lib/assets/asset-db';
import { updateAssetMetadata } from '@/lib/assets/asset-repository';

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json();
  const db = openAssetDb();
  updateAssetMetadata(db, decodeURIComponent(params.id), body, new Date().toISOString());
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Run repository test and typecheck**

Run:

```bash
node tests/assets/test_asset_repository.mjs
./node_modules/.bin/tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 6: Commit asset API foundation**

```bash
git add src/lib/assets/asset-repository.ts src/app/api/assets/route.ts src/app/api/assets/[id]/route.ts tests/assets/test_asset_repository.mjs
git commit -m "feat: add asset inventory api"
```

## Task 4: Steampipe Sync Endpoint

**Files:**
- Modify: `src/lib/assets/asset-sync.ts`
- Modify: `src/app/api/assets/route.ts`
- Test: `tests/assets/test_asset_sync_queries.mjs`

- [ ] **Step 1: Write sync query test**

Create `tests/assets/test_asset_sync_queries.mjs`:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-assets-sync-queries-'));

try {
  execFileSync(resolve('node_modules/.bin/tsc'), [
    'src/lib/assets/asset-sync.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const { ASSET_SYNC_QUERIES } = require(join(outDir, 'asset-sync.js'));
  assert.match(ASSET_SYNC_QUERIES.ec2_instance.sql, /from aws_ec2_instance/i);
  assert.match(ASSET_SYNC_QUERIES.s3_bucket.sql, /from aws_s3_bucket/i);
  assert.equal(ASSET_SYNC_QUERIES.cloudfront_distribution, undefined);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Add sync query map and orchestrator**

Append to `src/lib/assets/asset-sync.ts`:

```ts
import { runQuery } from '@/lib/steampipe';
import { normalizeEc2Instance, normalizeS3Bucket } from './asset-normalizers';
import { openAssetDb } from './asset-db';

export const ASSET_SYNC_QUERIES = {
  ec2_instance: {
    sql: `select account_id, region, instance_id, arn, instance_state, tags, launch_time from aws_ec2_instance`,
    normalize: normalizeEc2Instance,
  },
  s3_bucket: {
    sql: `select account_id, region, name, arn, tags, creation_date from aws_s3_bucket`,
    normalize: normalizeS3Bucket,
  },
} as const;

export async function runAssetSync(resourceTypes: string[] = Object.keys(ASSET_SYNC_QUERIES)) {
  const db = openAssetDb();
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const summary = { discovered: 0, changed: 0, rediscovered: 0, missing: 0, failed: [] as string[] };

  for (const resourceType of resourceTypes) {
    const entry = ASSET_SYNC_QUERIES[resourceType as keyof typeof ASSET_SYNC_QUERIES];
    if (!entry) continue;
    try {
      const result = await runQuery(entry.sql);
      const rows = result.rows || [];
      const assets = rows.map(row => entry.normalize(row, now));
      assets.forEach(asset => seen.add(asset.id));
      const part = upsertDiscoveredAssets(db, assets, now);
      summary.discovered += part.discovered;
      summary.changed += part.changed;
      summary.rediscovered += part.rediscovered;
    } catch (err: any) {
      summary.failed.push(`${resourceType}: ${err.message || String(err)}`);
    }
  }

  if (summary.failed.length === 0) {
    summary.missing = markMissingAssets(db, seen, now);
  }
  return summary;
}
```

- [ ] **Step 3: Add sync action to API**

Modify `src/app/api/assets/route.ts`:

```ts
import { runAssetSync } from '@/lib/assets/asset-sync';

export async function POST(request: NextRequest) {
  const action = request.nextUrl.searchParams.get('action');
  if (action !== 'sync') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }
  const body = await request.json().catch(() => ({}));
  const summary = await runAssetSync(Array.isArray(body.resourceTypes) ? body.resourceTypes : undefined);
  return NextResponse.json({ ok: true, summary });
}
```

- [ ] **Step 4: Run sync query test and typecheck**

Run:

```bash
node tests/assets/test_asset_sync_queries.mjs
./node_modules/.bin/tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 5: Commit sync endpoint**

```bash
git add src/lib/assets/asset-sync.ts src/app/api/assets/route.ts tests/assets/test_asset_sync_queries.mjs
git commit -m "feat: add asset inventory sync"
```

## Task 5: Custom Fields And Admin Token

**Files:**
- Create: `src/lib/assets/asset-admin.ts`
- Create: `src/lib/assets/custom-fields.ts`
- Create: `src/app/api/assets/custom-fields/route.ts`
- Create: `src/app/api/assets/custom-fields/[id]/route.ts`
- Test: `tests/assets/test_custom_fields.mjs`

- [ ] **Step 1: Write custom field test**

Create `tests/assets/test_custom_fields.mjs`:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-assets-fields-'));

try {
  execFileSync(resolve('node_modules/.bin/tsc'), [
    'src/lib/assets/asset-db.ts',
    'src/lib/assets/asset-admin.ts',
    'src/lib/assets/custom-fields.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const { hashAdminToken, verifyAdminToken } = require(join(outDir, 'asset-admin.js'));
  const { openAssetDb } = require(join(outDir, 'asset-db.js'));
  const { createCustomField, listCustomFields } = require(join(outDir, 'custom-fields.js'));

  const hash = hashAdminToken('secret');
  assert.equal(verifyAdminToken('secret', hash), true);
  assert.equal(verifyAdminToken('wrong', hash), false);

  const db = openAssetDb(join(outDir, 'assets.db'));
  createCustomField(db, {
    key: 'business_impact',
    label: '업무영향도',
    type: 'select',
    options: ['상', '중', '하'],
    required: true,
    appliesToServices: ['ec2'],
    appliesToResourceTypes: [],
    displayOrder: 10,
    createdBy: 'admin',
  }, '2026-06-24T00:00:00.000Z');
  assert.equal(listCustomFields(db, true).length, 1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Add admin token helper**

Create `src/lib/assets/asset-admin.ts`:

```ts
import { createHash, timingSafeEqual } from 'crypto';
import { getConfig } from '@/lib/app-config';

export function hashAdminToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

export function verifyAdminToken(token: string, expectedHash: string): boolean {
  if (!token || !expectedHash.startsWith('sha256:')) return false;
  const actual = Buffer.from(hashAdminToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function requireAssetAdmin(headers: Headers): void {
  const configured = process.env.AWSOPS_ASSET_ADMIN_TOKEN_HASH || getConfig().assetInventory?.adminTokenHash || '';
  const token = headers.get('x-awsops-asset-admin-token') || '';
  if (!verifyAdminToken(token, configured)) {
    throw new Error('Asset admin token required');
  }
}
```

- [ ] **Step 3: Extend app config type**

Modify `src/lib/app-config.ts`:

```ts
export interface AssetInventoryConfig {
  enabled?: boolean;
  dbProvider?: 'sqlite';
  sqlitePath?: string;
  syncOnDemandOnly?: boolean;
  adminTokenHash?: string;
  supportedResourceTypes?: string[];
}

export interface AppConfig {
  // existing fields...
  assetInventory?: AssetInventoryConfig;
}
```

Also add to `DEFAULT_CONFIG`:

```ts
assetInventory: {
  enabled: true,
  dbProvider: 'sqlite',
  sqlitePath: 'data/awsops.db',
  syncOnDemandOnly: true,
  adminTokenHash: '',
  supportedResourceTypes: [
    'ec2_instance',
    'ebs_volume',
    'network_interface',
    'load_balancer',
    'vpc',
    'subnet',
    'security_group',
    'rds_instance',
    's3_bucket',
    'lambda_function',
  ],
},
```

- [ ] **Step 4: Add custom field repository**

Create `src/lib/assets/custom-fields.ts` with `createCustomField`, `listCustomFields`, and `deactivateCustomField` using the tables from Task 1. Validate `key` with `/^[a-z][a-z0-9_]{1,63}$/` and type against the allowed type list in `asset-types.ts`.

- [ ] **Step 5: Add custom field API routes**

Create `src/app/api/assets/custom-fields/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { openAssetDb } from '@/lib/assets/asset-db';
import { requireAssetAdmin } from '@/lib/assets/asset-admin';
import { createCustomField, listCustomFields } from '@/lib/assets/custom-fields';

export async function GET() {
  return NextResponse.json({ fields: listCustomFields(openAssetDb(), true) });
}

export async function POST(request: NextRequest) {
  try {
    requireAssetAdmin(request.headers);
    const body = await request.json();
    const field = createCustomField(openAssetDb(), body, new Date().toISOString());
    return NextResponse.json({ field });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: err.message.includes('admin') ? 403 : 400 });
  }
}
```

Create `src/app/api/assets/custom-fields/[id]/route.ts` with `PATCH` for updates and `DELETE` that sets `active=false`. Both require `requireAssetAdmin(request.headers)`.

- [ ] **Step 6: Run custom field test and typecheck**

Run:

```bash
node tests/assets/test_custom_fields.mjs
./node_modules/.bin/tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 7: Commit custom fields**

```bash
git add src/lib/app-config.ts src/lib/assets/asset-admin.ts src/lib/assets/custom-fields.ts src/app/api/assets/custom-fields tests/assets/test_custom_fields.mjs
git commit -m "feat: add asset custom fields"
```

## Task 6: Cloud Assets UI

**Files:**
- Create: `src/app/assets/page.tsx`
- Modify: `src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Add Cloud Assets page**

Create `src/app/assets/page.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import StatsCard from '@/components/dashboard/StatsCard';
import DataTable from '@/components/dashboard/DataTable';
import StatusBadge from '@/components/dashboard/StatusBadge';

interface AssetRow {
  id: string;
  account_name: string;
  account_id: string;
  region: string;
  service: string;
  resource_type: string;
  resource_name: string;
  resource_id: string;
  status: string;
  is_active: number;
  owner_team: string;
  module_name: string;
  phase: string;
  criticality: string;
  security_grade: string;
  last_seen_at: string;
}

export default function AssetsPage() {
  const [rows, setRows] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [q, setQ] = useState('');
  const [service, setService] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (service) params.set('service', service);
    const res = await fetch(`/awsops/api/assets?${params.toString()}`, { cache: 'no-store' });
    const data = await res.json();
    setRows(data.rows || []);
    setLoading(false);
  }, [q, service]);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => ({
    total: rows.length,
    missingMeta: rows.filter(r => !r.owner_team || !r.module_name || r.phase === 'unknown').length,
    inactive: rows.filter(r => !r.is_active).length,
  }), [rows]);

  const sync = async () => {
    setSyncing(true);
    await fetch('/awsops/api/assets?action=sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    setSyncing(false);
    await load();
  };

  return (
    <main className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Cloud Assets</h1>
          <p className="text-sm text-gray-400">AWS 리소스 자동 발견과 자산관리 메타데이터</p>
        </div>
        <button onClick={sync} disabled={syncing} className="flex items-center gap-2 px-4 py-2 rounded bg-accent-cyan text-navy-900 font-semibold disabled:opacity-50">
          <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
          Sync
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatsCard label="Assets" value={stats.total} icon={Database} color="cyan" />
        <StatsCard label="Metadata Missing" value={stats.missingMeta} icon={ShieldCheck} color={stats.missingMeta ? 'orange' : 'green'} />
        <StatsCard label="Inactive" value={stats.inactive} icon={Database} color={stats.inactive ? 'red' : 'green'} />
      </div>

      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-3 text-gray-500" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search resource name, ID, ARN" className="w-full pl-9 pr-3 py-2 bg-navy-800 border border-navy-600 rounded text-white" />
        </div>
        <select value={service} onChange={e => setService(e.target.value)} className="px-3 py-2 bg-navy-800 border border-navy-600 rounded text-white">
          <option value="">All services</option>
          <option value="ec2">EC2</option>
          <option value="s3">S3</option>
        </select>
      </div>

      <DataTable
        data={loading ? undefined : rows}
        columns={[
          { key: 'account_name', label: 'Account' },
          { key: 'region', label: 'Region' },
          { key: 'service', label: 'Service' },
          { key: 'resource_type', label: 'Type' },
          { key: 'resource_name', label: 'Name' },
          { key: 'status', label: 'Status', render: (v: string) => <StatusBadge status={v} /> },
          { key: 'owner_team', label: 'Owner Team' },
          { key: 'module_name', label: 'Module' },
          { key: 'phase', label: 'Phase' },
          { key: 'last_seen_at', label: 'Last Seen' },
        ]}
      />
    </main>
  );
}
```

- [ ] **Step 2: Add sidebar item**

Modify `src/components/layout/Sidebar.tsx` to add a nav entry under the monitoring or overview group:

```ts
{ href: '/assets', label: 'Cloud Assets', icon: Database }
```

Import `Database` from `lucide-react` if not already imported.

- [ ] **Step 3: Run typecheck and build**

Run:

```bash
./node_modules/.bin/tsc --noEmit --pretty false
npm run build
```

Expected: PASS. Existing React hook warnings may remain.

- [ ] **Step 4: Commit Cloud Assets UI**

```bash
git add src/app/assets/page.tsx src/components/layout/Sidebar.tsx
git commit -m "feat: add cloud assets page"
```

## Task 7: CSV Import And Export

**Files:**
- Create: `src/lib/assets/asset-csv.ts`
- Modify: `src/app/api/assets/route.ts`
- Test: `tests/assets/test_asset_csv.mjs`

- [ ] **Step 1: Write CSV test**

Create `tests/assets/test_asset_csv.mjs`:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-assets-csv-'));
try {
  execFileSync(resolve('node_modules/.bin/tsc'), [
    'src/lib/assets/asset-csv.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });
  const require = createRequire(import.meta.url);
  const { toCsv, parseCsv } = require(join(outDir, 'asset-csv.js'));
  const csv = toCsv([{ asset_id: 'a1', owner_team: '플랫폼팀', remarks: 'a,b' }]);
  assert.match(csv, /"a,b"/);
  const rows = parseCsv(csv);
  assert.equal(rows[0].owner_team, '플랫폼팀');
  assert.equal(rows[0].remarks, 'a,b');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Add CSV helper**

Create `src/lib/assets/asset-csv.ts` with RFC4180-compatible quote handling:

```ts
export function toCsv(rows: Array<Record<string, unknown>>): string {
  const headers = Array.from(rows.reduce((set, row) => {
    Object.keys(row).forEach(key => set.add(key));
    return set;
  }, new Set<string>()));
  return [headers.join(','), ...rows.map(row => headers.map(h => quoteCsv(row[h])).join(','))].join('\n');
}

export function parseCsv(csv: string): Array<Record<string, string>> {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] || '']));
  });
}

function quoteCsv(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(current); current = ''; }
    else current += ch;
  }
  out.push(current);
  return out;
}
```

- [ ] **Step 3: Add export/import API actions**

Modify `src/app/api/assets/route.ts`:

```ts
import { toCsv, parseCsv } from '@/lib/assets/asset-csv';
import { updateAssetMetadata } from '@/lib/assets/asset-repository';

// In GET:
if (request.nextUrl.searchParams.get('format') === 'csv') {
  const result = listAssets(db, { limit: 5000 });
  return new Response(toCsv(result.rows as Array<Record<string, unknown>>), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="cloud-assets.csv"',
    },
  });
}

// In POST:
if (action === 'import') {
  const text = await request.text();
  const rows = parseCsv(text);
  rows.forEach(row => {
    if (!row.asset_id) return;
    updateAssetMetadata(openAssetDb(), row.asset_id, {
      ownerTeam: row.owner_team,
      ownerPerson: row.owner_person,
      businessSystem: row.business_system,
      moduleName: row.module_name,
      phase: row.phase,
      purpose: row.purpose,
      criticality: row.criticality,
      securityGrade: row.security_grade,
      costCenter: row.cost_center,
      remarks: row.remarks,
      updatedBy: 'csv-import',
    });
  });
  return NextResponse.json({ ok: true, imported: rows.length });
}
```

- [ ] **Step 4: Run CSV test and typecheck**

Run:

```bash
node tests/assets/test_asset_csv.mjs
./node_modules/.bin/tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 5: Commit CSV support**

```bash
git add src/lib/assets/asset-csv.ts src/app/api/assets/route.ts tests/assets/test_asset_csv.mjs
git commit -m "feat: add asset csv import export"
```

## Task 8: AI Read-Only Asset Queries

**Files:**
- Create: `src/lib/assets/asset-ai.ts`
- Modify: `src/app/api/ai/route.ts`
- Test: `tests/assets/test_asset_ai.mjs`

- [ ] **Step 1: Write AI helper test**

Create `tests/assets/test_asset_ai.mjs`:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-assets-ai-'));
try {
  execFileSync(resolve('node_modules/.bin/tsc'), [
    'src/lib/assets/asset-ai.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });
  const require = createRequire(import.meta.url);
  const { classifyAssetQuestion } = require(join(outDir, 'asset-ai.js'));
  assert.equal(classifyAssetQuestion('담당팀 없는 자산 표로 보여줘'), true);
  assert.equal(classifyAssetQuestion('EC2 인스턴스 CPU 알려줘'), false);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Add asset AI helper**

Create `src/lib/assets/asset-ai.ts`:

```ts
export function classifyAssetQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return [
    '자산',
    '담당팀',
    '담당 조직',
    '모듈',
    '보안등급',
    'criticality',
    'owner team',
    'metadata missing',
  ].some(keyword => q.includes(keyword.toLowerCase()));
}

export function buildAssetAnalysisContext(rows: Array<Record<string, unknown>>, limit: number = 200): string {
  const trimmed = rows.slice(0, limit);
  return [
    `--- CLOUD ASSET INVENTORY DATA (${trimmed.length} rows) ---`,
    'This data is read-only. Do not claim to update the database.',
    '```json',
    JSON.stringify(trimmed, null, 2),
    '```',
  ].join('\n');
}
```

- [ ] **Step 3: Wire AI route**

Modify `src/app/api/ai/route.ts`:

```ts
import { classifyAssetQuestion, buildAssetAnalysisContext } from '@/lib/assets/asset-ai';
import { openAssetDb } from '@/lib/assets/asset-db';
import { listAssets } from '@/lib/assets/asset-repository';
```

Before intent classification in streaming mode and non-streaming mode, if `classifyAssetQuestion(lastMessage)` is true, load assets through `listAssets(openAssetDb(), { metadataMissing: lastMessage.includes('없는') || lastMessage.includes('미입력'), limit: 200 })`, append `buildAssetAnalysisContext(rows)` to the last user message, and call Bedrock with system prompt:

```ts
const assetSystemPrompt = getSystemPrompt(clientLang) + '\nYou answer from Cloud Asset Inventory data only. You may create tables and summaries, but you must not modify data.';
```

- [ ] **Step 4: Run AI helper test and build**

Run:

```bash
node tests/assets/test_asset_ai.mjs
./node_modules/.bin/tsc --noEmit --pretty false
npm run build
```

Expected: PASS. Existing React hook warnings may remain.

- [ ] **Step 5: Commit AI asset queries**

```bash
git add src/lib/assets/asset-ai.ts src/app/api/ai/route.ts tests/assets/test_asset_ai.mjs
git commit -m "feat: add asset inventory ai queries"
```

## Task 9: Docs And Config Samples

**Files:**
- Modify: `docs/examples/config.vm-private.example.json`
- Modify: `docs/TROUBLESHOOTING.md`
- Modify: `docs/onboarding.md`

- [ ] **Step 1: Add sample config**

Add to `docs/examples/config.vm-private.example.json`:

```json
"assetInventory": {
  "enabled": true,
  "dbProvider": "sqlite",
  "sqlitePath": "data/awsops.db",
  "syncOnDemandOnly": true,
  "adminTokenHash": "",
  "supportedResourceTypes": [
    "ec2_instance",
    "ebs_volume",
    "network_interface",
    "load_balancer",
    "vpc",
    "subnet",
    "security_group",
    "rds_instance",
    "s3_bucket",
    "lambda_function"
  ]
}
```

- [ ] **Step 2: Add troubleshooting section**

Add to `docs/TROUBLESHOOTING.md`:

````md
## Cloud Assets Sync Fails

Confirm the SQLite DB path is writable:

```bash
mkdir -p data
touch data/awsops.db
```

Confirm Steampipe can read the selected resources:

```bash
steampipe query "select instance_id from aws_ec2_instance limit 1"
steampipe query "select name from aws_s3_bucket limit 1"
```

Admin custom field changes require `x-awsops-asset-admin-token` and `AWSOPS_ASSET_ADMIN_TOKEN_HASH`.
````

- [ ] **Step 3: Run final verification**

Run:

```bash
node tests/assets/test_asset_db.mjs
node tests/assets/test_asset_sync.mjs
node tests/assets/test_asset_repository.mjs
node tests/assets/test_custom_fields.mjs
node tests/assets/test_asset_csv.mjs
node tests/assets/test_asset_ai.mjs
python3 -m unittest discover -s tests/private -p 'test_*.py' -v
./node_modules/.bin/tsc --noEmit --pretty false
npm run build
bash -n scripts/*.sh
git diff --check
```

Expected: all commands exit 0. Existing build warnings are acceptable only if they are the pre-existing React hook warnings.

- [ ] **Step 4: Commit docs**

```bash
git add docs/examples/config.vm-private.example.json docs/TROUBLESHOOTING.md docs/onboarding.md
git commit -m "docs: document cloud asset inventory"
```

## Self-Review

- Spec coverage: storage, sync, admin custom fields, UI, CSV, AI read-only behavior, no CloudFront default, and no AWS resource creation are covered by tasks.
- Scope kept to 1차 implementation: EC2 and S3 normalizers are explicit first slices; additional resource normalizers can be added after the foundation is verified.
- No incomplete steps remain. Every task has concrete file paths, commands, and expected outcomes.
- Type names are consistent: `AssetRecord`, `AssetMetadata`, `AssetCustomFieldDefinition`, `openAssetDb`, `listAssets`, `updateAssetMetadata`, `runAssetSync`.
