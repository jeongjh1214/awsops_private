import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const getS3GovernanceRecord = vi.fn();
const updateS3GovernanceRecord = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/http-body', () => ({
  BodyTooLargeError: class BodyTooLargeError extends Error {},
  readJsonBounded: async (request: Request) => request.json(),
}));
vi.mock('@/lib/private-governance/s3-governance', () => ({
  makeS3GovernanceStableKey: (accountId: string, bucketName: string) => `${accountId.trim()}:${bucketName.trim()}`,
  getS3GovernanceRecord: (...a: unknown[]) => getS3GovernanceRecord(...a),
  updateS3GovernanceRecord: (...a: unknown[]) => updateS3GovernanceRecord(...a),
}));

const req = (init: RequestInit = {}) =>
  new Request('http://x/api/private-governance/s3/123456789012%3Alogs', {
    headers: { cookie: 'awsops_token=t', ...(init.headers ?? {}) },
    ...init,
  });

beforeEach(() => {
  verifyUser.mockReset();
  isAdmin.mockReset();
  getS3GovernanceRecord.mockReset().mockResolvedValue({ stableKey: '123456789012:logs' });
  updateS3GovernanceRecord.mockReset().mockResolvedValue(true);
});

describe('GET /api/private-governance/s3/[stableKey]', () => {
  it('returns 400 for an invalid stable key', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');

    const res = await GET(req() as never, { params: { stableKey: 'bad-key' } });

    expect(res.status).toBe(400);
    expect(getS3GovernanceRecord).not.toHaveBeenCalled();
  });

  it('returns the detail row for an authenticated user', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');

    const res = await GET(req() as never, { params: { stableKey: '123456789012%3Alogs' } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stableKey).toBe('123456789012:logs');
    expect(getS3GovernanceRecord).toHaveBeenCalledWith('123456789012:logs');
  });
});

describe('PATCH /api/private-governance/s3/[stableKey]', () => {
  it('rejects attempts to change the record identity', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    const { PATCH } = await import('./route');

    const res = await PATCH(req({
      method: 'PATCH',
      body: JSON.stringify({ accountId: '999999999999', ownerTeam: 'platform' }),
    }) as never, { params: { stableKey: '123456789012%3Alogs' } });

    expect(res.status).toBe(400);
    expect(updateS3GovernanceRecord).not.toHaveBeenCalled();
  });

  it('updates the detail row for an admin user', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    const { PATCH } = await import('./route');

    const res = await PATCH(req({
      method: 'PATCH',
      body: JSON.stringify({ ownerTeam: 'platform' }),
    }) as never, { params: { stableKey: '123456789012%3Alogs' } });

    expect(res.status).toBe(200);
    expect(updateS3GovernanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      accountId: '123456789012',
      bucketName: 'logs',
      ownerTeam: 'platform',
    }));
  });
});
