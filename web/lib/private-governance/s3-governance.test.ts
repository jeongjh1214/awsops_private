import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
const clientQuery = vi.fn();
const clientRelease = vi.fn();
const poolConnect = vi.fn();

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    query: poolQuery,
    connect: poolConnect,
  }),
}));

import {
  getS3GovernanceRecord,
  listS3GovernanceRecords,
  makeS3GovernanceStableKey,
  seedS3GovernanceRecordsFromInventory,
  updateS3GovernanceRecord,
} from './s3-governance';
import { getPrivateGovernanceDbProvider } from './private-db-provider';
import { openPrivateSqliteDb } from './sqlite-db';

beforeEach(() => {
  process.env.AWSOPS_PRIVATE_DB_PROVIDER = 'aurora';
  delete process.env.AWSOPS_PRIVATE_SQLITE_PATH;
  poolQuery.mockReset().mockResolvedValue({ rows: [] });
  clientQuery.mockReset().mockResolvedValue({ rows: [] });
  clientRelease.mockReset();
  poolConnect.mockReset().mockResolvedValue({ query: clientQuery, release: clientRelease });
});

describe('private S3 governance repository', () => {
  it('lists governance records joined to v2 inventory resources', async () => {
    poolQuery
      .mockResolvedValueOnce({
        rows: [{
          account_id: '123456789012',
          account_name: 'core',
          phase: 'prod',
          bucket_name: 'audit-bucket',
          owner_team: 'security',
          purpose: 'audit',
          history: '',
          contains_personal_info: true,
          pii_retention_aware: null,
          pii_retention_applied: false,
          pii_retention_period: '3y',
          remarks: '',
          updated_by: 'tester',
          updated_at: new Date('2026-07-29T00:00:00.000Z'),
          created_at: new Date('2026-07-28T00:00:00.000Z'),
          asset_region: 'ap-northeast-2',
          asset_captured_at: '2026-07-29T01:00:00.000Z',
          asset_data: { arn: 'arn:aws:s3:::audit-bucket' },
          active: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const result = await listS3GovernanceRecords({
      accountId: '123456789012',
      ownerTeam: 'security',
      active: true,
      piiRetentionAware: null,
      q: 'audit',
      limit: 20,
      offset: 5,
    });

    const [sql, params] = poolQuery.mock.calls[0];
    expect(String(sql)).toContain('inventory_resources');
    expect(String(sql)).toContain('r.resource_id IS NOT NULL');
    expect(String(sql)).toContain('g.pii_retention_aware IS NULL');
    expect(params).toEqual(['123456789012', 'security', '%audit%', 20, 5]);
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({
      stableKey: '123456789012:audit-bucket',
      containsPersonalInfo: true,
      piiRetentionAware: null,
      piiRetentionApplied: false,
      active: true,
      assetRegion: 'ap-northeast-2',
    });
  });

  it('returns a detail row with audit events for a stable key', async () => {
    poolQuery
      .mockResolvedValueOnce({
        rows: [{
          account_id: '123456789012',
          bucket_name: 'logs',
          account_name: '',
          phase: '',
          owner_team: '',
          purpose: '',
          history: '',
          contains_personal_info: null,
          pii_retention_aware: null,
          pii_retention_applied: null,
          pii_retention_period: '',
          remarks: '',
          updated_by: '',
          updated_at: '2026-07-29T00:00:00.000Z',
          created_at: '2026-07-29T00:00:00.000Z',
          active: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'event-1',
          account_id: '123456789012',
          bucket_name: 'logs',
          event_type: 'governance_created',
          event_source: 'user',
          summary: 'Created',
          before_json: {},
          after_json: { bucketName: 'logs' },
          created_by: 'tester',
          created_at: '2026-07-29T00:01:00.000Z',
        }],
      });

    const detail = await getS3GovernanceRecord('123456789012:logs');

    expect(detail?.stableKey).toBe('123456789012:logs');
    expect(detail?.events[0]).toMatchObject({
      stableKey: '123456789012:logs',
      eventType: 'governance_created',
      afterJson: { bucketName: 'logs' },
    });
  });

  it('upserts a record and writes a before/after governance event in one transaction', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (/SELECT \*/.test(String(sql))) {
        return {
          rows: [{
            account_id: '123456789012',
            bucket_name: 'logs',
            account_name: '',
            phase: '',
            owner_team: 'old-team',
            purpose: '',
            history: '',
            contains_personal_info: null,
            pii_retention_aware: null,
            pii_retention_applied: null,
            pii_retention_period: '',
            remarks: '',
            updated_by: 'old-user',
            updated_at: '2026-07-28T00:00:00.000Z',
            created_at: '2026-07-27T00:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    });

    const ok = await updateS3GovernanceRecord({
      accountId: '123456789012',
      bucketName: 'logs',
      ownerTeam: 'platform',
      containsPersonalInfo: true,
      updatedBy: 'tester',
    }, '2026-07-29T00:00:00.000Z');

    const statements = clientQuery.mock.calls.map((call) => String(call[0]));
    const upsertCall = clientQuery.mock.calls.find((call) => /ON CONFLICT \(account_id, bucket_name\)/.test(String(call[0])));
    const eventCall = clientQuery.mock.calls.find((call) => /INSERT INTO s3_governance_events/.test(String(call[0])));

    expect(ok).toBe(true);
    expect(statements[0]).toMatch(/BEGIN/);
    expect(statements.at(-1)).toMatch(/COMMIT/);
    expect(upsertCall?.[1]).toContain('platform');
    expect(JSON.parse(String(eventCall?.[1][4]))).toMatchObject({ ownerTeam: 'old-team' });
    expect(JSON.parse(String(eventCall?.[1][5]))).toMatchObject({
      ownerTeam: 'platform',
      containsPersonalInfo: true,
      updatedBy: 'tester',
    });
    expect(clientRelease).toHaveBeenCalled();
  });

  it('seeds missing governance records from inventory resources', async () => {
    clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/SELECT DISTINCT ON/.test(String(sql))) {
        return {
          rows: [
            { account_id: '123456789012', account_name: 'core', bucket_name: 'new-bucket' },
            { account_id: '123456789012', account_name: 'core', bucket_name: 'existing-bucket' },
          ],
        };
      }
      if (/SELECT \*/.test(String(sql)) && params?.[1] === 'existing-bucket') {
        return {
          rows: [{
            account_id: '123456789012',
            bucket_name: 'existing-bucket',
            updated_at: '2026-07-28T00:00:00.000Z',
            created_at: '2026-07-28T00:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    });

    const summary = await seedS3GovernanceRecordsFromInventory(
      { updatedBy: 'seed-test' },
      '2026-07-29T00:00:00.000Z',
    );

    const statements = clientQuery.mock.calls.map((call) => String(call[0]));
    expect(summary).toEqual({ scanned: 2, created: 1, skipped: 1 });
    expect(statements.some((sql) => sql.includes('inventory_resources'))).toBe(true);
    expect(statements.filter((sql) => /INSERT INTO s3_governance_records/.test(sql))).toHaveLength(1);
    expect(statements.filter((sql) => /INSERT INTO s3_governance_events/.test(sql))).toHaveLength(1);
    expect(statements.at(-1)).toMatch(/COMMIT/);
  });

  it('keeps the private stable key format from v1', () => {
    expect(makeS3GovernanceStableKey(' 123456789012 ', ' logs ')).toBe('123456789012:logs');
  });

  it('selects the private DB provider from explicit runtime settings', () => {
    process.env.AWSOPS_PRIVATE_DB_PROVIDER = 'sqlite';
    expect(getPrivateGovernanceDbProvider()).toBe('sqlite');

    process.env.AWSOPS_PRIVATE_DB_PROVIDER = 'aurora';
    expect(getPrivateGovernanceDbProvider()).toBe('aurora');
  });

  it('uses local SQLite for private S3 governance when selected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awsops-private-s3-'));
    process.env.AWSOPS_PRIVATE_DB_PROVIDER = 'sqlite';
    process.env.AWSOPS_PRIVATE_SQLITE_PATH = join(dir, 'awsops.db');

    try {
      const db = openPrivateSqliteDb();
      try {
        db.prepare(`
          INSERT INTO asset_records (
            account_id,
            account_name,
            service,
            resource_type,
            resource_id,
            region,
            data_json,
            discovered_at,
            last_seen_at,
            is_active
          ) VALUES (
            @accountId,
            @accountName,
            's3',
            's3_bucket',
            @bucketName,
            'ap-northeast-2',
            @dataJson,
            @now,
            @now,
            1
          )
        `).run({
          accountId: '123456789012',
          accountName: 'core',
          bucketName: 'logs',
          dataJson: JSON.stringify({ arn: 'arn:aws:s3:::logs' }),
          now: '2026-07-29T00:00:00.000Z',
        });
      } finally {
        db.close();
      }

      const seeded = await seedS3GovernanceRecordsFromInventory(
        { updatedBy: 'sqlite-seed' },
        '2026-07-29T00:01:00.000Z',
      );
      const updated = await updateS3GovernanceRecord({
        accountId: '123456789012',
        bucketName: 'logs',
        ownerTeam: 'platform',
        purpose: 'audit',
        containsPersonalInfo: true,
        updatedBy: 'sqlite-user',
      }, '2026-07-29T00:02:00.000Z');
      const detail = await getS3GovernanceRecord('123456789012:logs');
      const page = await listS3GovernanceRecords({ containsPersonalInfo: true });

      expect(seeded).toEqual({ scanned: 1, created: 1, skipped: 0 });
      expect(updated).toBe(true);
      expect(detail).toMatchObject({
        stableKey: '123456789012:logs',
        accountName: 'core',
        ownerTeam: 'platform',
        purpose: 'audit',
        containsPersonalInfo: true,
        assetRegion: 'ap-northeast-2',
        assetData: { arn: 'arn:aws:s3:::logs' },
        active: true,
      });
      expect(detail?.events.map((event) => event.eventType)).toEqual([
        'governance_updated',
        'governance_seeded',
      ]);
      expect(page.total).toBe(1);
      expect(poolQuery).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
