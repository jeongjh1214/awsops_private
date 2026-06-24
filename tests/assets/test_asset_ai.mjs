import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-asset-ai-'));
const dbPath = join(outDir, 'assets.db');
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
    'src/lib/assets/asset-types.ts',
    'src/lib/assets/asset-id.ts',
    'src/lib/assets/asset-db.ts',
    'src/lib/assets/asset-repository.ts',
    'src/lib/assets/asset-ai.ts',
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
    buildAssetInventoryContext,
    detectAssetInventoryQuestion,
    formatAssetInventoryContext,
  } = require(join(outDir, 'asset-ai.js'));

  assert.equal(detectAssetInventoryQuestion('자산관리 관리대장에서 담당조직 누락된 S3 버킷 보여줘'), true);
  assert.equal(detectAssetInventoryQuestion('Which asset inventory items have missing owner team metadata?'), true);
  assert.equal(detectAssetInventoryQuestion('개인정보 포함 클라우드 자산의 module 현황은?'), true);
  assert.equal(detectAssetInventoryQuestion('EC2 CPU 사용률을 CloudWatch에서 확인해줘'), false);

  const db = openAssetDb(dbPath);
  const now = '2026-06-24T00:00:00.000Z';
  const s3ProdId = makeAssetId({
    provider: 'aws',
    accountId: '123456789012',
    region: 'global',
    service: 's3',
    resourceType: 's3_bucket',
    resourceId: 'customer-prod-bucket',
  });
  const s3MissingId = makeAssetId({
    provider: 'aws',
    accountId: '123456789012',
    region: 'global',
    service: 's3',
    resourceType: 's3_bucket',
    resourceId: 'raw-missing-bucket',
  });
  const ec2DevId = makeAssetId({
    provider: 'aws',
    accountId: '123456789012',
    region: 'ap-northeast-2',
    service: 'ec2',
    resourceType: 'ec2_instance',
    resourceId: 'i-dev-001',
  });
  const ec2ProdId = makeAssetId({
    provider: 'aws',
    accountId: '123456789012',
    region: 'ap-northeast-2',
    service: 'ec2',
    resourceType: 'ec2_instance',
    resourceId: 'i-prod-001',
  });

  insertAsset(db, stableJsonHash, {
    id: s3ProdId,
    accountId: '123456789012',
    accountName: 'Prod',
    region: 'global',
    service: 's3',
    resourceType: 's3_bucket',
    resourceId: 'customer-prod-bucket',
    resourceName: 'customer-prod-bucket',
    arn: 'arn:aws:s3:::customer-prod-bucket/very/long/path/that/should/not/be/needed/in/an/ai/context',
    tagsJson: JSON.stringify({
      Name: 'customer-prod-bucket',
      SecretToken: 'do-not-leak-this-entire-tags-json',
      Environment: 'prod',
    }),
    sourceTable: 'aws_s3_bucket',
    now,
  });
  insertAsset(db, stableJsonHash, {
    id: s3MissingId,
    accountId: '123456789012',
    accountName: 'Prod',
    region: 'global',
    service: 's3',
    resourceType: 's3_bucket',
    resourceId: 'raw-missing-bucket',
    resourceName: 'raw-missing-bucket',
    arn: 'arn:aws:s3:::raw-missing-bucket',
    tagsJson: JSON.stringify({ SecretToken: 'missing-secret-value' }),
    sourceTable: 'aws_s3_bucket',
    now,
  });
  insertAsset(db, stableJsonHash, {
    id: ec2DevId,
    accountId: '123456789012',
    accountName: 'Dev',
    region: 'ap-northeast-2',
    service: 'ec2',
    resourceType: 'ec2_instance',
    resourceId: 'i-dev-001',
    resourceName: 'dev-app-01',
    arn: 'arn:aws:ec2:ap-northeast-2:123456789012:instance/i-dev-001',
    tagsJson: JSON.stringify({ Name: 'dev-app-01' }),
    sourceTable: 'aws_ec2_instance',
    now,
  });
  insertAsset(db, stableJsonHash, {
    id: ec2ProdId,
    accountId: '123456789012',
    accountName: 'Prod',
    region: 'ap-northeast-2',
    service: 'ec2',
    resourceType: 'ec2_instance',
    resourceId: 'i-prod-001',
    resourceName: 'prod-app-01',
    arn: 'arn:aws:ec2:ap-northeast-2:123456789012:instance/i-prod-001',
    tagsJson: JSON.stringify({ Name: 'prod-app-01' }),
    sourceTable: 'aws_ec2_instance',
    now,
  });

  insertMetadata(db, {
    assetId: s3ProdId,
    ownerTeam: 'data-platform',
    moduleName: 'customer-data',
    phase: 'prod',
    purpose: 'customer document storage',
    containsPersonalInfo: 1,
    now,
  });
  insertMetadata(db, {
    assetId: s3MissingId,
    ownerTeam: '',
    moduleName: '',
    phase: 'unknown',
    purpose: '',
    containsPersonalInfo: null,
    now,
  });
  insertMetadata(db, {
    assetId: ec2DevId,
    ownerTeam: 'platform',
    moduleName: 'orders-api',
    phase: 'dev',
    purpose: 'development api',
    containsPersonalInfo: 0,
    now,
  });
  insertMetadata(db, {
    assetId: ec2ProdId,
    ownerTeam: 'platform',
    moduleName: 'orders-api',
    phase: 'prod',
    purpose: 'production api',
    containsPersonalInfo: 0,
    now,
  });

  const s3Context = buildAssetInventoryContext(db, 'S3 bucket asset inventory owner team');
  assert.equal(s3Context.filters.service, 's3');
  assert.equal(s3Context.total, 2);
  assert.deepEqual(s3Context.rows.map((row) => row.id).sort(), [s3MissingId, s3ProdId].sort());
  assert.deepEqual(s3Context.summary.serviceCounts, { s3: 2 });
  assert.equal(s3Context.summary.metadataMissingCount, 1);

  const missingContext = buildAssetInventoryContext(db, '담당조직 미입력 누락된 관리대장');
  assert.equal(missingContext.filters.metadataMissing, true);
  assert.equal(missingContext.total, 1);
  assert.equal(missingContext.rows[0].id, s3MissingId);

  const devContext = buildAssetInventoryContext(db, 'dev phase EC2 module metadata');
  assert.equal(devContext.filters.service, 'ec2');
  assert.equal(devContext.filters.phase, 'dev');
  assert.equal(devContext.total, 1);
  assert.equal(devContext.rows[0].id, ec2DevId);

  const formatted = formatAssetInventoryContext(s3Context);
  assert.match(formatted, /owner_team/);
  assert.match(formatted, /module_name/);
  assert.match(formatted, /phase/);
  assert.match(formatted, /purpose/);
  assert.match(formatted, /contains_personal_info/);
  assert.match(formatted, /data-platform/);
  assert.doesNotMatch(formatted, /SecretToken/);
  assert.doesNotMatch(formatted, /do-not-leak-this-entire-tags-json/);
  assert.doesNotMatch(formatted, /very\/long\/path\/that\/should\/not\/be\/needed/);

  const source = readFileSync('src/lib/assets/asset-ai.ts', 'utf8');
  assert.doesNotMatch(source, /updateAssetMetadata|applyAssetCsvImport|previewAssetCsvImport|asset-admin|custom-fields/);
  assert.doesNotMatch(source, /\.run\s*\(|\.exec\s*\(|insert\s+into|update\s+asset_|delete\s+from/i);

  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

function insertAsset(db, stableJsonHash, asset) {
  db.prepare(`
    insert into asset_records (
      id, provider, account_id, account_name, region, service, resource_type,
      resource_id, resource_name, arn, status, native_state, tags_json,
      source_table, source_updated_at, first_discovered_at, last_seen_at,
      is_active, last_hash, created_at, updated_at
    ) values (
      @id, 'aws', @accountId, @accountName, @region, @service, @resourceType,
      @resourceId, @resourceName, @arn, 'active', 'active', @tagsJson,
      @sourceTable, @now, @now, @now, 1, @hash, @now, @now
    )
  `).run({
    ...asset,
    hash: stableJsonHash({
      service: asset.service,
      resourceType: asset.resourceType,
      resourceId: asset.resourceId,
    }),
  });
}

function insertMetadata(db, metadata) {
  db.prepare(`
    insert into asset_metadata (
      asset_id, owner_team, owner_person, business_system, module_name, phase,
      purpose, criticality, security_grade, cost_center, contains_personal_info,
      remarks, updated_by, updated_at
    ) values (
      @assetId, @ownerTeam, '', '', @moduleName, @phase,
      @purpose, '', '', '', @containsPersonalInfo,
      '', 'asset-ai-test', @now
    )
  `).run(metadata);
}
