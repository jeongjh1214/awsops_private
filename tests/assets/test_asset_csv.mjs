import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-asset-csv-'));
const dbPath = join(outDir, 'assets.db');
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
    'src/lib/assets/asset-types.ts',
    'src/lib/assets/asset-id.ts',
    'src/lib/assets/asset-db.ts',
    'src/lib/assets/asset-repository.ts',
    'src/lib/assets/asset-csv.ts',
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
    updateAssetMetadata,
  } = require(join(outDir, 'asset-repository.js'));
  const {
    ASSET_CSV_HEADERS,
    exportAssetsCsv,
    previewAssetCsvImport,
    applyAssetCsvImport,
  } = require(join(outDir, 'asset-csv.js'));

  const db = openAssetDb(dbPath);
  const now = '2026-06-24T00:00:00.000Z';
  const ec2AssetId = makeAssetId({
    provider: 'aws',
    accountId: '123456789012',
    region: 'ap-northeast-2',
    service: 'ec2',
    resourceType: 'ec2_instance',
    resourceId: 'i-csv-1',
  });
  const bucketAssetId = makeAssetId({
    provider: 'aws',
    accountId: '210987654321',
    region: 'global',
    service: 's3',
    resourceType: 's3_bucket',
    resourceId: 'critical-bucket',
  });

  insertAsset(db, stableJsonHash, {
    id: ec2AssetId,
    accountId: '123456789012',
    accountName: 'Prod',
    region: 'ap-northeast-2',
    service: 'ec2',
    resourceType: 'ec2_instance',
    resourceId: 'i-csv-1',
    resourceName: 'app, api',
    arn: 'arn:aws:ec2:ap-northeast-2:123456789012:instance/i-csv-1',
    sourceTable: 'aws_ec2_instance',
    now,
  });
  insertAsset(db, stableJsonHash, {
    id: bucketAssetId,
    accountId: '210987654321',
    accountName: 'Shared',
    region: 'global',
    service: 's3',
    resourceType: 's3_bucket',
    resourceId: 'critical-bucket',
    resourceName: 'critical-bucket',
    arn: 'arn:aws:s3:::critical-bucket',
    sourceTable: 'aws_s3_bucket',
    now,
  });

  assert.deepEqual(ASSET_CSV_HEADERS.slice(0, 4), ['asset_id', 'account_name', 'account_id', 'phase']);
  assert.ok(ASSET_CSV_HEADERS.includes('contains_personal_info'));

  updateAssetMetadata(db, ec2AssetId, {
    ownerTeam: 'platform',
    ownerPerson: 'Lee',
    businessSystem: 'orders',
    moduleName: 'checkout',
    phase: 'prod',
    purpose: 'API, worker',
    criticality: 'high',
    securityGrade: 'A',
    costCenter: 'CC-42',
    containsPersonalInfo: true,
    remarks: 'line "one", with comma\nline two',
    updatedBy: 'seed',
  }, '2026-06-24T01:00:00.000Z');

  const exported = exportAssetsCsv(db);
  assert.ok(exported.startsWith(`${ASSET_CSV_HEADERS.join(',')}\n`));
  assert.ok(exported.includes('"app, api"'));
  assert.ok(exported.includes('"API, worker"'));
  assert.ok(exported.includes('"line ""one"", with comma\nline two"'));

  const quotedCsv = [
    'asset_id,owner_team,purpose,remarks,contains_personal_info',
    `${ec2AssetId},"team, csv","quote ""inside""","first line`,
    'second line",unknown',
  ].join('\n');
  const quotedPreview = previewAssetCsvImport(db, quotedCsv);
  assert.equal(quotedPreview.valid, 1);
  assert.equal(quotedPreview.invalid, 0);
  assert.equal(quotedPreview.rows[0].assetId, ec2AssetId);
  assert.equal(quotedPreview.rows[0].values.ownerTeam, 'team, csv');
  assert.equal(quotedPreview.rows[0].values.purpose, 'quote "inside"');
  assert.equal(quotedPreview.rows[0].values.remarks, 'first line\nsecond line');
  assert.equal(quotedPreview.rows[0].values.containsPersonalInfo, null);

  const koreanAliasCsv = [
    'accountid,service,resource_type,bucketname,담당조직,용도,개인정보 데이터 유무 여부,비고',
    '210987654321,s3,s3_bucket,critical-bucket,데이터플랫폼,로그 보관,유,"한국어 alias, import"',
  ].join('\n');
  const aliasPreview = previewAssetCsvImport(db, koreanAliasCsv);
  assert.equal(aliasPreview.valid, 1);
  assert.equal(aliasPreview.invalid, 0);
  assert.equal(aliasPreview.rows[0].assetId, bucketAssetId);
  assert.equal(aliasPreview.rows[0].values.ownerTeam, '데이터플랫폼');
  assert.equal(aliasPreview.rows[0].values.purpose, '로그 보관');
  assert.equal(aliasPreview.rows[0].values.containsPersonalInfo, true);
  assert.equal(aliasPreview.rows[0].values.remarks, '한국어 alias, import');

  const applied = applyAssetCsvImport(db, koreanAliasCsv, 'csv-tester');
  assert.equal(applied.applied, 1);
  assert.equal(applied.errors.length, 0);

  const bucketDetail = getAssetDetail(db, bucketAssetId);
  assert.ok(bucketDetail);
  assert.equal(bucketDetail.metadata.owner_team, '데이터플랫폼');
  assert.equal(bucketDetail.metadata.purpose, '로그 보관');
  assert.equal(bucketDetail.metadata.contains_personal_info, 1);
  assert.equal(bucketDetail.metadata.remarks, '한국어 alias, import');
  assert.equal(bucketDetail.metadata.updated_by, 'csv-tester');

  const mixedCsv = [
    'asset_id,owner_team,remarks',
    `${bucketAssetId},should-not-apply,valid row`,
    'missing-asset,ghost,invalid row',
  ].join('\n');
  const mixedPreview = previewAssetCsvImport(db, mixedCsv);
  assert.equal(mixedPreview.valid, 1);
  assert.equal(mixedPreview.invalid, 1);
  assert.equal(mixedPreview.errors.length, 1);
  assert.match(mixedPreview.errors[0].message, /not found/i);

  const failedApply = applyExpectingFailure(db, mixedCsv);
  assert.equal(failedApply.applied, 0);
  assert.equal(failedApply.errors.length, 1);

  const unchangedBucketDetail = getAssetDetail(db, bucketAssetId);
  assert.ok(unchangedBucketDetail);
  assert.equal(unchangedBucketDetail.metadata.owner_team, '데이터플랫폼');
  assert.equal(unchangedBucketDetail.metadata.remarks, '한국어 alias, import');

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
      @resourceId, @resourceName, @arn, 'active', 'active', '{}',
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

function applyExpectingFailure(db, csvText) {
  try {
    return applyAssetCsvImport(db, csvText, 'csv-tester');
  } catch (error) {
    return {
      applied: 0,
      errors: error.errors || [{ message: error.message }],
    };
  }
}
