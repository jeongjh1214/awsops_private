import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

  const require = createRequire(import.meta.url);
  const {
    ASSET_SYNC_QUERIES,
    selectAssetSyncResourceTypes,
  } = require(join(outDir, 'asset-sync.js'));

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
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
