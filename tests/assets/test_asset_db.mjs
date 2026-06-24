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
