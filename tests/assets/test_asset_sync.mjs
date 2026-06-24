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
  const { normalizeEc2Instance, normalizeS3Bucket } = require(join(outDir, 'asset-normalizers.js'));
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

  const ec2FallbackIdentityAsset = normalizeEc2Instance({
    account_id: '123456789012',
    region: 'ap-northeast-2',
    instance_id: '',
    id: 'i-fallback',
    instance_state: 'running',
  }, firstSeen);

  assert.equal(ec2FallbackIdentityAsset.id, 'aws:123456789012:ap-northeast-2:ec2:ec2_instance:i-fallback');
  assert.equal(ec2FallbackIdentityAsset.resourceId, 'i-fallback');

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

  events = db.prepare('select event_type, after_json from asset_change_events where asset_id = ? order by created_at').all(discoveredAsset.id);
  assert.deepEqual(events.map((event) => event.event_type), ['discovered', 'changed']);
  let afterJson = JSON.parse(events.at(-1).after_json);
  assert.equal(afterJson.createdAt, firstSeen);
  assert.equal(afterJson.firstDiscoveredAt, firstSeen);

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

  events = db.prepare('select event_type, after_json from asset_change_events where asset_id = ? order by created_at').all(discoveredAsset.id);
  assert.deepEqual(events.map((event) => event.event_type), ['discovered', 'changed', 'missing', 'restored']);
  afterJson = JSON.parse(events.at(-1).after_json);
  assert.equal(afterJson.createdAt, firstSeen);
  assert.equal(afterJson.firstDiscoveredAt, firstSeen);

  const s3Seen = '2026-06-24T00:20:00.000Z';
  const scopedEc2MissingAt = '2026-06-24T00:25:00.000Z';
  const scopedS3MissingAt = '2026-06-24T00:30:00.000Z';
  const s3Asset = normalizeS3Bucket({
    account_id: '123456789012',
    account_name: 'Prod',
    name: 'logs-prod',
    tags: { Environment: 'prod' },
  }, s3Seen);

  assert.equal(s3Asset.id, 'aws:123456789012:global:s3:s3_bucket:logs-prod');
  assert.equal(s3Asset.sourceTable, 'aws_s3_bucket');
  assert.equal(s3Asset.region, 'global');
  assert.equal(s3Asset.arn, 'arn:aws:s3:::logs-prod');
  assert.equal(s3Asset.status, 'available');
  assert.equal(s3Asset.nativeState, 'available');
  assert.equal(s3Asset.resourceId, 'logs-prod');
  assert.equal(s3Asset.resourceName, 'logs-prod');

  const s3FallbackIdentityAsset = normalizeS3Bucket({
    account_id: '123456789012',
    name: '   ',
    bucket_name: 'logs-fallback',
  }, s3Seen);

  assert.equal(s3FallbackIdentityAsset.id, 'aws:123456789012:global:s3:s3_bucket:logs-fallback');
  assert.equal(s3FallbackIdentityAsset.resourceId, 'logs-fallback');
  assert.equal(s3FallbackIdentityAsset.resourceName, 'logs-fallback');
  assert.equal(s3FallbackIdentityAsset.arn, 'arn:aws:s3:::logs-fallback');

  assert.deepEqual(
    upsertDiscoveredAssets(db, [s3Asset], s3Seen),
    { discovered: 1, changed: 0, rediscovered: 0 },
  );

  assert.equal(markMissingAssets(db, new Set([discoveredAsset.id]), scopedEc2MissingAt, { services: ['ec2'] }), 0);
  record = db.prepare('select is_active, updated_at from asset_records where id = ?').get(discoveredAsset.id);
  assert.equal(record.is_active, 1);
  assert.equal(record.updated_at, rediscoveredAt);
  record = db.prepare('select is_active, updated_at from asset_records where id = ?').get(s3Asset.id);
  assert.equal(record.is_active, 1);
  assert.equal(record.updated_at, s3Seen);

  assert.equal(markMissingAssets(db, new Set(), scopedS3MissingAt, { services: ['s3'] }), 1);
  record = db.prepare('select is_active, updated_at from asset_records where id = ?').get(s3Asset.id);
  assert.equal(record.is_active, 0);
  assert.equal(record.updated_at, scopedS3MissingAt);
  record = db.prepare('select is_active, updated_at from asset_records where id = ?').get(discoveredAsset.id);
  assert.equal(record.is_active, 1);
  assert.equal(record.updated_at, rediscoveredAt);

  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
