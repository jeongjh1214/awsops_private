import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-identity-audit-db-'));
const dbPath = join(outDir, 'assets.db');
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
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

  const db = openAssetDb(dbPath);
  const tableNames = db.prepare(`
    select name
    from sqlite_master
    where type = 'table'
      and name in (
        'identity_audit_runs',
        'identity_users',
        'identity_org_snapshots',
        'identity_org_change_events',
        'identity_aws_assignments',
        'identity_audit_findings'
      )
  `).all().map((row) => row.name).sort();

  assert.deepEqual(tableNames, [
    'identity_audit_findings',
    'identity_audit_runs',
    'identity_aws_assignments',
    'identity_org_change_events',
    'identity_org_snapshots',
    'identity_users',
  ]);

  db.prepare(`
    insert into identity_audit_runs (
      id, status, started_at, total_users, org_resolved_users,
      changed_users, risky_users, error_count, error_message
    ) values (
      'run-1', 'running', '2026-06-27T00:00:00.000Z', 0, 0, 0, 0, 0, ''
    )
  `).run();

  db.prepare(`
    insert into identity_users (
      display_name, current_org_code, current_org_name, current_assignment_count,
      is_active, first_seen_at, last_seen_at, updated_at
    ) values (
      'billy.j', 'ABC12345', '클라우드파트', 2, 1,
      '2026-06-27T00:00:00.000Z',
      '2026-06-27T00:00:00.000Z',
      '2026-06-27T00:00:00.000Z'
    )
  `).run();

  const user = db.prepare('select current_org_code from identity_users where display_name = ?').get('billy.j');
  assert.equal(user.current_org_code, 'ABC12345');

  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
