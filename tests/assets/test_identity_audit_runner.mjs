import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-identity-runner-'));
const dbPath = join(outDir, 'assets.db');
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
    'src/lib/assets/asset-db.ts',
    'src/lib/identity-audit/types.ts',
    'src/lib/identity-audit/repository.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const { openAssetDb } = require(join(outDir, 'assets/asset-db.js'));
  const {
    createIdentityAuditRun,
    completeIdentityAuditRun,
    persistIdentityAuditSnapshot,
    listIdentityAuditFindings,
    getLatestIdentityAuditRun,
  } = require(join(outDir, 'identity-audit/repository.js'));

  const db = openAssetDb(dbPath);
  const firstRun = createIdentityAuditRun(db, '2026-06-20T01:00:00.000Z');
  persistIdentityAuditSnapshot(db, {
    runId: firstRun.id,
    collectedAt: '2026-06-20T01:01:00.000Z',
    users: [{
      displayName: 'billy.j',
      identityStoreUserId: 'user-1',
      userName: 'billy.j',
      email: 'billy.j@example.com',
      orgCode: 'ABC12345',
      orgName: '클라우드파트',
      rawOrg: { data: { mainPosition: { orgCode: 'ABC12345', orgName: '클라우드파트' } } },
    }],
    assignments: [{
      displayName: 'billy.j',
      identityStoreUserId: 'user-1',
      accountId: '123456789012',
      accountName: 'common-dev',
      permissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1/ps-1',
      permissionSetName: 'AdminAccess',
      assignmentType: 'USER',
      groupId: '',
      groupName: '',
    }],
  });
  completeIdentityAuditRun(db, firstRun.id, 'completed', '2026-06-20T01:02:00.000Z');

  const secondRun = createIdentityAuditRun(db, '2026-06-27T01:00:00.000Z');
  const summary = persistIdentityAuditSnapshot(db, {
    runId: secondRun.id,
    collectedAt: '2026-06-27T01:01:00.000Z',
    users: [{
      displayName: 'billy.j',
      identityStoreUserId: 'user-1',
      userName: 'billy.j',
      email: 'billy.j@example.com',
      orgCode: 'XYZ98765',
      orgName: '보안파트',
      rawOrg: { data: { mainPosition: { orgCode: 'XYZ98765', orgName: '보안파트' } } },
    }],
    assignments: [{
      displayName: 'billy.j',
      identityStoreUserId: 'user-1',
      accountId: '123456789012',
      accountName: 'common-dev',
      permissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1/ps-1',
      permissionSetName: 'AdminAccess',
      assignmentType: 'USER',
      groupId: '',
      groupName: '',
    }],
  });
  completeIdentityAuditRun(db, secondRun.id, 'completed', '2026-06-27T01:02:00.000Z');

  assert.equal(summary.changedUsers, 1);
  assert.equal(summary.riskyUsers, 1);

  const findings = listIdentityAuditFindings(db, { runId: secondRun.id });
  assert.equal(findings.rows.length, 1);
  assert.equal(findings.rows[0].display_name, 'billy.j');
  assert.equal(findings.rows[0].old_org_code, 'ABC12345');
  assert.equal(findings.rows[0].new_org_code, 'XYZ98765');
  assert.equal(findings.rows[0].assignment_count, 1);
  assert.equal(getLatestIdentityAuditRun(db).id, secondRun.id);

  const thirdRun = createIdentityAuditRun(db, '2026-06-28T01:00:00.000Z');
  const thirdSummary = persistIdentityAuditSnapshot(db, {
    runId: thirdRun.id,
    collectedAt: '2026-06-28T01:01:00.000Z',
    users: [{
      displayName: 'billy.j',
      identityStoreUserId: 'user-1',
      userName: 'billy.j',
      email: 'billy.j@example.com',
      orgCode: 'DEF24680',
      orgName: '플랫폼파트',
      rawOrg: { data: { mainPosition: { orgCode: 'DEF24680', orgName: '플랫폼파트' } } },
    }],
    assignments: [],
  });
  completeIdentityAuditRun(db, thirdRun.id, 'completed', '2026-06-28T01:02:00.000Z');

  assert.equal(thirdSummary.changedUsers, 1);
  assert.equal(thirdSummary.riskyUsers, 0);
  assert.equal(listIdentityAuditFindings(db, { runId: thirdRun.id }).rows.length, 0);

  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
