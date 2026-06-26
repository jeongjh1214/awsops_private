import crypto from 'crypto';
import type { AssetDb } from '../assets/asset-db';
import type {
  IdentityAuditAssignmentInput,
  IdentityAuditPersistSummary,
  PersistIdentityAuditSnapshotInput,
} from './types';

export type IdentityAuditRunStatus = 'running' | 'completed' | 'failed';

export interface IdentityAuditRunRow {
  id: string;
  status: IdentityAuditRunStatus;
  started_at: string;
  finished_at: string | null;
  total_users: number;
  org_resolved_users: number;
  changed_users: number;
  risky_users: number;
  error_count: number;
  error_message: string;
}

export interface IdentityAuditFindingFilters {
  runId?: string;
  severity?: 'medium' | 'high';
  limit?: number;
  offset?: number;
}

export interface IdentityAuditFindingListResult {
  rows: IdentityAuditFindingRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface IdentityAuditRunListFilters {
  limit?: number;
}

export interface IdentityAuditFindingRow {
  id: string;
  run_id: string;
  display_name: string;
  finding_type: string;
  severity: string;
  old_org_code: string;
  old_org_name: string;
  new_org_code: string;
  new_org_name: string;
  assignment_count: number;
  message: string;
  created_at: string;
}

interface PreviousIdentityUserRow {
  current_org_code: string;
  current_org_name: string;
}

interface PreviousIdentityUserBaselineRow extends PreviousIdentityUserRow {
  display_name: string;
}

interface DedupedIdentityAuditAssignment {
  id: string;
  assignment: IdentityAuditAssignmentInput;
}

const FINDING_TYPE_ORG_CHANGED_WITH_AWS_ACCESS = 'ORG_CHANGED_WITH_AWS_ACCESS';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

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
    set status = @status,
      finished_at = @finishedAt,
      error_message = @errorMessage
    where id = @runId
  `).run({ runId, status, finishedAt, errorMessage });
}

export function persistIdentityAuditSnapshot(
  db: AssetDb,
  input: PersistIdentityAuditSnapshotInput,
): IdentityAuditPersistSummary {
  return db.transaction(() => {
    const previousByDisplayName = loadPreviousOrgBaselines(db, input.runId);
    const dedupedAssignments = dedupeAssignments(input.runId, input.assignments);
    const assignmentCounts = countAssignmentsByDisplayName(dedupedAssignments);
    let changedUsers = 0;
    let riskyUsers = 0;

    db.prepare('delete from identity_audit_findings where run_id = ?').run(input.runId);
    db.prepare('delete from identity_aws_assignments where run_id = ?').run(input.runId);
    db.prepare('delete from identity_org_change_events where run_id = ?').run(input.runId);
    db.prepare('delete from identity_org_snapshots where run_id = ?').run(input.runId);

    const getPreviousUser = db.prepare(`
      select current_org_code, current_org_name
      from identity_users
      where display_name = ?
    `);
    const snapshotUpsert = db.prepare(`
      insert into identity_org_snapshots (
        id, run_id, display_name, org_code, org_name, raw_json, collected_at
      ) values (
        @id, @runId, @displayName, @orgCode, @orgName, @rawJson, @collectedAt
      )
      on conflict(id) do update set
        org_code = excluded.org_code,
        org_name = excluded.org_name,
        raw_json = excluded.raw_json,
        collected_at = excluded.collected_at
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
    const changeUpsert = db.prepare(`
      insert into identity_org_change_events (
        id, run_id, display_name, old_org_code, old_org_name,
        new_org_code, new_org_name, detected_at
      ) values (
        @id, @runId, @displayName, @oldOrgCode, @oldOrgName,
        @newOrgCode, @newOrgName, @detectedAt
      )
      on conflict(id) do update set
        old_org_code = excluded.old_org_code,
        old_org_name = excluded.old_org_name,
        new_org_code = excluded.new_org_code,
        new_org_name = excluded.new_org_name,
        detected_at = excluded.detected_at
    `);
    const findingInsert = db.prepare(`
      insert into identity_audit_findings (
        id, run_id, display_name, finding_type, severity, old_org_code,
        old_org_name, new_org_code, new_org_name, assignment_count, message,
        created_at
      ) values (
        @id, @runId, @displayName, @findingType, @severity, @oldOrgCode,
        @oldOrgName, @newOrgCode, @newOrgName, @assignmentCount, @message,
        @createdAt
      )
    `);

    for (const { id, assignment } of dedupedAssignments) {
      assignmentInsert.run({
        id,
        runId: input.runId,
        displayName: assignment.displayName,
        identityStoreUserId: assignment.identityStoreUserId,
        accountId: assignment.accountId,
        accountName: assignment.accountName,
        permissionSetArn: assignment.permissionSetArn,
        permissionSetName: assignment.permissionSetName,
        assignmentType: assignment.assignmentType,
        groupId: assignment.groupId,
        groupName: assignment.groupName,
        collectedAt: input.collectedAt,
      });
    }

    for (const user of input.users) {
      const previous = previousByDisplayName.get(user.displayName)
        ?? getPreviousUser.get(user.displayName) as PreviousIdentityUserRow | undefined;
      const assignmentCount = assignmentCounts.get(user.displayName) ?? 0;

      snapshotUpsert.run({
        id: stableId('identity-org-snapshot', input.runId, user.displayName),
        runId: input.runId,
        displayName: user.displayName,
        orgCode: user.orgCode,
        orgName: user.orgName,
        rawJson: JSON.stringify(user.rawOrg ?? {}),
        collectedAt: input.collectedAt,
      });

      const previousOrgCode = previous?.current_org_code || '';
      const changed = Boolean(previousOrgCode)
        && previousOrgCode !== user.orgCode
        && user.orgCode !== '';

      userUpsert.run({
        displayName: user.displayName,
        identityStoreUserId: user.identityStoreUserId,
        userName: user.userName,
        email: user.email,
        orgCode: user.orgCode,
        orgName: user.orgName,
        assignmentCount,
        collectedAt: input.collectedAt,
      });

      if (!changed || !previous) continue;

      changedUsers += 1;
      changeUpsert.run({
        id: stableId(
          'identity-org-change',
          input.runId,
          user.displayName,
          previous.current_org_code,
          user.orgCode,
        ),
        runId: input.runId,
        displayName: user.displayName,
        oldOrgCode: previous.current_org_code,
        oldOrgName: previous.current_org_name,
        newOrgCode: user.orgCode,
        newOrgName: user.orgName,
        detectedAt: input.collectedAt,
      });

      if (assignmentCount === 0) continue;

      riskyUsers += 1;
      findingInsert.run({
        id: stableId('identity-audit-finding', input.runId, user.displayName),
        runId: input.runId,
        displayName: user.displayName,
        findingType: FINDING_TYPE_ORG_CHANGED_WITH_AWS_ACCESS,
        severity: assignmentCount >= 3 ? 'high' : 'medium',
        oldOrgCode: previous.current_org_code,
        oldOrgName: previous.current_org_name,
        newOrgCode: user.orgCode,
        newOrgName: user.orgName,
        assignmentCount,
        message: makeFindingMessage(user.displayName, previous, user.orgCode, user.orgName, assignmentCount),
        createdAt: input.collectedAt,
      });
    }

    const summary: IdentityAuditPersistSummary = {
      totalUsers: input.users.length,
      orgResolvedUsers: input.users.filter((user) => user.orgCode !== '').length,
      changedUsers,
      riskyUsers,
      errorCount: 0,
    };

    db.prepare(`
      update identity_audit_runs
      set total_users = @totalUsers,
        org_resolved_users = @orgResolvedUsers,
        changed_users = @changedUsers,
        risky_users = @riskyUsers,
        error_count = @errorCount
      where id = @runId
    `).run({ ...summary, runId: input.runId });

    return summary;
  })();
}

export function getLatestIdentityAuditRun(db: AssetDb): IdentityAuditRunRow | undefined {
  return db.prepare(`
    select *
    from identity_audit_runs
    order by started_at desc, rowid desc
    limit 1
  `).get() as IdentityAuditRunRow | undefined;
}

export function listIdentityAuditRuns(
  db: AssetDb,
  filters: IdentityAuditRunListFilters = {},
): IdentityAuditRunRow[] {
  const limit = normalizeLimit(filters.limit);
  return db.prepare(`
    select *
    from identity_audit_runs
    order by started_at desc, rowid desc
    limit @limit
  `).all({ limit }) as IdentityAuditRunRow[];
}

export function listIdentityAuditFindings(
  db: AssetDb,
  filters: IdentityAuditFindingFilters = {},
): IdentityAuditFindingListResult {
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);
  const query = makeFindingWhereClause(filters);

  const rows = db.prepare(`
    select *
    from identity_audit_findings
    ${query.whereSql}
    order by created_at desc, id asc
    limit @limit offset @offset
  `).all({ ...query.params, limit, offset }) as IdentityAuditFindingRow[];
  const totalRow = db.prepare(`
    select count(*) as total
    from identity_audit_findings
    ${query.whereSql}
  `).get(query.params) as { total: number };

  return {
    rows,
    total: totalRow.total,
    limit,
    offset,
  };
}

export function exportIdentityAuditFindingsCsv(
  db: AssetDb,
  filters: Pick<IdentityAuditFindingFilters, 'runId'> = {},
): string {
  const query = makeFindingWhereClause(filters);
  const rows = db.prepare(`
    select
      display_name,
      old_org_code,
      old_org_name,
      new_org_code,
      new_org_name,
      assignment_count,
      severity,
      message,
      created_at
    from identity_audit_findings
    ${query.whereSql}
    order by created_at desc, id asc
  `).all(query.params) as Array<Pick<
    IdentityAuditFindingRow,
    | 'display_name'
    | 'old_org_code'
    | 'old_org_name'
    | 'new_org_code'
    | 'new_org_name'
    | 'assignment_count'
    | 'severity'
    | 'message'
    | 'created_at'
  >>;

  const headers = [
    'display_name',
    'old_org_code',
    'old_org_name',
    'new_org_code',
    'new_org_name',
    'assignment_count',
    'severity',
    'message',
    'created_at',
  ];
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header as keyof typeof row])).join(',')),
  ];

  return `${lines.join('\n')}\n`;
}

function loadPreviousOrgBaselines(db: AssetDb, runId: string): Map<string, PreviousIdentityUserRow> {
  const rows = db.prepare(`
    select
      display_name,
      old_org_code as current_org_code,
      old_org_name as current_org_name
    from identity_org_change_events
    where run_id = ?
    order by rowid asc
  `).all(runId) as PreviousIdentityUserBaselineRow[];
  const previousByDisplayName = new Map<string, PreviousIdentityUserRow>();

  for (const row of rows) {
    if (previousByDisplayName.has(row.display_name)) continue;
    previousByDisplayName.set(row.display_name, {
      current_org_code: row.current_org_code,
      current_org_name: row.current_org_name,
    });
  }

  return previousByDisplayName;
}

function dedupeAssignments(
  runId: string,
  assignments: IdentityAuditAssignmentInput[],
): DedupedIdentityAuditAssignment[] {
  const deduped = new Map<string, IdentityAuditAssignmentInput>();

  for (const assignment of assignments) {
    const id = assignmentStableId(runId, assignment);
    if (!deduped.has(id)) {
      deduped.set(id, assignment);
    }
  }

  return [...deduped.entries()].map(([id, assignment]) => ({ id, assignment }));
}

function countAssignmentsByDisplayName(assignments: DedupedIdentityAuditAssignment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { assignment } of assignments) {
    counts.set(assignment.displayName, (counts.get(assignment.displayName) ?? 0) + 1);
  }
  return counts;
}

function assignmentStableId(runId: string, assignment: IdentityAuditAssignmentInput): string {
  return stableId(
    'identity-assignment',
    runId,
    assignment.displayName,
    assignment.accountId,
    assignment.permissionSetArn,
    assignment.assignmentType,
    assignment.groupId,
  );
}

function makeFindingMessage(
  displayName: string,
  previous: PreviousIdentityUserRow,
  newOrgCode: string,
  newOrgName: string,
  assignmentCount: number,
): string {
  const oldOrg = previous.current_org_name || previous.current_org_code;
  const newOrg = newOrgName || newOrgCode;
  return `${displayName} moved from ${oldOrg} to ${newOrg} and still has ${assignmentCount} AWS assignment(s).`;
}

function makeFindingWhereClause(filters: IdentityAuditFindingFilters): {
  whereSql: string;
  params: Record<string, string>;
} {
  const clauses: string[] = [];
  const params: Record<string, string> = {};

  if (filters.runId) {
    clauses.push('run_id = @runId');
    params.runId = filters.runId;
  }

  if (filters.severity) {
    clauses.push('severity = @severity');
    params.severity = filters.severity;
  }

  return {
    whereSql: clauses.length > 0 ? `where ${clauses.join(' and ')}` : '',
    params,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  return Math.max(Math.trunc(offset), 0);
}

function csvCell(value: unknown): string {
  const text = guardCsvFormula(value === null || value === undefined ? '' : String(value));
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function guardCsvFormula(value: string): string {
  return /^[\s\x00-\x1F\x7F]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function stableId(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
}
