import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-assets-sync-'));
const dbPath = join(outDir, 'assets.db');
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
    'src/lib/assets/asset-types.ts',
    'src/lib/assets/asset-id.ts',
    'src/lib/assets/asset-db.ts',
    'src/lib/assets/asset-normalizers.ts',
    'src/lib/assets/asset-sync.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const { openAssetDb } = require(join(outDir, 'asset-db.js'));
  const { normalizeEc2Instance } = require(join(outDir, 'asset-normalizers.js'));
  const { markMissingAssets, upsertDiscoveredAssets } = require(join(outDir, 'asset-sync.js'));

  const db = openAssetDb(dbPath);
  const firstSeen = '2026-06-24T00:00:00.000Z';
  const changedAt = '2026-06-24T00:05:00.000Z';
  const missingAt = '2026-06-24T00:10:00.000Z';
  const rediscoveredAt = '2026-06-24T00:15:00.000Z';

  const discoveredAsset = normalizeEc2Instance({
    account_id: '123456789012',
    account_name: 'Prod',
    region: 'ap-northeast-2',
    instance_id: 'i-123',
    arn: 'arn:aws:ec2:ap-northeast-2:123456789012:instance/i-123',
    instance_state: 'running',
    tags: { Name: 'app-01', Environment: 'prod' },
  }, firstSeen);

  assert.equal(discoveredAsset.id, 'aws:123456789012:ap-northeast-2:ec2:ec2_instance:i-123');
  assert.equal(discoveredAsset.resourceName, 'app-01');
  assert.equal(discoveredAsset.status, 'running');
  assert.equal(discoveredAsset.sourceTable, 'aws_ec2_instance');
  assert.deepEqual(discoveredAsset.tags, { Name: 'app-01', Environment: 'prod' });

  assert.deepEqual(
    upsertDiscoveredAssets(db, [discoveredAsset], firstSeen),
    { discovered: 1, changed: 0, rediscovered: 0 },
  );

  let record = db.prepare('select id, resource_name, is_active, first_discovered_at, created_at from asset_records where id = ?').get(discoveredAsset.id);
  assert.equal(record.resource_name, 'app-01');
  assert.equal(record.is_active, 1);
  assert.equal(record.first_discovered_at, firstSeen);
  assert.equal(record.created_at, firstSeen);

  let events = db.prepare('select event_type from asset_change_events where asset_id = ? order by created_at').all(discoveredAsset.id);
  assert.deepEqual(events.map((event) => event.event_type), ['discovered']);

  const changedAsset = normalizeEc2Instance({
    account_id: '123456789012',
    account_name: 'Prod',
    region: 'ap-northeast-2',
    instance_id: 'i-123',
    arn: 'arn:aws:ec2:ap-northeast-2:123456789012:instance/i-123',
    instance_state: 'stopped',
    tags: { Name: 'app-02', Environment: 'prod' },
  }, changedAt);

  assert.deepEqual(
    upsertDiscoveredAssets(db, [changedAsset], changedAt),
    { discovered: 0, changed: 1, rediscovered: 0 },
  );

  record = db.prepare('select resource_name, status, native_state, first_discovered_at, created_at, updated_at from asset_records where id = ?').get(discoveredAsset.id);
  assert.equal(record.resource_name, 'app-02');
  assert.equal(record.status, 'stopped');
  assert.equal(record.native_state, 'stopped');
  assert.equal(record.first_discovered_at, firstSeen);
  assert.equal(record.created_at, firstSeen);
  assert.equal(record.updated_at, changedAt);

  events = db.prepare('select event_type from asset_change_events where asset_id = ? order by created_at').all(discoveredAsset.id);
  assert.deepEqual(events.map((event) => event.event_type), ['discovered', 'changed']);

  markMissingAssets(db, new Set(), missingAt);
  record = db.prepare('select is_active, updated_at from asset_records where id = ?').get(discoveredAsset.id);
  assert.equal(record.is_active, 0);
  assert.equal(record.updated_at, missingAt);

  events = db.prepare('select event_type from asset_change_events where asset_id = ? order by created_at').all(discoveredAsset.id);
  assert.deepEqual(events.map((event) => event.event_type), ['discovered', 'changed', 'missing']);

  const rediscoveredAsset = normalizeEc2Instance({
    account_id: '123456789012',
    account_name: 'Prod',
    region: 'ap-northeast-2',
    instance_id: 'i-123',
    arn: 'arn:aws:ec2:ap-northeast-2:123456789012:instance/i-123',
    instance_state: 'stopped',
    tags: { Name: 'app-02', Environment: 'prod' },
  }, rediscoveredAt);

  assert.deepEqual(
    upsertDiscoveredAssets(db, [rediscoveredAsset], rediscoveredAt),
    { discovered: 0, changed: 0, rediscovered: 1 },
  );

  record = db.prepare('select is_active, last_seen_at, first_discovered_at, created_at from asset_records where id = ?').get(discoveredAsset.id);
  assert.equal(record.is_active, 1);
  assert.equal(record.last_seen_at, rediscoveredAt);
  assert.equal(record.first_discovered_at, firstSeen);
  assert.equal(record.created_at, firstSeen);

  events = db.prepare('select event_type from asset_change_events where asset_id = ? order by created_at').all(discoveredAsset.id);
  assert.deepEqual(events.map((event) => event.event_type), ['discovered', 'changed', 'missing', 'restored']);

  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
