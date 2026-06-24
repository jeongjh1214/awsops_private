import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-assets-repository-'));
const dbPath = join(outDir, 'assets.db');
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
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
  const { makeAssetId, stableJsonHash } = require(join(outDir, 'asset-id.js'));
  const {
    getAssetDetail,
    listAssets,
    updateAssetMetadata,
  } = require(join(outDir, 'asset-repository.js'));

  const db = openAssetDb(dbPath);
  const now = '2026-06-24T00:00:00.000Z';
  const updatedAt = '2026-06-24T01:00:00.000Z';
  const secondUpdatedAt = '2026-06-24T02:00:00.000Z';
  const thirdUpdatedAt = '2026-06-24T03:00:00.000Z';

  const assetId = makeAssetId({
    provider: 'aws',
    accountId: '123456789012',
    region: 'ap-northeast-2',
    service: 'ec2',
    resourceType: 'ec2_instance',
    resourceId: 'i-123',
  });
  const incompleteAssetId = makeAssetId({
    provider: 'aws',
    accountId: '123456789012',
    region: 'ap-northeast-2',
    service: 'ec2',
    resourceType: 'ec2_instance',
    resourceId: 'i-456',
  });

  db.prepare(`
    insert into asset_records (
      id, provider, account_id, account_name, region, service, resource_type,
      resource_id, resource_name, arn, status, native_state, tags_json,
      source_table, source_updated_at, first_discovered_at, last_seen_at,
      is_active, last_hash, created_at, updated_at
    ) values (
      @id, 'aws', '123456789012', 'Prod', 'ap-northeast-2', 'ec2', 'ec2_instance',
      'i-123', 'app-01', 'arn:aws:ec2:ap-northeast-2:123456789012:instance/i-123',
      'running', 'running', '{"Name":"app-01"}', 'aws_ec2_instance',
      @now, @now, @now, 1, @hash, @now, @now
    )
  `).run({ id: assetId, now, hash: stableJsonHash({ state: 'running' }) });
  db.prepare(`
    insert into asset_records (
      id, provider, account_id, account_name, region, service, resource_type,
      resource_id, resource_name, arn, status, native_state, tags_json,
      source_table, source_updated_at, first_discovered_at, last_seen_at,
      is_active, last_hash, created_at, updated_at
    ) values (
      @id, 'aws', '123456789012', 'Prod', 'ap-northeast-2', 'ec2', 'ec2_instance',
      'i-456', 'worker-01', 'arn:aws:ec2:ap-northeast-2:123456789012:instance/i-456',
      'running', 'running', '{"Name":"worker-01"}', 'aws_ec2_instance',
      @now, @now, @now, 1, @hash, @now, @now
    )
  `).run({ id: incompleteAssetId, now, hash: stableJsonHash({ state: 'running', role: 'worker' }) });

  assert.deepEqual(
    updateAssetMetadata(db, assetId, {
      ownerTeam: 'platform',
      moduleName: 'billing-api',
      phase: 'prod',
      remarks: 'primary workload',
      updatedBy: 'tester@example.com',
      containsPersonalInfo: true,
    }, updatedAt),
    true,
  );
  assert.deepEqual(
    updateAssetMetadata(db, incompleteAssetId, {
      ownerTeam: 'platform',
      moduleName: 'worker',
      phase: 'unknown',
      updatedBy: 'tester@example.com',
    }, updatedAt),
    true,
  );

  let listResult = listAssets(db, { service: 'ec2', metadataMissing: false });
  assert.equal(listResult.total, 1);
  assert.equal(listResult.limit, 100);
  assert.equal(listResult.offset, 0);
  assert.equal(listResult.rows.length, 1);
  assert.equal(listResult.rows[0].id, assetId);
  assert.equal(listResult.rows[0].owner_team, 'platform');
  assert.equal(listResult.rows[0].module_name, 'billing-api');
  assert.equal(listResult.rows[0].phase, 'prod');
  assert.equal(listResult.rows[0].remarks, 'primary workload');
  assert.equal(listResult.rows[0].contains_personal_info, 1);

  assert.deepEqual(
    updateAssetMetadata(db, assetId, {
      ownerTeam: 'platform-sre',
      containsPersonalInfo: undefined,
      updatedBy: 'tester2@example.com',
    }, secondUpdatedAt),
    true,
  );

  listResult = listAssets(db, { service: 'ec2', metadataMissing: false });
  assert.equal(listResult.rows[0].owner_team, 'platform-sre');
  assert.equal(listResult.rows[0].module_name, 'billing-api');
  assert.equal(listResult.rows[0].phase, 'prod');
  assert.equal(listResult.rows[0].remarks, 'primary workload');
  assert.equal(listResult.rows[0].contains_personal_info, 1);

  assert.deepEqual(
    updateAssetMetadata(db, assetId, {
      ownerTeam: 'platform-sre',
      containsPersonalInfo: null,
      updatedBy: 'tester3@example.com',
    }, thirdUpdatedAt),
    true,
  );

  listResult = listAssets(db, { service: 'ec2', metadataMissing: false, limit: 999, offset: -10 });
  assert.equal(listResult.limit, 500);
  assert.equal(listResult.offset, 0);
  assert.equal(listResult.rows[0].owner_team, 'platform-sre');
  assert.equal(listResult.rows[0].module_name, 'billing-api');
  assert.equal(listResult.rows[0].phase, 'prod');
  assert.equal(listResult.rows[0].remarks, 'primary workload');
  assert.equal(listResult.rows[0].contains_personal_info, null);

  listResult = listAssets(db, { service: 'ec2', metadataMissing: true });
  assert.equal(listResult.total, 1);
  assert.equal(listResult.rows.length, 1);
  assert.equal(listResult.rows[0].id, incompleteAssetId);
  listResult = listAssets(db, { service: 'ec2', metadataMissing: false });
  assert.equal(listResult.total, 1);
  assert.equal(listResult.rows.length, 1);
  assert.equal(listResult.rows[0].id, assetId);
  assert.equal(listAssets(db, { q: 'billing-api' }).total, 1);
  assert.equal(listAssets(db, { active: false }).total, 0);

  const detail = getAssetDetail(db, assetId);
  assert.ok(detail);
  assert.equal(detail.id, assetId);
  assert.equal(detail.metadata.owner_team, 'platform-sre');
  assert.equal(detail.metadata.module_name, 'billing-api');
  assert.equal(detail.metadata.contains_personal_info, null);
  assert.deepEqual(detail.customFields, []);
  assert.deepEqual(
    detail.events.map((event) => event.event_type),
    ['metadata_updated', 'metadata_updated', 'metadata_updated'],
  );
  assert.equal(detail.events[0].created_at, thirdUpdatedAt);
  assert.equal(JSON.parse(detail.events[0].before_json).ownerTeam, 'platform-sre');
  assert.equal(JSON.parse(detail.events[0].before_json).containsPersonalInfo, true);
  assert.equal(JSON.parse(detail.events[0].after_json).ownerTeam, 'platform-sre');
  assert.equal(JSON.parse(detail.events[0].after_json).containsPersonalInfo, null);

  assert.equal(updateAssetMetadata(db, 'missing-asset', { ownerTeam: 'ghost' }, updatedAt), false);
  assert.equal(getAssetDetail(db, 'missing-asset'), null);

  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
