import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-identity-runner-'));
const dbPath = join(outDir, 'assets.db');
const tsc = resolve('node_modules/.bin/tsc');
symlinkSync(resolve('node_modules'), join(outDir, 'node_modules'), 'dir');

try {
  execFileSync(tsc, [
    'src/lib/assets/asset-db.ts',
    'src/lib/identity-audit/types.ts',
    'src/lib/identity-audit/config.ts',
    'src/lib/identity-audit/org-api.ts',
    'src/lib/identity-audit/aws-collector.ts',
    'src/lib/identity-audit/repository.ts',
    'src/lib/identity-audit/audit-runner.ts',
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
    listIdentityAuditRuns,
    getLatestIdentityAuditRun,
    exportIdentityAuditFindingsCsv,
  } = require(join(outDir, 'identity-audit/repository.js'));
  const {
    runIdentityAudit,
  } = require(join(outDir, 'identity-audit/audit-runner.js'));
  const {
    fetchOrganizationPositionsForUsers,
    parseOrganizationPosition,
  } = require(join(outDir, 'identity-audit/org-api.js'));
  const {
    expandIdentityCenterAssignments,
  } = require(join(outDir, 'identity-audit/aws-collector.js'));

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

  const groupExpansion = expandIdentityCenterAssignments({
    users: [
      {
        displayName: 'billy.j',
        identityStoreUserId: 'user-1',
        userName: 'billy.j',
        email: 'billy.j@example.com',
      },
      {
        displayName: 'cloud.k',
        identityStoreUserId: 'user-2',
        userName: 'cloud.k',
        email: 'cloud.k@example.com',
      },
    ],
    groupsById: new Map([
      ['group-1', { groupId: 'group-1', displayName: 'aws-admins' }],
    ]),
    groupMembersByGroupId: new Map([
      ['group-1', ['user-1', 'user-2']],
    ]),
    permissionSetsByArn: new Map([
      ['arn:aws:sso:::permissionSet/ssoins-1/ps-1', 'AdminAccess'],
    ]),
    accountAssignments: [{
      PrincipalType: 'GROUP',
      PrincipalId: 'group-1',
      AccountId: '123456789012',
      PermissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1/ps-1',
    }],
  });
  assert.equal(groupExpansion.length, 2);
  assert.deepEqual(groupExpansion.map((assignment) => assignment.displayName), ['billy.j', 'cloud.k']);
  assert.ok(groupExpansion.every((assignment) => assignment.assignmentType === 'GROUP'));
  assert.ok(groupExpansion.every((assignment) => assignment.groupName === 'aws-admins'));

  const userExpansion = expandIdentityCenterAssignments({
    users: groupExpansion.map((assignment) => ({
      displayName: assignment.displayName,
      identityStoreUserId: assignment.identityStoreUserId,
      userName: assignment.displayName,
      email: `${assignment.displayName}@example.com`,
    })),
    groupsById: new Map(),
    groupMembersByGroupId: new Map(),
    permissionSetsByArn: new Map([
      ['arn:aws:sso:::permissionSet/ssoins-1/ps-1', 'AdminAccess'],
    ]),
    accountAssignments: [{
      PrincipalType: 'USER',
      PrincipalId: 'user-1',
      AccountId: '123456789012',
      PermissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1/ps-1',
    }],
  });
  assert.equal(userExpansion.length, 1);
  assert.equal(userExpansion[0].displayName, 'billy.j');
  assert.equal(userExpansion[0].assignmentType, 'USER');
  assert.equal(userExpansion[0].groupId, '');
  assert.equal(userExpansion[0].groupName, '');

  const unknownExpansion = expandIdentityCenterAssignments({
    users: [],
    groupsById: new Map(),
    groupMembersByGroupId: new Map([
      ['missing-group', ['missing-user']],
    ]),
    permissionSetsByArn: new Map(),
    accountAssignments: [
      {
        PrincipalType: 'USER',
        PrincipalId: 'missing-user',
        AccountId: '123456789012',
        PermissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1/ps-1',
      },
      {
        PrincipalType: 'GROUP',
        PrincipalId: 'missing-group',
        AccountId: '123456789012',
        PermissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1/ps-1',
      },
    ],
  });
  assert.deepEqual(unknownExpansion, []);

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
  assert.deepEqual(
    listIdentityAuditRuns(db, { limit: 2 }).map((run) => run.id),
    ['identity-audit-tie-a', 'identity-audit-tie-z'],
  );
  assert.equal(listIdentityAuditRuns(db, { limit: 1 }).length, 1);

  const csvInjectionRun = createIdentityAuditRun(db, '2026-07-01T01:00:00.000Z');
  db.prepare(`
    insert into identity_audit_findings (
      id, run_id, display_name, finding_type, severity, old_org_code,
      old_org_name, new_org_code, new_org_name, assignment_count, message,
      created_at
    ) values (
      'formula-finding', @runId, '=cmd', 'ORG_CHANGED_WITH_AWS_ACCESS', 'high',
      '+OLD', '-Old Org', '@NEW', '=New Org', 4, '+message',
      '2026-07-01T01:02:00.000Z'
    )
  `).run({ runId: csvInjectionRun.id });
  const csv = exportIdentityAuditFindingsCsv(db, { runId: csvInjectionRun.id });
  assert.equal(
    csv.split('\n')[0],
    'display_name,old_org_code,old_org_name,new_org_code,new_org_name,assignment_count,severity,message,created_at',
  );
  assert.ok(csv.includes("'=cmd"));
  assert.ok(csv.includes("'+OLD"));
  assert.ok(csv.includes("'-Old Org"));
  assert.ok(csv.includes("'@NEW"));

  const runnerDbPath = join(outDir, 'runner.db');
  const runnerResult = await runIdentityAudit({
    openDb: () => openAssetDb(runnerDbPath),
    now: (() => {
      const values = [
        '2026-07-02T01:00:00.000Z',
        '2026-07-02T01:01:00.000Z',
        '2026-07-02T01:02:00.000Z',
      ];
      return () => values.shift() || '2026-07-02T01:03:00.000Z';
    })(),
    resolveConfig: () => ({
      enabled: true,
      profile: 'identity-audit-profile',
      region: 'ap-northeast-2',
      endpointUrls: {},
      organizationApi: {
        baseUrl: 'https://knock-api.kakaopay.com/papi/v1/krew',
        apiKeyEnv: 'KREW_API_KEY',
        lookupField: 'displayName',
        concurrency: 1,
        timeoutMs: 1000,
        retryCount: 0,
      },
      schedule: {
        dayOfWeek: 2,
        hourKst: 10,
        timezone: 'Asia/Seoul',
      },
    }),
    getOrganizationApiKey: () => 'test-key',
    collectIdentityCenterState: async (config) => {
      assert.deepEqual(config, {
        profile: 'identity-audit-profile',
        region: 'ap-northeast-2',
        endpointUrls: {},
      });
      return {
        users: [{
          displayName: 'runner.j',
          identityStoreUserId: 'runner-user-1',
          userName: 'runner.j',
          email: 'runner.j@example.com',
        }],
        assignments: [{
          displayName: 'runner.j',
          identityStoreUserId: 'runner-user-1',
          accountId: '123456789012',
          accountName: 'common-dev',
          permissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1/ps-1',
          permissionSetName: 'AdminAccess',
          assignmentType: 'USER',
          groupId: '',
          groupName: '',
        }],
      };
    },
    fetchOrganizationPositionsForUsers: async (displayNames, config) => {
      assert.deepEqual(displayNames, ['runner.j']);
      assert.deepEqual(config, {
        baseUrl: 'https://knock-api.kakaopay.com/papi/v1/krew',
        apiKey: 'test-key',
        concurrency: 1,
        timeoutMs: 1000,
        retryCount: 0,
      });
      return new Map([[
        'runner.j',
        {
          displayName: 'runner.j',
          orgCode: 'ABC12345',
          orgName: '클라우드파트',
          raw: { data: { mainPosition: { orgCode: 'ABC12345', orgName: '클라우드파트' } } },
        },
      ]]);
    },
  });
  assert.equal(runnerResult.status, 'completed');
  assert.equal(runnerResult.summary.totalUsers, 1);
  assert.equal(runnerResult.summary.orgResolvedUsers, 1);
  const runnerDb = openAssetDb(runnerDbPath);
  assert.equal(runnerDb.prepare('select status from identity_audit_runs where id = ?').get(runnerResult.runId).status, 'completed');
  assert.equal(runnerDb.prepare('select count(*) as count from identity_users').get().count, 1);
  runnerDb.close();

  const failingDbPath = join(outDir, 'runner-failed.db');
  await assert.rejects(
    () => runIdentityAudit({
      openDb: () => openAssetDb(failingDbPath),
      now: (() => {
        const values = [
          '2026-07-03T01:00:00.000Z',
          '2026-07-03T01:02:00.000Z',
        ];
        return () => values.shift() || '2026-07-03T01:03:00.000Z';
      })(),
      resolveConfig: () => ({
        enabled: true,
        profile: 'identity-audit-profile',
        region: 'ap-northeast-2',
        endpointUrls: {},
        organizationApi: {
          baseUrl: 'https://knock-api.kakaopay.com/papi/v1/krew',
          apiKeyEnv: 'KREW_API_KEY',
          lookupField: 'displayName',
          concurrency: 1,
          timeoutMs: 1000,
          retryCount: 0,
        },
        schedule: {
          dayOfWeek: 2,
          hourKst: 10,
          timezone: 'Asia/Seoul',
        },
      }),
      getOrganizationApiKey: () => '',
      collectIdentityCenterState: async () => {
        throw new Error('collector must not run without API key');
      },
    }),
    /KREW_API_KEY/,
  );
  const failingDb = openAssetDb(failingDbPath);
  const failedRun = getLatestIdentityAuditRun(failingDb);
  assert.equal(failedRun.status, 'failed');
  assert.match(failedRun.error_message, /KREW_API_KEY/);
  failingDb.close();

  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
