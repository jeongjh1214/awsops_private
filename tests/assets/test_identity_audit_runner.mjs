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
    'src/lib/identity-audit/org-api.ts',
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
  const {
    fetchOrganizationPositionsForUsers,
    parseOrganizationPosition,
  } = require(join(outDir, 'identity-audit/org-api.js'));

  const rawBillyOrg = {
    data: {
      mainPosition: {
        orgCode: 'ABC12345',
        orgName: '클라우드파트',
      },
    },
  };
  assert.deepEqual(parseOrganizationPosition('billy.j', rawBillyOrg), {
    displayName: 'billy.j',
    orgCode: 'ABC12345',
    orgName: '클라우드파트',
    raw: rawBillyOrg,
  });

  const orgApiConfig = {
    baseUrl: 'https://knock-api.kakaopay.com/papi/v1/krew',
    apiKey: 'test-key',
    concurrency: 1,
    timeoutMs: 1000,
    retryCount: 0,
  };
  const orgResponses = {
    'billy.j': {
      data: {
        mainPosition: {
          orgCode: 'ABC12345',
          orgName: '클라우드파트',
        },
      },
    },
    'cloud.k': {
      data: {
        mainPosition: {
          orgCode: 'XYZ98765',
          orgName: '보안파트',
        },
      },
    },
  };
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const fakeFetcher = async (url, init) => {
    assert.equal(init.headers['X-API-Key'], 'test-key');
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 0));
    activeRequests -= 1;

    const displayName = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    return {
      ok: true,
      status: 200,
      async json() {
        return orgResponses[displayName];
      },
    };
  };
  const fetchedOrgs = await fetchOrganizationPositionsForUsers(
    ['billy.j', 'cloud.k'],
    orgApiConfig,
    fakeFetcher,
  );
  assert.equal(maxActiveRequests, 1);
  assert.equal(fetchedOrgs.get('billy.j').orgCode, 'ABC12345');
  assert.equal(fetchedOrgs.get('cloud.k').orgName, '보안파트');

  let retryCallCount = 0;
  const retryResult = await fetchOrganizationPositionsForUsers(
    ['billy.j'],
    { ...orgApiConfig, retryCount: 1 },
    async () => {
      retryCallCount += 1;
      if (retryCallCount === 1) {
        return {
          ok: false,
          status: 500,
          async json() {
            return { message: 'server error' };
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return rawBillyOrg;
        },
      };
    },
  );
  assert.equal(retryCallCount, 2);
  assert.equal(retryResult.get('billy.j').orgCode, 'ABC12345');

  const failedResult = await fetchOrganizationPositionsForUsers(
    ['billy.j'],
    orgApiConfig,
    async () => {
      throw new Error('network unavailable');
    },
  );
  assert.equal(failedResult.get('billy.j').orgCode, '');
  assert.equal(failedResult.get('billy.j').orgName, '');
  assert.ok(failedResult.get('billy.j').error.length > 0);

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
  const secondSnapshot = {
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
  };
  const summary = persistIdentityAuditSnapshot(db, secondSnapshot);
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

  const retrySummary = persistIdentityAuditSnapshot(db, secondSnapshot);
  assert.equal(retrySummary.changedUsers, 1);
  assert.equal(retrySummary.riskyUsers, 1);
  assert.equal(listIdentityAuditFindings(db, { runId: secondRun.id }).rows.length, 1);
  assert.equal(
    db.prepare('select count(*) as count from identity_org_change_events where run_id = ?').get(secondRun.id).count,
    1,
  );
  assert.equal(
    db.prepare('select count(*) as count from identity_aws_assignments where run_id = ?').get(secondRun.id).count,
    1,
  );
  assert.deepEqual(
    db.prepare(`
      select changed_users, risky_users
      from identity_audit_runs
      where id = ?
    `).get(secondRun.id),
    { changed_users: 1, risky_users: 1 },
  );

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

  const fourthRun = createIdentityAuditRun(db, '2026-06-29T01:00:00.000Z');
  const duplicateAssignment = {
    displayName: 'billy.j',
    identityStoreUserId: 'user-1',
    accountId: '123456789012',
    accountName: 'common-dev',
    permissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1/ps-1',
    permissionSetName: 'AdminAccess',
    assignmentType: 'USER',
    groupId: '',
    groupName: '',
  };
  const fourthSummary = persistIdentityAuditSnapshot(db, {
    runId: fourthRun.id,
    collectedAt: '2026-06-29T01:01:00.000Z',
    users: [{
      displayName: 'billy.j',
      identityStoreUserId: 'user-1',
      userName: 'billy.j',
      email: 'billy.j@example.com',
      orgCode: 'GHI13579',
      orgName: '데이터파트',
      rawOrg: { data: { mainPosition: { orgCode: 'GHI13579', orgName: '데이터파트' } } },
    }],
    assignments: [duplicateAssignment, duplicateAssignment],
  });
  completeIdentityAuditRun(db, fourthRun.id, 'completed', '2026-06-29T01:02:00.000Z');

  assert.equal(fourthSummary.changedUsers, 1);
  assert.equal(fourthSummary.riskyUsers, 1);
  const fourthFindings = listIdentityAuditFindings(db, { runId: fourthRun.id });
  assert.equal(fourthFindings.rows.length, 1);
  assert.equal(fourthFindings.rows[0].assignment_count, 1);
  assert.equal(
    db.prepare('select count(*) as count from identity_aws_assignments where run_id = ?').get(fourthRun.id).count,
    1,
  );

  db.prepare(`
    insert into identity_audit_runs (
      id, status, started_at, total_users, org_resolved_users,
      changed_users, risky_users, error_count, error_message
    ) values (
      'identity-audit-tie-z', 'running', '2026-06-30T01:00:00.000Z', 0, 0, 0, 0, 0, ''
    )
  `).run();
  db.prepare(`
    insert into identity_audit_runs (
      id, status, started_at, total_users, org_resolved_users,
      changed_users, risky_users, error_count, error_message
    ) values (
      'identity-audit-tie-a', 'running', '2026-06-30T01:00:00.000Z', 0, 0, 0, 0, 0, ''
    )
  `).run();

  assert.equal(getLatestIdentityAuditRun(db).id, 'identity-audit-tie-a');

  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
