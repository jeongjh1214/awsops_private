import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-assets-sync-queries-'));
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
  execFileSync(tsc, [
    'src/lib/app-config.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const {
    ASSET_SYNC_QUERIES,
    parseAssetSyncResourceTypesInput,
    runAssetSync,
    selectAssetSyncResourceTypes,
  } = require(join(outDir, 'asset-sync.js'));
  const { openAssetDb } = require(join(outDir, 'asset-db.js'));

  assert.match(
    ASSET_SYNC_QUERIES.ec2_instance.sql.toLowerCase(),
    /\bfrom\s+aws_ec2_instance\b/,
  );
  assert.match(
    ASSET_SYNC_QUERIES.s3_bucket.sql.toLowerCase(),
    /\bfrom\s+aws_s3_bucket\b/,
  );
  assert.equal(ASSET_SYNC_QUERIES.cloudfront_distribution, undefined);

  assert.deepEqual(
    selectAssetSyncResourceTypes(
      ['ec2_instance', 'cloudfront_distribution'],
      ['ec2_instance', 's3_bucket'],
    ),
    {
      selected: ['ec2_instance'],
      unsupported: ['cloudfront_distribution'],
    },
  );

  assert.deepEqual(
    selectAssetSyncResourceTypes(undefined, ['s3_bucket']),
    {
      selected: ['s3_bucket'],
      unsupported: [],
    },
  );

  assert.deepEqual(
    selectAssetSyncResourceTypes(['cloudfront_distribution'], ['ec2_instance']),
    {
      selected: [],
      unsupported: ['cloudfront_distribution'],
    },
  );

  assert.deepEqual(parseAssetSyncResourceTypesInput(undefined), {});
  assert.deepEqual(parseAssetSyncResourceTypesInput(['ec2_instance']), { resourceTypes: ['ec2_instance'] });
  assert.deepEqual(
    parseAssetSyncResourceTypesInput('ec2_instance'),
    { error: 'resourceTypes must be an array of strings' },
  );
  assert.deepEqual(
    parseAssetSyncResourceTypesInput(['ec2_instance', 123]),
    { error: 'resourceTypes must be an array of strings' },
  );

  const disabledSummary = await runAssetSync({
    dependencies: {
      getAssetInventoryConfig: () => ({ enabled: false }),
    },
  });
  assert.equal(disabledSummary.skipped, true);
  assert.equal(disabledSummary.reason, 'asset inventory sync is disabled');

  mkdirSync(join(outDir, 'data'), { recursive: true });
  writeFileSync(
    join(outDir, 'data', 'config.json'),
    JSON.stringify({ assetInventory: { enabled: false } }),
    'utf-8',
  );
  const originalCwd = process.cwd();
  process.chdir(outDir);
  try {
    const directDisabledSummary = await runAssetSync();
    assert.equal(directDisabledSummary.skipped, true);
    assert.equal(directDisabledSummary.reason, 'asset inventory sync is disabled');
  } finally {
    process.chdir(originalCwd);
  }

  const unsupportedDbPath = join(outDir, 'unsupported-only.db');
  const unsupportedSummary = await runAssetSync({
    resourceTypes: ['cloudfront_distribution'],
    sqlitePath: unsupportedDbPath,
    dependencies: {
      getAssetInventoryConfig: () => ({
        enabled: true,
        dbProvider: 'sqlite',
        sqlitePath: unsupportedDbPath,
        supportedResourceTypes: ['ec2_instance'],
      }),
      openAssetDb,
      runQuery: async () => {
        throw new Error('runQuery should not be called when no resource types are selected');
      },
    },
  });
  assert.deepEqual(unsupportedSummary.selected, []);
  assert.deepEqual(unsupportedSummary.unsupported, ['cloudfront_distribution']);
  assert.deepEqual(unsupportedSummary.failed, [
    {
      resourceType: 'cloudfront_distribution',
      error: 'unsupported resource type',
    },
  ]);

  const unsupportedDb = openAssetDb(unsupportedDbPath);
  try {
    const syncRun = unsupportedDb.prepare('select status, summary_json from asset_sync_runs order by started_at desc limit 1').get();
    assert.equal(syncRun.status, 'failed');
    assert.deepEqual(JSON.parse(syncRun.summary_json).unsupported, ['cloudfront_distribution']);
  } finally {
    unsupportedDb.close();
  }

  const scopedDbPath = join(outDir, 'scoped-sync.db');
  let capturedRunQuerySql;
  let capturedRunQueryOpts;
  const scopedSummary = await runAssetSync({
    resourceTypes: ['s3_bucket'],
    accountId: '123456789012',
    sqlitePath: scopedDbPath,
    dependencies: {
      getAssetInventoryConfig: () => ({
        enabled: true,
        dbProvider: 'sqlite',
        sqlitePath: scopedDbPath,
        supportedResourceTypes: ['s3_bucket'],
      }),
      openAssetDb,
      runQuery: async (sql, opts) => {
        capturedRunQuerySql = sql;
        capturedRunQueryOpts = opts;
        return {
          rows: [{
            account_id: '123456789012',
            name: 'logs',
            creation_date: '2026-06-24T00:00:00.000Z',
          }],
        };
      },
    },
  });
  assert.match(capturedRunQuerySql.toLowerCase(), /\bfrom\s+aws_s3_bucket\b/);
  assert.deepEqual(capturedRunQueryOpts, { bustCache: true, accountId: '123456789012' });
  assert.deepEqual(scopedSummary.selected, ['s3_bucket']);
  assert.equal(scopedSummary.discovered, 1);

  const protectedSummary = await runAssetSync({
    resourceTypes: ['s3_bucket'],
    accountId: '123456789012',
    sqlitePath: scopedDbPath,
    dependencies: {
      getAssetInventoryConfig: () => ({
        enabled: true,
        dbProvider: 'sqlite',
        sqlitePath: scopedDbPath,
        supportedResourceTypes: ['s3_bucket'],
      }),
      openAssetDb,
      runQuery: async (sql) => (
        /\bfrom\s+aws_caller_identity\b/i.test(sql)
          ? { rows: [], error: 'transient Steampipe connection failure' }
          : { rows: [] }
      ),
    },
  });
  assert.equal(protectedSummary.missing, 0);
  assert.match(protectedSummary.failed[0].error, /health probe failed/i);
  let scopedDb = openAssetDb(scopedDbPath);
  assert.equal(
    scopedDb.prepare("select is_active from asset_records where resource_type='s3_bucket'").get().is_active,
    1,
  );
  scopedDb.close();

  const confirmedEmptySummary = await runAssetSync({
    resourceTypes: ['s3_bucket'],
    accountId: '123456789012',
    sqlitePath: scopedDbPath,
    dependencies: {
      getAssetInventoryConfig: () => ({
        enabled: true,
        dbProvider: 'sqlite',
        sqlitePath: scopedDbPath,
        supportedResourceTypes: ['s3_bucket'],
      }),
      openAssetDb,
      runQuery: async (sql) => (
        /\bfrom\s+aws_caller_identity\b/i.test(sql)
          ? { rows: [{ account_id: '123456789012' }] }
          : { rows: [] }
      ),
    },
  });
  assert.equal(confirmedEmptySummary.failed.length, 0);
  assert.equal(confirmedEmptySummary.missing, 1);
  scopedDb = openAssetDb(scopedDbPath);
  assert.equal(
    scopedDb.prepare("select is_active from asset_records where resource_type='s3_bucket'").get().is_active,
    0,
  );
  scopedDb.close();

  const s3PageSource = readFileSync('src/app/s3/page.tsx', 'utf8');
  assert.match(s3PageSource, /\/awsops\/api\/steampipe/);
  assert.doesNotMatch(s3PageSource, /\/awsops\/api\/s3(?:['"`?])/);

  const assetsRouteSource = readFileSync('src/app/api/assets/route.ts', 'utf8');
  assert.doesNotMatch(assetsRouteSource, /s3-sdk-sync|listS3Buckets/);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
