# Identity Center Org Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an internal IAM Identity Center audit feature that detects organization changes from knock API data and flags users who still have AWS access after moving departments.

**Architecture:** Store audit runs, user org snapshots, expanded AWS assignments, and findings in the existing `data/awsops.db` SQLite database. Use AWS SDK read-only clients with a dedicated `identityAudit.awsProfile`, enrich Identity Center `DisplayName` through the knock API, and expose saved results through a Next.js API route, UI page, and AI context.

**Tech Stack:** Next.js App Router, TypeScript, better-sqlite3, AWS SDK v3, React, lucide-react, Node test scripts.

---

## File Structure

- Modify `package.json` and `package-lock.json`
  - Add `@aws-sdk/client-identitystore` and `@aws-sdk/client-sso-admin`.
- Modify `src/lib/app-config.ts`
  - Add `IdentityAuditConfig` and helper defaults.
  - Add `identityCenterProfile` to environment config.
- Modify `docs/examples/config.vm-private.example.json`
  - Add local/dev/prod identity center profile examples.
  - Add `identityAudit` config with `KREW_API_KEY` env reference.
- Modify `src/lib/assets/asset-db.ts`
  - Add identity audit tables and indexes.
- Create `src/lib/identity-audit/types.ts`
  - Shared types for config, users, assignments, runs, findings, and dependencies.
- Create `src/lib/identity-audit/config.ts`
  - Resolve active identity audit config, profile, region, endpoint URLs, and organization API settings.
- Create `src/lib/identity-audit/org-api.ts`
  - Fetch `mainPosition.orgCode/orgName` by DisplayName with timeout, retry, API key env, and concurrency helper.
- Create `src/lib/identity-audit/aws-collector.ts`
  - Read IAM Identity Center users, groups, memberships, permission sets, and assignments with AWS SDK.
- Create `src/lib/identity-audit/repository.ts`
  - Persist runs, snapshots, users, assignments, change events, findings, list summaries, and export CSV.
- Create `src/lib/identity-audit/audit-runner.ts`
  - Orchestrate one audit run with an in-process lock.
- Create `src/lib/identity-audit/scheduler.ts`
  - KST Tuesday 10 scheduler using the same simple in-process style as report scheduler.
- Create `src/app/api/identity-audit/route.ts`
  - GET summaries/findings/export and POST manual run.
- Create `src/app/identity-audit/page.tsx`
  - Internal dashboard for latest run, manual execution, finding list, and user detail drawer.
- Modify `src/components/layout/Sidebar.tsx`
  - Add `Identity 감사` under Security.
- Modify `src/lib/i18n/translations/ko.json` and `src/lib/i18n/translations/en.json`
  - Add sidebar labels.
- Modify `src/lib/assets/asset-ai.ts` and `src/app/api/ai/route.ts`
  - Add saved identity audit context for questions about department moves and remaining AWS access.
- Create `tests/assets/test_identity_audit_db.mjs`
  - DB migration and repository tests.
- Create `tests/assets/test_identity_audit_runner.mjs`
  - Org change comparison, assignment expansion, and finding tests.
- Create `tests/assets/test_identity_audit_config.mjs`
  - Profile resolution, endpoint URL, env key validation, and config defaults.
- Modify `tests/assets/test_asset_ai.mjs`
  - AI context detection for identity audit questions.

---

### Task 1: Add Dependencies And Config Shape

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/lib/app-config.ts`
- Modify: `docs/examples/config.vm-private.example.json`
- Test: `tests/assets/test_identity_audit_config.mjs`

- [ ] **Step 1: Install AWS SDK clients**

Run:

```bash
npm install @aws-sdk/client-identitystore@^3.1030.0 @aws-sdk/client-sso-admin@^3.1030.0
```

Expected:

```text
package.json and package-lock.json include both new AWS SDK client packages.
```

- [ ] **Step 2: Write the failing config test**

Create `tests/assets/test_identity_audit_config.mjs`:

```javascript
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-identity-config-'));
const projectDir = process.cwd();
const dataDir = join(projectDir, 'data');
const configPath = join(dataDir, 'config.json');
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
    'src/lib/app-config.ts',
    'src/lib/identity-audit/config.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    activeEnvironment: 'local',
    environments: {
      local: {
        networkMode: 'external-explicit-vpce',
        endpointMode: 'explicit',
        bedrockProfile: 'bedrock-profile',
        awsProfile: 'asset-profile',
        identityCenterProfile: 'identity-env-profile',
        endpointUrls: {
          'identitystore': 'https://vpce-identitystore.example',
          'sso-admin': 'https://vpce-sso-admin.example',
          'sts': 'https://vpce-sts.example'
        }
      }
    },
    identityAudit: {
      enabled: true,
      awsProfile: 'identity-audit-profile',
      region: 'ap-northeast-2',
      organizationApi: {
        baseUrl: 'https://knock-api.kakaopay.com/papi/v1/krew',
        apiKeyEnv: 'KREW_API_KEY',
        lookupField: 'displayName',
        concurrency: 7,
        timeoutMs: 3000,
        retryCount: 1
      }
    }
  }), 'utf8');

  const require = createRequire(import.meta.url);
  const { resolveIdentityAuditConfig } = require(join(outDir, 'identity-audit/config.js'));
  const resolved = resolveIdentityAuditConfig();

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.profile, 'identity-audit-profile');
  assert.equal(resolved.region, 'ap-northeast-2');
  assert.equal(resolved.endpointUrls.identitystore, 'https://vpce-identitystore.example');
  assert.equal(resolved.organizationApi.apiKeyEnv, 'KREW_API_KEY');
  assert.equal(resolved.organizationApi.concurrency, 7);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
node tests/assets/test_identity_audit_config.mjs
```

Expected:

```text
FAIL: src/lib/identity-audit/config.ts does not exist
```

- [ ] **Step 4: Implement config types and resolver**

Modify `src/lib/app-config.ts`:

```typescript
export interface PrivateEnvironmentConfig {
  networkMode: NetworkMode;
  endpointMode: EndpointMode;
  bedrockProfile: string;
  endpointUrls?: Record<string, string>;
  requiredEndpoints?: string[];
  awsProfile?: string;
  identityCenterProfile?: string;
}

export interface IdentityAuditOrganizationApiConfig {
  baseUrl: string;
  apiKeyEnv: string;
  lookupField: 'displayName';
  concurrency: number;
  timeoutMs: number;
  retryCount: number;
}

export interface IdentityAuditScheduleConfig {
  dayOfWeek: number;
  hour: number;
  timezone: string;
}

export interface IdentityAuditConfig {
  enabled: boolean;
  awsProfile?: string;
  region: string;
  schedule: IdentityAuditScheduleConfig;
  organizationApi: IdentityAuditOrganizationApiConfig;
}

export const DEFAULT_IDENTITY_AUDIT_CONFIG: IdentityAuditConfig = {
  enabled: false,
  region: 'ap-northeast-2',
  schedule: {
    dayOfWeek: 2,
    hour: 10,
    timezone: 'Asia/Seoul',
  },
  organizationApi: {
    baseUrl: 'https://knock-api.kakaopay.com/papi/v1/krew',
    apiKeyEnv: 'KREW_API_KEY',
    lookupField: 'displayName',
    concurrency: 10,
    timeoutMs: 5000,
    retryCount: 2,
  },
};
```

Also add `identityAudit?: IdentityAuditConfig;` to `AppConfig`, and add `identityAudit: DEFAULT_IDENTITY_AUDIT_CONFIG` to `DEFAULT_CONFIG`.

Create `src/lib/identity-audit/config.ts`:

```typescript
import { DEFAULT_IDENTITY_AUDIT_CONFIG, getConfig, type IdentityAuditConfig } from '../app-config';

export interface ResolvedIdentityAuditConfig extends IdentityAuditConfig {
  profile?: string;
  endpointUrls: Record<string, string>;
}

export function resolveIdentityAuditConfig(): ResolvedIdentityAuditConfig {
  const config = getConfig();
  const activeEnvironment = config.activeEnvironment || 'dev';
  const environment = config.environments?.[activeEnvironment];
  const identityAudit = {
    ...DEFAULT_IDENTITY_AUDIT_CONFIG,
    ...(config.identityAudit || {}),
    organizationApi: {
      ...DEFAULT_IDENTITY_AUDIT_CONFIG.organizationApi,
      ...(config.identityAudit?.organizationApi || {}),
    },
    schedule: {
      ...DEFAULT_IDENTITY_AUDIT_CONFIG.schedule,
      ...(config.identityAudit?.schedule || {}),
    },
  };

  return {
    ...identityAudit,
    profile: identityAudit.awsProfile || environment?.identityCenterProfile || environment?.awsProfile,
    endpointUrls: environment?.endpointUrls || {},
  };
}
```

- [ ] **Step 5: Update example config**

Add to each environment in `docs/examples/config.vm-private.example.json`:

```json
"identityCenterProfile": "identity-center-local-profile"
```

Add top-level config:

```json
"identityAudit": {
  "enabled": true,
  "awsProfile": "identity-center-audit-profile",
  "region": "ap-northeast-2",
  "schedule": {
    "dayOfWeek": 2,
    "hour": 10,
    "timezone": "Asia/Seoul"
  },
  "organizationApi": {
    "baseUrl": "https://knock-api.kakaopay.com/papi/v1/krew",
    "apiKeyEnv": "KREW_API_KEY",
    "lookupField": "displayName",
    "concurrency": 10,
    "timeoutMs": 5000,
    "retryCount": 2
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
node tests/assets/test_identity_audit_config.mjs
```

Expected:

```text
PASS with no output
```

- [ ] **Step 7: Commit**

Run:

```bash
git add package.json package-lock.json src/lib/app-config.ts src/lib/identity-audit/config.ts docs/examples/config.vm-private.example.json tests/assets/test_identity_audit_config.mjs
git commit -m "Add identity audit config"
```

---

### Task 2: Add Identity Audit Tables

**Files:**
- Modify: `src/lib/assets/asset-db.ts`
- Test: `tests/assets/test_identity_audit_db.mjs`

- [ ] **Step 1: Write the failing DB migration test**

Create `tests/assets/test_identity_audit_db.mjs`:

```javascript
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-identity-db-'));
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

  for (const table of [
    'identity_audit_runs',
    'identity_users',
    'identity_org_snapshots',
    'identity_org_change_events',
    'identity_aws_assignments',
    'identity_audit_findings',
  ]) {
    assert.equal(
      db.prepare("select name from sqlite_master where type='table' and name = ?").get(table).name,
      table,
    );
  }

  db.prepare(`
    insert into identity_audit_runs (
      id, status, started_at, total_users, org_resolved_users, changed_users,
      risky_users, error_count, error_message
    ) values (
      'run-1', 'running', '2026-06-27T01:00:00.000Z', 0, 0, 0, 0, 0, ''
    )
  `).run();

  db.prepare(`
    insert into identity_users (
      display_name, identity_store_user_id, user_name, email, current_org_code,
      current_org_name, current_assignment_count, is_active, first_seen_at,
      last_seen_at, updated_at
    ) values (
      'billy.j', 'user-1', 'billy.j', 'billy.j@example.com', 'ABC12345',
      '클라우드파트', 2, 1, '2026-06-27T01:00:00.000Z',
      '2026-06-27T01:00:00.000Z', '2026-06-27T01:00:00.000Z'
    )
  `).run();

  const row = db.prepare('select current_org_code from identity_users where display_name = ?').get('billy.j');
  assert.equal(row.current_org_code, 'ABC12345');
  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/assets/test_identity_audit_db.mjs
```

Expected:

```text
FAIL because identity_audit_runs table is missing
```

- [ ] **Step 3: Add tables and indexes**

Modify `migrateAssetDb` in `src/lib/assets/asset-db.ts` to append these table definitions inside the existing `db.exec` block:

```sql
create table if not exists identity_audit_runs (
  id text primary key,
  status text not null,
  started_at text not null,
  finished_at text,
  total_users integer not null default 0,
  org_resolved_users integer not null default 0,
  changed_users integer not null default 0,
  risky_users integer not null default 0,
  error_count integer not null default 0,
  error_message text not null default ''
);

create table if not exists identity_users (
  display_name text primary key,
  identity_store_user_id text not null default '',
  user_name text not null default '',
  email text not null default '',
  current_org_code text not null default '',
  current_org_name text not null default '',
  current_assignment_count integer not null default 0,
  is_active integer not null default 1,
  first_seen_at text not null,
  last_seen_at text not null,
  updated_at text not null
);

create table if not exists identity_org_snapshots (
  id text primary key,
  run_id text not null references identity_audit_runs(id) on delete cascade,
  display_name text not null,
  org_code text not null default '',
  org_name text not null default '',
  raw_json text not null default '{}',
  collected_at text not null
);

create table if not exists identity_org_change_events (
  id text primary key,
  run_id text not null references identity_audit_runs(id) on delete cascade,
  display_name text not null,
  old_org_code text not null default '',
  old_org_name text not null default '',
  new_org_code text not null default '',
  new_org_name text not null default '',
  detected_at text not null
);

create table if not exists identity_aws_assignments (
  id text primary key,
  run_id text not null references identity_audit_runs(id) on delete cascade,
  display_name text not null,
  identity_store_user_id text not null default '',
  account_id text not null,
  account_name text not null default '',
  permission_set_arn text not null,
  permission_set_name text not null default '',
  assignment_type text not null,
  group_id text not null default '',
  group_name text not null default '',
  collected_at text not null
);

create table if not exists identity_audit_findings (
  id text primary key,
  run_id text not null references identity_audit_runs(id) on delete cascade,
  display_name text not null,
  finding_type text not null,
  severity text not null,
  old_org_code text not null default '',
  old_org_name text not null default '',
  new_org_code text not null default '',
  new_org_name text not null default '',
  assignment_count integer not null default 0,
  message text not null,
  created_at text not null
);
```

Add indexes in the second `db.exec` block:

```sql
create index if not exists idx_identity_users_org on identity_users(current_org_code, is_active);
create index if not exists idx_identity_snapshots_run on identity_org_snapshots(run_id, display_name);
create index if not exists idx_identity_changes_run on identity_org_change_events(run_id, display_name);
create index if not exists idx_identity_assignments_run_user on identity_aws_assignments(run_id, display_name);
create index if not exists idx_identity_findings_run on identity_audit_findings(run_id, severity);
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node tests/assets/test_identity_audit_db.mjs
```

Expected:

```text
PASS with no output
```

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/assets/asset-db.ts tests/assets/test_identity_audit_db.mjs
git commit -m "Add identity audit database tables"
```

---

### Task 3: Implement Repository And Change Detection

**Files:**
- Create: `src/lib/identity-audit/types.ts`
- Create: `src/lib/identity-audit/repository.ts`
- Test: `tests/assets/test_identity_audit_runner.mjs`

- [ ] **Step 1: Write the failing repository test**

Create `tests/assets/test_identity_audit_runner.mjs` with the repository portion first:

```javascript
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
  const { openAssetDb } = require(join(outDir, 'asset-db.js'));
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

  db.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/assets/test_identity_audit_runner.mjs
```

Expected:

```text
FAIL because src/lib/identity-audit/types.ts does not exist
```

- [ ] **Step 3: Add shared types**

Create `src/lib/identity-audit/types.ts`:

```typescript
export interface IdentityAuditUserInput {
  displayName: string;
  identityStoreUserId: string;
  userName: string;
  email: string;
  orgCode: string;
  orgName: string;
  rawOrg: unknown;
}

export interface IdentityAuditAssignmentInput {
  displayName: string;
  identityStoreUserId: string;
  accountId: string;
  accountName: string;
  permissionSetArn: string;
  permissionSetName: string;
  assignmentType: 'USER' | 'GROUP';
  groupId: string;
  groupName: string;
}

export interface PersistIdentityAuditSnapshotInput {
  runId: string;
  collectedAt: string;
  users: IdentityAuditUserInput[];
  assignments: IdentityAuditAssignmentInput[];
}

export interface IdentityAuditPersistSummary {
  totalUsers: number;
  orgResolvedUsers: number;
  changedUsers: number;
  riskyUsers: number;
  errorCount: number;
}
```

- [ ] **Step 4: Implement repository functions**

Create `src/lib/identity-audit/repository.ts`:

```typescript
import crypto from 'crypto';
import type { AssetDb } from '../assets/asset-db';
import type {
  IdentityAuditAssignmentInput,
  IdentityAuditPersistSummary,
  IdentityAuditUserInput,
  PersistIdentityAuditSnapshotInput,
} from './types';

export function createIdentityAuditRun(db: AssetDb, startedAt = new Date().toISOString()): { id: string } {
  const id = `identity-audit-${startedAt.replace(/[^0-9]/g, '')}-${crypto.randomUUID()}`;
  db.prepare(`
    insert into identity_audit_runs (
      id, status, started_at, total_users, org_resolved_users, changed_users,
      risky_users, error_count, error_message
    ) values (
      @id, 'running', @startedAt, 0, 0, 0, 0, 0, ''
    )
  `).run({ id, startedAt });
  return { id };
}

export function completeIdentityAuditRun(
  db: AssetDb,
  runId: string,
  status: 'completed' | 'failed',
  finishedAt = new Date().toISOString(),
  errorMessage = '',
): void {
  db.prepare(`
    update identity_audit_runs
    set status = @status, finished_at = @finishedAt, error_message = @errorMessage
    where id = @runId
  `).run({ runId, status, finishedAt, errorMessage });
}

export function persistIdentityAuditSnapshot(
  db: AssetDb,
  input: PersistIdentityAuditSnapshotInput,
): IdentityAuditPersistSummary {
  return db.transaction(() => {
    db.prepare('delete from identity_aws_assignments where run_id = ?').run(input.runId);
    db.prepare('delete from identity_audit_findings where run_id = ?').run(input.runId);

    const snapshotInsert = db.prepare(`
      insert into identity_org_snapshots (
        id, run_id, display_name, org_code, org_name, raw_json, collected_at
      ) values (
        @id, @runId, @displayName, @orgCode, @orgName, @rawJson, @collectedAt
      )
    `);
    const assignmentInsert = db.prepare(`
      insert into identity_aws_assignments (
        id, run_id, display_name, identity_store_user_id, account_id, account_name,
        permission_set_arn, permission_set_name, assignment_type, group_id,
        group_name, collected_at
      ) values (
        @id, @runId, @displayName, @identityStoreUserId, @accountId, @accountName,
        @permissionSetArn, @permissionSetName, @assignmentType, @groupId,
        @groupName, @collectedAt
      )
    `);
    const userUpsert = db.prepare(`
      insert into identity_users (
        display_name, identity_store_user_id, user_name, email, current_org_code,
        current_org_name, current_assignment_count, is_active, first_seen_at,
        last_seen_at, updated_at
      ) values (
        @displayName, @identityStoreUserId, @userName, @email, @orgCode,
        @orgName, @assignmentCount, 1, @collectedAt, @collectedAt, @collectedAt
      )
      on conflict(display_name) do update set
        identity_store_user_id = excluded.identity_store_user_id,
        user_name = excluded.user_name,
        email = excluded.email,
        current_org_code = excluded.current_org_code,
        current_org_name = excluded.current_org_name,
        current_assignment_count = excluded.current_assignment_count,
        is_active = 1,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `);
    const changeInsert = db.prepare(`
      insert into identity_org_change_events (
        id, run_id, display_name, old_org_code, old_org_name,
        new_org_code, new_org_name, detected_at
      ) values (
        @id, @runId, @displayName, @oldOrgCode, @oldOrgName,
        @newOrgCode, @newOrgName, @detectedAt
      )
    `);
    const findingInsert = db.prepare(`
      insert into identity_audit_findings (
        id, run_id, display_name, finding_type, severity, old_org_code,
        old_org_name, new_org_code, new_org_name, assignment_count, message,
        created_at
      ) values (
        @id, @runId, @displayName, 'ORG_CHANGED_WITH_AWS_ACCESS', @severity,
        @oldOrgCode, @oldOrgName, @newOrgCode, @newOrgName, @assignmentCount,
        @message, @createdAt
      )
    `);

    const assignmentCounts = countAssignmentsByDisplayName(input.assignments);
    let changedUsers = 0;
    let riskyUsers = 0;

    for (const assignment of input.assignments) {
      assignmentInsert.run({
        id: stableId('assignment', input.runId, assignment.displayName, assignment.accountId, assignment.permissionSetArn, assignment.assignmentType, assignment.groupId),
        runId: input.runId,
        ...assignment,
        collectedAt: input.collectedAt,
      });
    }

    for (const user of input.users) {
      const previous = db.prepare('select current_org_code, current_org_name from identity_users where display_name = ?')
        .get(user.displayName) as { current_org_code: string; current_org_name: string } | undefined;
      const assignmentCount = assignmentCounts.get(user.displayName) || 0;

      snapshotInsert.run({
        id: stableId('snapshot', input.runId, user.displayName),
        runId: input.runId,
        displayName: user.displayName,
        orgCode: user.orgCode,
        orgName: user.orgName,
        rawJson: JSON.stringify(user.rawOrg || {}),
        collectedAt: input.collectedAt,
      });

      const changed = Boolean(previous?.current_org_code)
        && previous.current_org_code !== user.orgCode
        && Boolean(user.orgCode);

      userUpsert.run({
        ...user,
        assignmentCount,
        collectedAt: input.collectedAt,
      });

      if (changed) {
        changedUsers += 1;
        changeInsert.run({
          id: stableId('change', input.runId, user.displayName, previous.current_org_code, user.orgCode),
          runId: input.runId,
          displayName: user.displayName,
          oldOrgCode: previous.current_org_code,
          oldOrgName: previous.current_org_name,
          newOrgCode: user.orgCode,
          newOrgName: user.orgName,
          detectedAt: input.collectedAt,
        });

        if (assignmentCount > 0) {
          riskyUsers += 1;
          findingInsert.run({
            id: stableId('finding', input.runId, user.displayName),
            runId: input.runId,
            displayName: user.displayName,
            severity: assignmentCount >= 3 ? 'high' : 'medium',
            oldOrgCode: previous.current_org_code,
            oldOrgName: previous.current_org_name,
            newOrgCode: user.orgCode,
            newOrgName: user.orgName,
            assignmentCount,
            message: `${user.displayName} moved from ${previous.current_org_name || previous.current_org_code} to ${user.orgName || user.orgCode} and still has ${assignmentCount} AWS assignment(s).`,
            createdAt: input.collectedAt,
          });
        }
      }
    }

    const summary = {
      totalUsers: input.users.length,
      orgResolvedUsers: input.users.filter((user) => user.orgCode).length,
      changedUsers,
      riskyUsers,
      errorCount: 0,
    };

    db.prepare(`
      update identity_audit_runs
      set total_users = @totalUsers, org_resolved_users = @orgResolvedUsers,
        changed_users = @changedUsers, risky_users = @riskyUsers, error_count = @errorCount
      where id = @runId
    `).run({ ...summary, runId: input.runId });

    return summary;
  })();
}

export function getLatestIdentityAuditRun(db: AssetDb): Record<string, unknown> | undefined {
  return db.prepare('select * from identity_audit_runs order by started_at desc limit 1').get() as Record<string, unknown> | undefined;
}

export function listIdentityAuditFindings(db: AssetDb, filters: { runId?: string; limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(filters.limit || 100, 1), 500);
  const offset = Math.max(filters.offset || 0, 0);
  const where = filters.runId ? 'where run_id = @runId' : '';
  return {
    rows: db.prepare(`select * from identity_audit_findings ${where} order by created_at desc limit @limit offset @offset`)
      .all({ runId: filters.runId, limit, offset }),
  };
}

function countAssignmentsByDisplayName(assignments: IdentityAuditAssignmentInput[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    counts.set(assignment.displayName, (counts.get(assignment.displayName) || 0) + 1);
  }
  return counts;
}

function stableId(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node tests/assets/test_identity_audit_runner.mjs
```

Expected:

```text
PASS with no output
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/lib/identity-audit/types.ts src/lib/identity-audit/repository.ts tests/assets/test_identity_audit_runner.mjs
git commit -m "Add identity audit repository"
```

---

### Task 4: Implement Organization API Client

**Files:**
- Create: `src/lib/identity-audit/org-api.ts`
- Modify: `tests/assets/test_identity_audit_runner.mjs`

- [ ] **Step 1: Extend the runner test with org API behavior**

Append this block to `tests/assets/test_identity_audit_runner.mjs` before `db.close()`:

```javascript
const { fetchOrganizationPositionsForUsers } = require(join(outDir, 'identity-audit/org-api.js'));
let activeRequests = 0;
let maxActiveRequests = 0;
const orgResults = await fetchOrganizationPositionsForUsers(
  ['billy.j', 'cloud.k'],
  {
    baseUrl: 'https://knock-api.kakaopay.com/papi/v1/krew',
    apiKey: 'test-key',
    concurrency: 1,
    timeoutMs: 1000,
    retryCount: 0,
  },
  async (url, init) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    assert.equal(init.headers['X-API-Key'], 'test-key');
    activeRequests -= 1;
    const accountId = String(url).split('/').pop();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          mainPosition: {
            orgCode: accountId === 'billy.j' ? 'ABC12345' : 'XYZ98765',
            orgName: accountId === 'billy.j' ? '클라우드파트' : '보안파트',
          },
        },
      }),
    };
  },
);
assert.equal(maxActiveRequests, 1);
assert.equal(orgResults.get('billy.j').orgCode, 'ABC12345');
assert.equal(orgResults.get('cloud.k').orgName, '보안파트');
```

Also add `src/lib/identity-audit/org-api.ts` to the `tsc` input list.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/assets/test_identity_audit_runner.mjs
```

Expected:

```text
FAIL because org-api.ts does not exist
```

- [ ] **Step 3: Implement org API client**

Create `src/lib/identity-audit/org-api.ts`:

```typescript
export interface OrganizationApiRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  concurrency: number;
  timeoutMs: number;
  retryCount: number;
}

export interface OrganizationPosition {
  displayName: string;
  orgCode: string;
  orgName: string;
  raw: unknown;
  error?: string;
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export async function fetchOrganizationPositionsForUsers(
  displayNames: string[],
  config: OrganizationApiRuntimeConfig,
  fetcher: FetchLike = fetch as FetchLike,
): Promise<Map<string, OrganizationPosition>> {
  const results = new Map<string, OrganizationPosition>();
  await mapWithConcurrency(displayNames, Math.max(1, config.concurrency), async (displayName) => {
    results.set(displayName, await fetchOrganizationPosition(displayName, config, fetcher));
  });
  return results;
}

async function fetchOrganizationPosition(
  displayName: string,
  config: OrganizationApiRuntimeConfig,
  fetcher: FetchLike,
): Promise<OrganizationPosition> {
  let lastError = '';
  for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : undefined;
    try {
      const response = await fetcher(`${config.baseUrl.replace(/\/$/, '')}/${encodeURIComponent(displayName)}`, {
        headers: { 'X-API-Key': config.apiKey },
        signal: controller?.signal,
      });
      if (!response.ok) throw new Error(`organization API returned HTTP ${response.status}`);
      const raw = await response.json();
      const position = parseOrganizationPosition(displayName, raw);
      return position;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { displayName, orgCode: '', orgName: '', raw: {}, error: lastError || 'organization API failed' };
}

export function parseOrganizationPosition(displayName: string, raw: unknown): OrganizationPosition {
  const root = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {};
  const mainPosition = data.mainPosition && typeof data.mainPosition === 'object'
    ? data.mainPosition as Record<string, unknown>
    : {};
  return {
    displayName,
    orgCode: typeof mainPosition.orgCode === 'string' ? mainPosition.orgCode : '',
    orgName: typeof mainPosition.orgName === 'string' ? mainPosition.orgName : '',
    raw,
  };
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await mapper(values[currentIndex]);
    }
  });
  await Promise.all(workers);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node tests/assets/test_identity_audit_runner.mjs
```

Expected:

```text
PASS with no output
```

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/identity-audit/org-api.ts tests/assets/test_identity_audit_runner.mjs
git commit -m "Add identity organization API client"
```

---

### Task 5: Implement AWS Identity Center Collector

**Files:**
- Create: `src/lib/identity-audit/aws-collector.ts`
- Modify: `src/lib/identity-audit/types.ts`
- Modify: `tests/assets/test_identity_audit_runner.mjs`

- [ ] **Step 1: Extend types**

Add to `src/lib/identity-audit/types.ts`:

```typescript
export interface CollectedIdentityUser {
  displayName: string;
  identityStoreUserId: string;
  userName: string;
  email: string;
}

export interface CollectedIdentityAssignment {
  displayName: string;
  identityStoreUserId: string;
  accountId: string;
  accountName: string;
  permissionSetArn: string;
  permissionSetName: string;
  assignmentType: 'USER' | 'GROUP';
  groupId: string;
  groupName: string;
}

export interface CollectedIdentityCenterState {
  users: CollectedIdentityUser[];
  assignments: CollectedIdentityAssignment[];
}
```

- [ ] **Step 2: Write collector unit test with mocked dependencies**

Append to `tests/assets/test_identity_audit_runner.mjs`:

```javascript
const { expandIdentityCenterAssignments } = require(join(outDir, 'identity-audit/aws-collector.js'));
const expanded = expandIdentityCenterAssignments({
  users: [
    { displayName: 'billy.j', identityStoreUserId: 'user-1', userName: 'billy.j', email: 'billy.j@example.com' },
    { displayName: 'cloud.k', identityStoreUserId: 'user-2', userName: 'cloud.k', email: 'cloud.k@example.com' },
  ],
  groupsById: new Map([['group-1', { groupId: 'group-1', displayName: 'aws-admins' }]]),
  groupMembersByGroupId: new Map([['group-1', ['user-1', 'user-2']]]),
  permissionSetsByArn: new Map([['arn:aws:sso:::permissionSet/ssoins-1/ps-1', 'AdminAccess']]),
  accountAssignments: [
    {
      accountId: '123456789012',
      permissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1/ps-1',
      principalType: 'GROUP',
      principalId: 'group-1',
    },
  ],
});
assert.equal(expanded.length, 2);
assert.deepEqual(expanded.map((row) => row.displayName).sort(), ['billy.j', 'cloud.k']);
assert.equal(expanded[0].assignmentType, 'GROUP');
assert.equal(expanded[0].groupName, 'aws-admins');
```

Also add `src/lib/identity-audit/aws-collector.ts` to the `tsc` input list.

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
node tests/assets/test_identity_audit_runner.mjs
```

Expected:

```text
FAIL because aws-collector.ts does not exist
```

- [ ] **Step 4: Implement assignment expansion and SDK collector shell**

Create `src/lib/identity-audit/aws-collector.ts`:

```typescript
import {
  DescribePermissionSetCommand,
  ListAccountAssignmentsCommand,
  ListAccountsForProvisionedPermissionSetCommand,
  ListInstancesCommand,
  ListPermissionSetsCommand,
  SSOAdminClient,
} from '@aws-sdk/client-sso-admin';
import {
  DescribeGroupCommand,
  IdentitystoreClient,
  ListGroupMembershipsCommand,
  ListGroupsCommand,
  ListUsersCommand,
} from '@aws-sdk/client-identitystore';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import type {
  CollectedIdentityAssignment,
  CollectedIdentityCenterState,
  CollectedIdentityUser,
} from './types';

export interface IdentityCenterCollectorConfig {
  profile?: string;
  region: string;
  endpointUrls: Record<string, string>;
}

interface ExpandedAssignmentState {
  users: CollectedIdentityUser[];
  groupsById: Map<string, { groupId: string; displayName: string }>;
  groupMembersByGroupId: Map<string, string[]>;
  permissionSetsByArn: Map<string, string>;
  accountAssignments: Array<{
    accountId: string;
    permissionSetArn: string;
    principalType: 'USER' | 'GROUP' | string;
    principalId: string;
  }>;
}

export function createIdentityStoreClient(config: IdentityCenterCollectorConfig): IdentitystoreClient {
  return new IdentitystoreClient({
    region: config.region,
    endpoint: config.endpointUrls.identitystore,
    credentials: config.profile ? fromIni({ profile: config.profile }) : undefined,
  });
}

export function createSsoAdminClient(config: IdentityCenterCollectorConfig): SSOAdminClient {
  return new SSOAdminClient({
    region: config.region,
    endpoint: config.endpointUrls['sso-admin'] || config.endpointUrls.sso,
    credentials: config.profile ? fromIni({ profile: config.profile }) : undefined,
  });
}

export async function collectIdentityCenterState(config: IdentityCenterCollectorConfig): Promise<CollectedIdentityCenterState> {
  const identitystore = createIdentityStoreClient(config);
  const ssoAdmin = createSsoAdminClient(config);
  const instances = await ssoAdmin.send(new ListInstancesCommand({}));
  const instance = instances.Instances?.[0];
  if (!instance?.IdentityStoreId || !instance.InstanceArn) {
    throw new Error('IAM Identity Center instance was not found');
  }

  const identityStoreId = instance.IdentityStoreId;
  const users = await listUsers(identitystore, identityStoreId);
  const groupsById = await listGroups(identitystore, identityStoreId);
  const groupMembersByGroupId = await listGroupMemberships(identitystore, identityStoreId, [...groupsById.keys()]);
  const permissionSetsByArn = await listPermissionSets(ssoAdmin, instance.InstanceArn);
  const accountAssignments = await listAccountAssignments(ssoAdmin, instance.InstanceArn, [...permissionSetsByArn.keys()]);

  return {
    users,
    assignments: expandIdentityCenterAssignments({
      users,
      groupsById,
      groupMembersByGroupId,
      permissionSetsByArn,
      accountAssignments,
    }),
  };
}

export function expandIdentityCenterAssignments(state: ExpandedAssignmentState): CollectedIdentityAssignment[] {
  const usersById = new Map(state.users.map((user) => [user.identityStoreUserId, user]));
  const rows: CollectedIdentityAssignment[] = [];

  for (const assignment of state.accountAssignments) {
    if (assignment.principalType === 'USER') {
      const user = usersById.get(assignment.principalId);
      if (!user) continue;
      rows.push(toAssignment(user, assignment, 'USER', '', '', state.permissionSetsByArn));
      continue;
    }

    if (assignment.principalType === 'GROUP') {
      const group = state.groupsById.get(assignment.principalId);
      const memberIds = state.groupMembersByGroupId.get(assignment.principalId) || [];
      for (const memberId of memberIds) {
        const user = usersById.get(memberId);
        if (!user) continue;
        rows.push(toAssignment(user, assignment, 'GROUP', group?.groupId || assignment.principalId, group?.displayName || '', state.permissionSetsByArn));
      }
    }
  }

  return rows;
}

function toAssignment(
  user: CollectedIdentityUser,
  assignment: ExpandedAssignmentState['accountAssignments'][number],
  assignmentType: 'USER' | 'GROUP',
  groupId: string,
  groupName: string,
  permissionSetsByArn: Map<string, string>,
): CollectedIdentityAssignment {
  return {
    displayName: user.displayName,
    identityStoreUserId: user.identityStoreUserId,
    accountId: assignment.accountId,
    accountName: '',
    permissionSetArn: assignment.permissionSetArn,
    permissionSetName: permissionSetsByArn.get(assignment.permissionSetArn) || '',
    assignmentType,
    groupId,
    groupName,
  };
}

async function listUsers(client: IdentitystoreClient, identityStoreId: string): Promise<CollectedIdentityUser[]> {
  const users: CollectedIdentityUser[] = [];
  let nextToken: string | undefined;
  do {
    const response = await client.send(new ListUsersCommand({ IdentityStoreId: identityStoreId, NextToken: nextToken }));
    for (const user of response.Users || []) {
      users.push({
        displayName: user.DisplayName || user.UserName || '',
        identityStoreUserId: user.UserId || '',
        userName: user.UserName || '',
        email: user.Emails?.find((email) => email.Primary)?.Value || user.Emails?.[0]?.Value || '',
      });
    }
    nextToken = response.NextToken;
  } while (nextToken);
  return users.filter((user) => user.displayName && user.identityStoreUserId);
}

async function listGroups(client: IdentitystoreClient, identityStoreId: string): Promise<Map<string, { groupId: string; displayName: string }>> {
  const groups = new Map<string, { groupId: string; displayName: string }>();
  let nextToken: string | undefined;
  do {
    const response = await client.send(new ListGroupsCommand({ IdentityStoreId: identityStoreId, NextToken: nextToken }));
    for (const group of response.Groups || []) {
      if (group.GroupId) groups.set(group.GroupId, { groupId: group.GroupId, displayName: group.DisplayName || '' });
    }
    nextToken = response.NextToken;
  } while (nextToken);
  return groups;
}

async function listGroupMemberships(client: IdentitystoreClient, identityStoreId: string, groupIds: string[]): Promise<Map<string, string[]>> {
  const memberships = new Map<string, string[]>();
  for (const groupId of groupIds) {
    const userIds: string[] = [];
    let nextToken: string | undefined;
    do {
      const response = await client.send(new ListGroupMembershipsCommand({ IdentityStoreId: identityStoreId, GroupId: groupId, NextToken: nextToken }));
      for (const membership of response.GroupMemberships || []) {
        if (membership.MemberId?.UserId) userIds.push(membership.MemberId.UserId);
      }
      nextToken = response.NextToken;
    } while (nextToken);
    memberships.set(groupId, userIds);
  }
  return memberships;
}

async function listPermissionSets(client: SSOAdminClient, instanceArn: string): Promise<Map<string, string>> {
  const permissionSets = new Map<string, string>();
  let nextToken: string | undefined;
  do {
    const response = await client.send(new ListPermissionSetsCommand({ InstanceArn: instanceArn, NextToken: nextToken }));
    for (const arn of response.PermissionSets || []) {
      const detail = await client.send(new DescribePermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: arn }));
      permissionSets.set(arn, detail.PermissionSet?.Name || '');
    }
    nextToken = response.NextToken;
  } while (nextToken);
  return permissionSets;
}

async function listAccountAssignments(client: SSOAdminClient, instanceArn: string, permissionSetArns: string[]) {
  const assignments: ExpandedAssignmentState['accountAssignments'] = [];
  for (const permissionSetArn of permissionSetArns) {
    const accounts = await listAccountsForPermissionSet(client, instanceArn, permissionSetArn);
    for (const accountId of accounts) {
      let nextToken: string | undefined;
      do {
        const response = await client.send(new ListAccountAssignmentsCommand({
          InstanceArn: instanceArn,
          PermissionSetArn: permissionSetArn,
          AccountId: accountId,
          NextToken: nextToken,
        }));
        for (const row of response.AccountAssignments || []) {
          if (row.PrincipalId && row.PrincipalType) {
            assignments.push({
              accountId,
              permissionSetArn,
              principalId: row.PrincipalId,
              principalType: row.PrincipalType,
            });
          }
        }
        nextToken = response.NextToken;
      } while (nextToken);
    }
  }
  return assignments;
}

async function listAccountsForPermissionSet(client: SSOAdminClient, instanceArn: string, permissionSetArn: string): Promise<string[]> {
  const accountIds: string[] = [];
  let nextToken: string | undefined;
  do {
    const response = await client.send(new ListAccountsForProvisionedPermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: permissionSetArn, NextToken: nextToken }));
    accountIds.push(...(response.AccountIds || []));
    nextToken = response.NextToken;
  } while (nextToken);
  return accountIds;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node tests/assets/test_identity_audit_runner.mjs
```

Expected:

```text
PASS with no output
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/lib/identity-audit/types.ts src/lib/identity-audit/aws-collector.ts tests/assets/test_identity_audit_runner.mjs
git commit -m "Add identity center collector"
```

---

### Task 6: Implement Audit Runner And API Route

**Files:**
- Create: `src/lib/identity-audit/audit-runner.ts`
- Create: `src/app/api/identity-audit/route.ts`
- Modify: `tests/assets/test_identity_audit_runner.mjs`

- [ ] **Step 1: Extend test for orchestration with injected dependencies**

Append to `tests/assets/test_identity_audit_runner.mjs`:

```javascript
const { runIdentityAudit } = require(join(outDir, 'identity-audit/audit-runner.js'));
const runResult = await runIdentityAudit({
  now: () => '2026-06-27T02:00:00.000Z',
  openDb: () => openAssetDb(join(outDir, 'runner.db')),
  collectIdentityCenterState: async () => ({
    users: [{ displayName: 'runner.j', identityStoreUserId: 'user-9', userName: 'runner.j', email: 'runner.j@example.com' }],
    assignments: [{
      displayName: 'runner.j',
      identityStoreUserId: 'user-9',
      accountId: '123456789012',
      accountName: '',
      permissionSetArn: 'arn:aws:sso:::permissionSet/ssoins-1/ps-9',
      permissionSetName: 'ReadOnly',
      assignmentType: 'USER',
      groupId: '',
      groupName: '',
    }],
  }),
  resolveConfig: () => ({
    enabled: true,
    profile: 'identity-audit-profile',
    region: 'ap-northeast-2',
    endpointUrls: {},
    organizationApi: {
      baseUrl: 'https://knock-api.kakaopay.com/papi/v1/krew',
      apiKeyEnv: 'KREW_API_KEY',
      lookupField: 'displayName',
      concurrency: 10,
      timeoutMs: 5000,
      retryCount: 2,
    },
    schedule: { dayOfWeek: 2, hour: 10, timezone: 'Asia/Seoul' },
  }),
  getOrganizationApiKey: () => 'test-key',
  fetchOrganizationPositionsForUsers: async () => new Map([
    ['runner.j', { displayName: 'runner.j', orgCode: 'ABC12345', orgName: '클라우드파트', raw: {} }],
  ]),
});
assert.equal(runResult.status, 'completed');
assert.equal(runResult.summary.totalUsers, 1);
```

Also add `src/lib/identity-audit/audit-runner.ts` to the `tsc` input list.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/assets/test_identity_audit_runner.mjs
```

Expected:

```text
FAIL because audit-runner.ts does not exist
```

- [ ] **Step 3: Implement audit runner**

Create `src/lib/identity-audit/audit-runner.ts`:

```typescript
import { openAssetDb, type AssetDb } from '../assets/asset-db';
import { resolveIdentityAuditConfig, type ResolvedIdentityAuditConfig } from './config';
import { collectIdentityCenterState } from './aws-collector';
import { fetchOrganizationPositionsForUsers } from './org-api';
import {
  completeIdentityAuditRun,
  createIdentityAuditRun,
  persistIdentityAuditSnapshot,
} from './repository';

let running = false;

export interface RunIdentityAuditDependencies {
  now?: () => string;
  openDb?: () => AssetDb;
  resolveConfig?: () => ResolvedIdentityAuditConfig;
  collectIdentityCenterState?: typeof collectIdentityCenterState;
  fetchOrganizationPositionsForUsers?: typeof fetchOrganizationPositionsForUsers;
  getOrganizationApiKey?: (envName: string) => string | undefined;
}

export async function runIdentityAudit(dependencies: RunIdentityAuditDependencies = {}) {
  if (running) throw new Error('identity audit is already running');
  running = true;
  const now = dependencies.now || (() => new Date().toISOString());
  const db = (dependencies.openDb || (() => openAssetDb()))();
  const run = createIdentityAuditRun(db, now());

  try {
    const config = (dependencies.resolveConfig || resolveIdentityAuditConfig)();
    if (!config.enabled) throw new Error('identity audit is disabled');
    if (!config.profile) throw new Error('identity audit AWS profile is not configured');
    const apiKey = (dependencies.getOrganizationApiKey || ((envName) => process.env[envName]))(config.organizationApi.apiKeyEnv);
    if (!apiKey) throw new Error(`${config.organizationApi.apiKeyEnv} is not set`);

    const collector = dependencies.collectIdentityCenterState || collectIdentityCenterState;
    const orgFetcher = dependencies.fetchOrganizationPositionsForUsers || fetchOrganizationPositionsForUsers;
    const state = await collector({
      profile: config.profile,
      region: config.region,
      endpointUrls: config.endpointUrls,
    });
    const orgByDisplayName = await orgFetcher(
      state.users.map((user) => user.displayName),
      {
        baseUrl: config.organizationApi.baseUrl,
        apiKey,
        concurrency: config.organizationApi.concurrency,
        timeoutMs: config.organizationApi.timeoutMs,
        retryCount: config.organizationApi.retryCount,
      },
    );
    const collectedAt = now();
    const summary = persistIdentityAuditSnapshot(db, {
      runId: run.id,
      collectedAt,
      users: state.users.map((user) => {
        const org = orgByDisplayName.get(user.displayName);
        return {
          displayName: user.displayName,
          identityStoreUserId: user.identityStoreUserId,
          userName: user.userName,
          email: user.email,
          orgCode: org?.orgCode || '',
          orgName: org?.orgName || '',
          rawOrg: org?.raw || {},
        };
      }),
      assignments: state.assignments,
    });
    completeIdentityAuditRun(db, run.id, 'completed', now());
    return { runId: run.id, status: 'completed', summary };
  } catch (err) {
    completeIdentityAuditRun(db, run.id, 'failed', now(), err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    db.close();
    running = false;
  }
}
```

- [ ] **Step 4: Implement API route**

Create `src/app/api/identity-audit/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/app-config';
import { openAssetDb } from '@/lib/assets/asset-db';
import { runIdentityAudit } from '@/lib/identity-audit/audit-runner';
import {
  exportIdentityAuditFindingsCsv,
  getLatestIdentityAuditRun,
  listIdentityAuditFindings,
  listIdentityAuditRuns,
} from '@/lib/identity-audit/repository';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    const action = searchParams.get('action') || '';
    const runId = searchParams.get('runId') || undefined;
    if (action === 'export') {
      const csv = exportIdentityAuditFindingsCsv(db, { runId });
      return new NextResponse(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="identity-audit-findings.csv"',
        },
      });
    }
    return NextResponse.json({
      latestRun: getLatestIdentityAuditRun(db) || null,
      runs: listIdentityAuditRuns(db, { limit: 20 }),
      findings: listIdentityAuditFindings(db, { runId, limit: 200 }),
    });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  if (body.action !== 'run') {
    return NextResponse.json({ error: 'unsupported action' }, { status: 400 });
  }
  try {
    return NextResponse.json(await runIdentityAudit());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
```

Add `listIdentityAuditRuns` and `exportIdentityAuditFindingsCsv` to repository:

```typescript
export function listIdentityAuditRuns(db: AssetDb, opts: { limit?: number }) {
  const limit = Math.min(Math.max(opts.limit || 20, 1), 100);
  return db.prepare('select * from identity_audit_runs order by started_at desc limit ?').all(limit);
}

export function exportIdentityAuditFindingsCsv(db: AssetDb, filters: { runId?: string }): string {
  const rows = listIdentityAuditFindings(db, { runId: filters.runId, limit: 10000 }).rows as Record<string, unknown>[];
  const headers = ['display_name', 'old_org_code', 'old_org_name', 'new_org_code', 'new_org_name', 'assignment_count', 'severity', 'message', 'created_at'];
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
  ].join('\n');
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 5: Run test and build**

Run:

```bash
node tests/assets/test_identity_audit_runner.mjs
npm run build
```

Expected:

```text
test passes with no output
build completes successfully
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/lib/identity-audit/audit-runner.ts src/app/api/identity-audit/route.ts src/lib/identity-audit/repository.ts tests/assets/test_identity_audit_runner.mjs
git commit -m "Add identity audit runner and API"
```

---

### Task 7: Add Identity Audit UI

**Files:**
- Create: `src/app/identity-audit/page.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/lib/i18n/translations/ko.json`
- Modify: `src/lib/i18n/translations/en.json`

- [ ] **Step 1: Add sidebar translation keys**

Modify `src/lib/i18n/translations/ko.json`:

```json
"sidebar.identityAudit": "Identity 감사"
```

Modify `src/lib/i18n/translations/en.json`:

```json
"sidebar.identityAudit": "Identity Audit"
```

- [ ] **Step 2: Add sidebar item**

Modify `src/components/layout/Sidebar.tsx` security group:

```typescript
{ labelKey: 'sidebar.identityAudit', href: '/identity-audit', icon: ClipboardCheck },
```

- [ ] **Step 3: Create page**

Create `src/app/identity-audit/page.tsx`:

```typescript
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import Header from '@/components/layout/Header';

interface AuditRun {
  id: string;
  status: string;
  started_at: string;
  finished_at?: string;
  total_users: number;
  org_resolved_users: number;
  changed_users: number;
  risky_users: number;
  error_count: number;
  error_message: string;
}

interface Finding {
  id: string;
  run_id: string;
  display_name: string;
  severity: string;
  old_org_code: string;
  old_org_name: string;
  new_org_code: string;
  new_org_name: string;
  assignment_count: number;
  message: string;
  created_at: string;
}

export default function IdentityAuditPage() {
  const [latestRun, setLatestRun] = useState<AuditRun | null>(null);
  const [runs, setRuns] = useState<AuditRun[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Finding | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/awsops/api/identity-audit');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Identity 감사 데이터를 불러오지 못했습니다.');
      setLatestRun(data.latestRun);
      setRuns(data.runs || []);
      setFindings(data.findings?.rows || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const runAudit = useCallback(async () => {
    setRunning(true);
    setError('');
    try {
      const res = await fetch('/awsops/api/identity-audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'run' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Identity 감사 실행에 실패했습니다.');
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [fetchData]);

  const stats = useMemo(() => ([
    { label: '전체 사용자', value: latestRun?.total_users ?? 0 },
    { label: '조직 확인', value: latestRun?.org_resolved_users ?? 0 },
    { label: '부서 변경', value: latestRun?.changed_users ?? 0 },
    { label: '권한 잔존', value: latestRun?.risky_users ?? 0 },
  ]), [latestRun]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-navy-900">
      <Header title="Identity 감사" subtitle="부서 이동자 중 IAM Identity Center 권한이 남아 있는 사용자를 점검합니다" onRefresh={fetchData} />
      <main className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 rounded-lg border border-accent-red/40 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
            {error}
          </div>
        )}

        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-gray-400">
            최근 실행: <span className="font-mono text-gray-200">{latestRun?.started_at || '없음'}</span>
          </div>
          <div className="flex gap-2">
            <a
              href="/awsops/api/identity-audit?action=export"
              className="inline-flex items-center gap-2 rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-300 hover:border-accent-cyan/50 hover:text-accent-cyan"
            >
              <Download size={16} /> CSV
            </a>
            <button
              onClick={runAudit}
              disabled={running}
              className="inline-flex items-center gap-2 rounded-lg bg-accent-cyan px-3 py-2 text-sm font-medium text-navy-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {running ? <RefreshCw size={16} className="animate-spin" /> : <Play size={16} />}
              수동 실행
            </button>
          </div>
        </div>

        <section className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-lg border border-navy-600 bg-navy-800 px-4 py-3">
              <div className="text-xs text-gray-500">{stat.label}</div>
              <div className="mt-1 text-2xl font-semibold text-white">{stat.value}</div>
            </div>
          ))}
        </section>

        <section className="rounded-lg border border-navy-600 bg-navy-800">
          <div className="flex items-center gap-2 border-b border-navy-600 px-4 py-3">
            <ShieldCheck size={16} className="text-accent-cyan" />
            <h2 className="text-sm font-semibold text-white">감사 Finding</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-navy-700 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">사용자</th>
                  <th className="px-4 py-3">이전 조직</th>
                  <th className="px-4 py-3">현재 조직</th>
                  <th className="px-4 py-3">권한 수</th>
                  <th className="px-4 py-3">심각도</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">로딩 중...</td></tr>
                ) : findings.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">표시할 Finding이 없습니다.</td></tr>
                ) : findings.map((finding) => (
                  <tr key={finding.id} onClick={() => setSelected(finding)} className="cursor-pointer border-b border-navy-600 hover:bg-navy-700">
                    <td className="px-4 py-3 font-mono text-accent-cyan">{finding.display_name}</td>
                    <td className="px-4 py-3">{finding.old_org_name || finding.old_org_code}</td>
                    <td className="px-4 py-3">{finding.new_org_name || finding.new_org_code}</td>
                    <td className="px-4 py-3">{finding.assignment_count}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 rounded border border-accent-orange/40 px-2 py-1 text-xs text-accent-orange">
                        <AlertTriangle size={12} /> {finding.severity}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setSelected(null)}>
          <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-navy-600 bg-navy-900 p-5" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white">{selected.display_name}</h3>
            <p className="mt-2 text-sm text-gray-400">{selected.message}</p>
            <div className="mt-5 space-y-3 text-sm">
              <Detail label="이전 조직" value={`${selected.old_org_name} (${selected.old_org_code})`} />
              <Detail label="현재 조직" value={`${selected.new_org_name} (${selected.new_org_code})`} />
              <Detail label="남은 권한 수" value={String(selected.assignment_count)} />
              <Detail label="탐지 시각" value={selected.created_at} />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-navy-600 bg-navy-800 px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 break-all text-gray-200">{value}</div>
    </div>
  );
}
```

- [ ] **Step 4: Build**

Run:

```bash
npm run build
```

Expected:

```text
build completes successfully
```

- [ ] **Step 5: Commit**

Run:

```bash
git add src/app/identity-audit/page.tsx src/components/layout/Sidebar.tsx src/lib/i18n/translations/ko.json src/lib/i18n/translations/en.json
git commit -m "Add identity audit page"
```

---

### Task 8: Add Scheduler

**Files:**
- Create: `src/lib/identity-audit/scheduler.ts`
- Modify: `src/app/api/identity-audit/route.ts`

- [ ] **Step 1: Create scheduler**

Create `src/lib/identity-audit/scheduler.ts`:

```typescript
import { resolveIdentityAuditConfig } from './config';
import { runIdentityAudit } from './audit-runner';

let schedulerTimer: NodeJS.Timeout | null = null;

export function startIdentityAuditScheduler(): void {
  if (schedulerTimer) return;
  const check = async () => {
    const config = resolveIdentityAuditConfig();
    if (!config.enabled) return;
    if (!isTuesdayTenKst()) return;
    try {
      await runIdentityAudit();
    } catch (err) {
      console.error('[Identity Audit Scheduler] run failed:', err);
    }
  };
  schedulerTimer = setInterval(check, 5 * 60 * 1000);
}

export function stopIdentityAuditScheduler(): void {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}

export function isTuesdayTenKst(date = new Date()): boolean {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.getUTCDay() === 2 && kst.getUTCHours() === 10;
}
```

- [ ] **Step 2: Start scheduler from API route**

Modify `src/app/api/identity-audit/route.ts`:

```typescript
import { startIdentityAuditScheduler } from '@/lib/identity-audit/scheduler';

startIdentityAuditScheduler();
```

- [ ] **Step 3: Build**

Run:

```bash
npm run build
```

Expected:

```text
build completes successfully
```

- [ ] **Step 4: Commit**

Run:

```bash
git add src/lib/identity-audit/scheduler.ts src/app/api/identity-audit/route.ts
git commit -m "Schedule identity audit checks"
```

---

### Task 9: Add AI Context

**Files:**
- Modify: `src/lib/assets/asset-ai.ts`
- Modify: `src/app/api/ai/route.ts`
- Modify: `tests/assets/test_asset_ai.mjs`

- [ ] **Step 1: Add failing AI test**

Append to `tests/assets/test_asset_ai.mjs`:

```javascript
const identityContext = buildAssetInventoryContext(db, '부서 이동 후 AWS 권한 남은 사람 알려줘');
assert.match(formatAssetInventoryContext(identityContext), /identity_audit_findings/);
```

If the existing AI helpers are named differently, use the existing function names already imported in the file.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/assets/test_asset_ai.mjs
```

Expected:

```text
FAIL because identity audit context is not included
```

- [ ] **Step 3: Add identity audit context builder**

Modify `src/lib/assets/asset-ai.ts` to detect these keywords:

```typescript
const IDENTITY_AUDIT_KEYWORDS = [
  'identity 감사',
  'iam identity center',
  'permission set',
  '부서 이동',
  '조직 변경',
  '권한 남은',
  '권한 잔존',
];
```

When matched, open read-only asset DB and include latest `identity_audit_findings` rows. The formatted context should start with:

```text
source: identity_audit_findings_db
```

- [ ] **Step 4: Route AI questions to asset inventory context**

Modify `src/app/api/ai/route.ts` routing hints so questions about `Identity 감사`, `부서 이동`, `권한 잔존`, `Permission Set` are handled by saved DB context, not live AWS tools.

- [ ] **Step 5: Run AI test**

Run:

```bash
node tests/assets/test_asset_ai.mjs
```

Expected:

```text
PASS with no output
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/lib/assets/asset-ai.ts src/app/api/ai/route.ts tests/assets/test_asset_ai.mjs
git commit -m "Add identity audit AI context"
```

---

### Task 10: Final Verification And Push

**Files:**
- All files changed above.

- [ ] **Step 1: Run focused tests**

Run:

```bash
node tests/assets/test_identity_audit_config.mjs
node tests/assets/test_identity_audit_db.mjs
node tests/assets/test_identity_audit_runner.mjs
node tests/assets/test_asset_ai.mjs
```

Expected:

```text
all commands exit 0
```

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected:

```text
final TAP summary reports 0 failed
```

- [ ] **Step 3: Build**

Run:

```bash
npm run build
```

Expected:

```text
Next.js build completes successfully
```

- [ ] **Step 4: Static shell check**

Run:

```bash
bash -n scripts/*.sh
```

Expected:

```text
no output and exit 0
```

- [ ] **Step 5: Diff hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected:

```text
git diff --check exits 0
status only shows intended committed work plus pre-existing unrelated untracked duplicate files
```

- [ ] **Step 6: Push**

Run:

```bash
git push origin codex/private-langgraph-mcp-phase1
```

Expected:

```text
remote branch updated successfully
```

---

## Self-Review

- Spec coverage:
  - Separate Identity Center profile is covered in Tasks 1 and 5.
  - Existing VPC endpoint config is covered through endpoint URL resolution in Tasks 1 and 5.
  - DB snapshots, change events, assignments, and findings are covered in Tasks 2 and 3.
  - knock API enrichment is covered in Task 4.
  - Manual run, UI, CSV export, and scheduler are covered in Tasks 6, 7, and 8.
  - AI answers from saved DB context are covered in Task 9.
- Placeholder scan:
  - The plan contains no unresolved placeholders or vague implementation steps.
- Type consistency:
  - `displayName`, `identityStoreUserId`, `orgCode`, `orgName`, `permissionSetArn`, and `permissionSetName` are consistently used across types, repository, runner, and UI.
