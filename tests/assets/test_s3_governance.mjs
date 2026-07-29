import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-s3-governance-'));
const dbPath = join(outDir, 'assets.db');
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
    'src/lib/assets/asset-types.ts',
    'src/lib/assets/asset-id.ts',
    'src/lib/assets/asset-db.ts',
    'src/lib/assets/s3-governance.ts',
    'src/lib/assets/asset-ai.ts',
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
    buildS3GovernanceContext,
    formatS3GovernanceContext,
  } = require(join(outDir, 'asset-ai.js'));
  const {
    getS3GovernanceRecord,
    listS3GovernanceRecords,
    seedS3GovernanceRecordsFromAssets,
    updateS3GovernanceRecord,
  } = require(join(outDir, 's3-governance.js'));

  const db = openAssetDb(dbPath);
  const now = '2026-06-24T00:00:00.000Z';
  const updatedAt = '2026-06-24T01:00:00.000Z';
  const missingAt = '2026-06-24T02:00:00.000Z';
  const secondUpdatedAt = '2026-06-24T03:00:00.000Z';

  insertS3Asset(db, makeAssetId, stableJsonHash, {
    accountId: '123456789012',
    accountName: 'Common Dev',
    bucketName: 'customer-prod-bucket',
    isActive: 1,
    lastSeenAt: now,
    now,
  });
  insertS3Asset(db, makeAssetId, stableJsonHash, {
    accountId: '123456789012',
    accountName: 'Common Dev',
    bucketName: 'deleted-customer-bucket',
    isActive: 0,
    lastSeenAt: missingAt,
    now,
  });
  insertS3Asset(db, makeAssetId, stableJsonHash, {
    accountId: '999999999999',
    accountName: 'Other Account',
    bucketName: 'other-account-bucket',
    isActive: 1,
    lastSeenAt: now,
    now,
  });

  assert.equal(
    updateS3GovernanceRecord(db, {
      accountId: '123456789012',
      accountName: 'Common Dev Alias',
      phase: 'dev',
      bucketName: 'customer-prod-bucket',
      ownerTeam: 'data-platform',
      purpose: 'customer document storage',
      history: 'initial registration',
      containsPersonalInfo: true,
      piiRetentionAware: true,
      piiRetentionApplied: false,
      piiRetentionPeriod: '3 years after termination',
      remarks: 'needs lifecycle confirmation',
      updatedBy: 'tester@example.com',
    }, updatedAt),
    true,
  );
  assert.equal(
    updateS3GovernanceRecord(db, {
      accountId: '123456789012',
      accountName: 'Common Dev Alias',
      phase: 'dev',
      bucketName: 'deleted-customer-bucket',
      ownerTeam: 'data-platform',
      purpose: 'legacy export',
      history: 'kept for audit after deletion',
      containsPersonalInfo: false,
      piiRetentionAware: null,
      piiRetentionApplied: null,
      piiRetentionPeriod: '',
      remarks: 'bucket no longer exists',
      updatedBy: 'tester@example.com',
    }, updatedAt),
    true,
  );

  let result = listS3GovernanceRecords(db, { accountId: '123456789012' });
  assert.equal(result.total, 2);
  assert.deepEqual(result.rows.map((row) => row.bucket_name).sort(), [
    'customer-prod-bucket',
    'deleted-customer-bucket',
  ]);
  assert.equal(result.rows.find((row) => row.bucket_name === 'customer-prod-bucket').asset_is_active, 1);
  assert.equal(result.rows.find((row) => row.bucket_name === 'deleted-customer-bucket').asset_is_active, 0);

  assert.equal(
    updateS3GovernanceRecord(db, {
      accountId: '123456789012',
      bucketName: 'customer-prod-bucket',
      ownerTeam: 'data-governance',
      piiRetentionApplied: true,
      updatedBy: 'auditor@example.com',
    }, secondUpdatedAt),
    true,
  );

  const detail = getS3GovernanceRecord(db, '123456789012:customer-prod-bucket');
  assert.ok(detail);
  assert.equal(detail.owner_team, 'data-governance');
  assert.equal(detail.purpose, 'customer document storage');
  assert.equal(detail.pii_retention_applied, 1);
  assert.equal(detail.asset_is_active, 1);
  assert.equal(detail.events.length, 2);
  assert.equal(detail.events[0].event_type, 'governance_updated');
  assert.equal(JSON.parse(detail.events[0].before_json).ownerTeam, 'data-platform');
  assert.equal(JSON.parse(detail.events[0].after_json).ownerTeam, 'data-governance');

  result = listS3GovernanceRecords(db, { active: false });
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].bucket_name, 'deleted-customer-bucket');
  assert.equal(result.rows[0].history, 'kept for audit after deletion');

  insertS3Asset(db, makeAssetId, stableJsonHash, {
    accountId: '123456789012',
    accountName: 'Common Dev',
    bucketName: 'new-auto-bucket',
    isActive: 1,
    lastSeenAt: secondUpdatedAt,
    now,
  });
  const seedSummary = seedS3GovernanceRecordsFromAssets(db, {
    accountId: '123456789012',
    updatedBy: 'seed-test',
  }, '2026-06-24T04:00:00.000Z');
  assert.deepEqual(seedSummary, {
    scanned: 3,
    created: 1,
    skipped: 2,
  });
  result = listS3GovernanceRecords(db, { accountId: '123456789012' });
  assert.equal(result.total, 3);
  const seededRecord = getS3GovernanceRecord(db, '123456789012:new-auto-bucket');
  assert.ok(seededRecord);
  assert.equal(seededRecord.account_name, 'Common Dev');
  assert.equal(seededRecord.owner_team, '');
  assert.equal(seededRecord.purpose, '');
  assert.equal(seededRecord.contains_personal_info, null);
  assert.equal(seededRecord.asset_is_active, 1);
  assert.equal(seededRecord.events[0].event_type, 'governance_seeded');
  assert.equal(getS3GovernanceRecord(db, '123456789012:customer-prod-bucket').account_name, 'Common Dev Alias');
  assert.equal(listS3GovernanceRecords(db, { accountId: '999999999999' }).total, 0);

  result = listS3GovernanceRecords(db, { containsPersonalInfo: null });
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].bucket_name, 'new-auto-bucket');

  const unknownContext = buildS3GovernanceContext(
    db,
    'S3 버킷에 개인정보 유무가 알수 없음으로 되어있는 것 체크해줘',
  );
  assert.equal(unknownContext.filters.containsPersonalInfo, null);
  assert.equal(unknownContext.total, 1);
  assert.equal(unknownContext.rows[0].bucket_name, 'new-auto-bucket');

  const missingContext = buildS3GovernanceContext(db, 'S3 개인정보 유무 미입력 버킷 알려줘');
  assert.equal(missingContext.filters.containsPersonalInfo, null);
  assert.equal(missingContext.filters.active, undefined);
  assert.equal(missingContext.total, 1);

  const noPersonalInfoContext = buildS3GovernanceContext(db, '개인정보 없는 S3 버킷 보여줘');
  assert.equal(noPersonalInfoContext.filters.containsPersonalInfo, false);
  assert.equal(noPersonalInfoContext.total, 1);
  assert.equal(noPersonalInfoContext.rows[0].bucket_name, 'deleted-customer-bucket');

  const context = buildS3GovernanceContext(db, 'S3 관리대장에서 개인정보 포함 버킷 알려줘');
  assert.equal(context.filters.containsPersonalInfo, true);
  assert.equal(context.total, 1);
  assert.equal(context.rows[0].bucket_name, 'customer-prod-bucket');
  assert.equal(context.rows[0].contains_personal_info, true);
  const formatted = formatS3GovernanceContext(context);
  assert.match(formatted, /stored_s3_governance_register_db/);
  assert.match(formatted, /pii_retention_applied/);
  assert.match(formatted, /customer-prod-bucket/);

  const listRouteSource = readFileSync('src/app/api/s3-governance/route.ts', 'utf8');
  assert.match(listRouteSource, /sanitizeCsvCell/);
  assert.match(listRouteSource, /Invalid boolean value for/);
  assert.match(listRouteSource, /normalized === 'unknown'/);
  const detailRouteSource = readFileSync('src/app/api/s3-governance/[stableKey]/route.ts', 'utf8');
  assert.match(detailRouteSource, /Invalid boolean value for/);
  const pageSource = readFileSync('src/app/s3-governance/page.tsx', 'utf8');
  assert.match(pageSource, /<option value="unknown">알 수 없음<\/option>/);
  assert.match(
    pageSource,
    /selectedKey\s*===\s*'__new__'[\s\S]{0,120}return/,
    'new S3 governance records should open the drawer without fetching /api/s3-governance/__new__',
  );

  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

function insertS3Asset(db, makeAssetId, stableJsonHash, asset) {
  const assetId = makeAssetId({
    provider: 'aws',
    accountId: asset.accountId,
    region: 'global',
    service: 's3',
    resourceType: 's3_bucket',
    resourceId: asset.bucketName,
  });

  db.prepare(`
    insert into asset_records (
      id, provider, account_id, account_name, region, service, resource_type,
      resource_id, resource_name, arn, status, native_state, tags_json,
      source_table, source_updated_at, first_discovered_at, last_seen_at,
      is_active, last_hash, created_at, updated_at
    ) values (
      @id, 'aws', @accountId, @accountName, 'global', 's3', 's3_bucket',
      @bucketName, @bucketName, @arn, @status, @status, '{}',
      'aws_s3_bucket', @now, @now, @lastSeenAt,
      @isActive, @hash, @now, @now
    )
  `).run({
    id: assetId,
    accountId: asset.accountId,
    accountName: asset.accountName,
    bucketName: asset.bucketName,
    arn: `arn:aws:s3:::${asset.bucketName}`,
    status: asset.isActive ? 'active' : 'missing',
    isActive: asset.isActive,
    lastSeenAt: asset.lastSeenAt,
    now: asset.now,
    hash: stableJsonHash({
      service: 's3',
      resourceType: 's3_bucket',
      bucketName: asset.bucketName,
    }),
  });
}
