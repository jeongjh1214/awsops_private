import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const listS3GovernanceRecords = vi.fn();
const getS3GovernanceRecord = vi.fn();
const updateS3GovernanceRecord = vi.fn();
const seedS3GovernanceRecordsFromInventory = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/http-body', () => ({
  BodyTooLargeError: class BodyTooLargeError extends Error {},
  readJsonBounded: async (request: Request) => request.json(),
}));
vi.mock('@/lib/private-governance/s3-governance', () => ({
  makeS3GovernanceStableKey: (accountId: string, bucketName: string) => `${accountId.trim()}:${bucketName.trim()}`,
  listS3GovernanceRecords: (...a: unknown[]) => listS3GovernanceRecords(...a),
  getS3GovernanceRecord: (...a: unknown[]) => getS3GovernanceRecord(...a),
  updateS3GovernanceRecord: (...a: unknown[]) => updateS3GovernanceRecord(...a),
  seedS3GovernanceRecordsFromInventory: (...a: unknown[]) => seedS3GovernanceRecordsFromInventory(...a),
}));

const req = (url = 'http://x/api/private-governance/s3', init: RequestInit = {}) =>
  new Request(url, { headers: { cookie: 'awsops_token=t', ...(init.headers ?? {}) }, ...init });

beforeEach(() => {
  verifyUser.mockReset();
  isAdmin.mockReset();
  listS3GovernanceRecords.mockReset().mockResolvedValue({ rows: [], total: 0, limit: 100, offset: 0 });
  getS3GovernanceRecord.mockReset().mockResolvedValue(null);
  updateS3GovernanceRecord.mockReset().mockResolvedValue(true);
  seedS3GovernanceRecordsFromInventory.mockReset().mockResolvedValue({ scanned: 1, created: 1, skipped: 0 });
});

describe('GET /api/private-governance/s3', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');

    const res = await GET(req() as never);

    expect(res.status).toBe(401);
    expect(listS3GovernanceRecords).not.toHaveBeenCalled();
  });

  it('passes parsed filters to the S3 governance repository', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');

    const res = await GET(req('http://x/api/private-governance/s3?accountId=123456789012&active=false&piiRetentionAware=unknown&limit=25') as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBe(0);
    expect(listS3GovernanceRecords).toHaveBeenCalledWith({
      accountId: '123456789012',
      phase: undefined,
      ownerTeam: undefined,
      active: false,
      containsPersonalInfo: undefined,
      piiRetentionAware: null,
      piiRetentionApplied: undefined,
      q: undefined,
      limit: 25,
      offset: undefined,
    });
  });

  it('exports a CSV response when action=export', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listS3GovernanceRecords.mockResolvedValue({
      rows: [{
        stableKey: '123456789012:logs',
        accountId: '123456789012',
        accountName: 'core',
        phase: 'prod',
        bucketName: 'logs',
        ownerTeam: 'security',
        purpose: '=sensitive',
        history: '',
        containsPersonalInfo: true,
        piiRetentionAware: true,
        piiRetentionApplied: false,
        piiRetentionPeriod: '3y',
        remarks: '',
        updatedBy: 'tester',
        updatedAt: '',
        createdAt: '',
        assetRegion: 'ap-northeast-2',
        assetCapturedAt: '2026-07-29T00:00:00.000Z',
        assetData: null,
        active: true,
      }],
      total: 1,
      limit: 100,
      offset: 0,
    });
    const { GET } = await import('./route');

    const res = await GET(req('http://x/api/private-governance/s3?action=export') as never);
    const text = await res.text();

    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(text).toContain('123456789012');
    expect(text).toContain("'=sensitive");
  });
});

describe('POST /api/private-governance/s3', () => {
  it('requires an admin user', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');

    const res = await POST(req('http://x/api/private-governance/s3', {
      method: 'POST',
      body: JSON.stringify({ accountId: '123456789012', bucketName: 'logs' }),
    }) as never);

    expect(res.status).toBe(403);
    expect(updateS3GovernanceRecord).not.toHaveBeenCalled();
  });

  it('seeds records from inventory', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    const { POST } = await import('./route');

    const res = await POST(req('http://x/api/private-governance/s3?action=seed-from-inventory', {
      method: 'POST',
      body: JSON.stringify({ accountId: '123456789012', updatedBy: 'operator' }),
    }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.summary.created).toBe(1);
    expect(seedS3GovernanceRecordsFromInventory).toHaveBeenCalledWith({
      accountId: '123456789012',
      updatedBy: 'operator',
    });
  });

  it('updates a governance record and returns the detail', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    getS3GovernanceRecord.mockResolvedValue({ stableKey: '123456789012:logs' });
    const { POST } = await import('./route');

    const res = await POST(req('http://x/api/private-governance/s3', {
      method: 'POST',
      body: JSON.stringify({
        accountId: '123456789012',
        bucketName: 'logs',
        containsPersonalInfo: 'true',
      }),
    }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(updateS3GovernanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      accountId: '123456789012',
      bucketName: 'logs',
      containsPersonalInfo: true,
      updatedBy: 'awsops-ui',
    }));
    expect(body.record.stableKey).toBe('123456789012:logs');
  });
});
