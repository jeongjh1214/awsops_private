import { afterEach, describe, expect, it, vi } from 'vitest';

const createLocalSqlitePool = vi.fn();

vi.mock('./local-sqlite-pool', () => ({
  createLocalSqlitePool: () => createLocalSqlitePool(),
}));

afterEach(() => {
  createLocalSqlitePool.mockReset();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('getPool', () => {
  it('uses the local SQLite pool when local config has no Aurora endpoint', async () => {
    vi.stubEnv('AWSOPS_LOCAL_DB_PROVIDER', 'sqlite');
    vi.stubEnv('AURORA_ENDPOINT', '');
    vi.stubEnv('DATABASE_URL', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sqlitePool = {
      query: vi.fn(async () => ({ rows: [{ n: 1 }], rowCount: 1 })),
      connect: vi.fn(),
    };
    createLocalSqlitePool.mockReturnValue(sqlitePool);

    const { getPool } = await import('./db');
    const pool = getPool();

    expect(pool).toBe(sqlitePool);
    expect(await pool.query('SELECT count(*)::int AS n FROM inventory_resources')).toEqual({
      rows: [{ n: 1 }],
      rowCount: 1,
    });
    expect(createLocalSqlitePool).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[db] AURORA_ENDPOINT is not set; using local SQLite DB pool',
    );
  });
});
