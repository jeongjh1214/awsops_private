import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-query-policy-'));
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
    'src/lib/query-policy-shared.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const policy = require(join(outDir, 'query-policy-shared.js'));

  assert.deepEqual(policy.DEFAULT_ENABLED_QUERY_SERVICES, [
    'ec2',
    'lambda',
    'ecs',
    'vpc',
    'ebs',
    's3',
    'rds',
    'dynamodb',
    'elasticache',
    'cloudwatch',
    'iam',
  ]);

  assert.deepEqual(
    policy.detectQueryServices(`
      SELECT *
      FROM aws_rds_db_instance
      JOIN aws_cloudwatch_metric_statistic_data_point ON true
      JOIN aws_vpc_security_group ON true
    `),
    ['rds', 'cloudwatch', 'vpc'],
  );

  assert.deepEqual(
    Object.keys(policy.filterQueryRecordByPolicy({
      ec2: 'select * from aws_ec2_instance',
      s3: 'select * from aws_s3_bucket',
      cloudtrail: 'select * from aws_cloudtrail_trail',
      opensearch: 'select * from aws_opensearch_domain',
    }, policy.DEFAULT_ENABLED_QUERY_SERVICES)),
    ['ec2', 's3'],
  );

  assert.deepEqual(
    policy.getBlockedQueryServices(
      'select * from aws_unknown_service_resource',
      policy.DEFAULT_ENABLED_QUERY_SERVICES,
    ),
    ['unknown:aws_unknown_service_resource'],
  );

  const steampipeSource = readFileSync('src/lib/steampipe.ts', 'utf8');
  assert.match(steampipeSource, /validateQueryServicePolicy\(sql\)/);

  const cacheWarmerSource = readFileSync('src/lib/cache-warmer.ts', 'utf8');
  assert.match(cacheWarmerSource, /filterQueryRecordByPolicy/);

  const dashboardSource = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(dashboardSource, /filterQueryRecordByPolicy/);

  const sidebarSource = readFileSync('src/components/layout/Sidebar.tsx', 'utf8');
  assert.match(sidebarSource, /requiredServices/);

  const benchmarkSource = readFileSync('src/app/api/benchmark/route.ts', 'utf8');
  assert.match(benchmarkSource, /allowComplianceBenchmark/);
  assert.match(benchmarkSource, /status:\s*403/);

  for (const route of ['opensearch', 'msk', 'bedrock-metrics', 'k8s', 'container-cost', 'eks-container-cost']) {
    const source = readFileSync(`src/app/api/${route}/route.ts`, 'utf8');
    assert.match(source, /isQueryServiceEnabled/);
    assert.match(source, /status:\s*403/);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
