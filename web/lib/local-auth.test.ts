import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'awsops-local-auth-'));
  process.env.AWSOPS_CONFIG = join(tempDir, 'config.json');
  process.env.AWSOPS_LOCAL_AUTH_SECRET = 'test-local-secret';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.AWSOPS_CONFIG;
  delete process.env.AWSOPS_LOCAL_AUTH_SECRET;
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(overrides: Record<string, unknown> = {}) {
  writeFileSync(
    process.env.AWSOPS_CONFIG!,
    JSON.stringify({
      activeEnvironment: 'local',
      agent: { provider: 'local-mcp-langgraph' },
      environments: {},
      localAuth: {
        enabled: true,
        email: 'local@awsops.internal',
        password: 'local-password',
        groups: ['admins', 'operators'],
        ...overrides,
      },
    }),
  );
}

describe('local auth', () => {
  it('issues and verifies a local-only id token', async () => {
    writeConfig();
    const { authenticateLocalUser, verifyLocalUserToken } = await import('./local-auth');

    const auth = await authenticateLocalUser('LOCAL@awsops.internal', 'local-password');
    expect(auth?.idToken).toMatch(/^local\./);

    const user = await verifyLocalUserToken(auth!.idToken);
    expect(user).toEqual({
      sub: 'local:local@awsops.internal',
      email: 'local@awsops.internal',
      groups: ['admins', 'operators'],
    });
  });

  it('is disabled outside the local runtime environment', async () => {
    writeConfig();
    const raw = JSON.parse(readFileSync(process.env.AWSOPS_CONFIG!, 'utf8'));
    raw.activeEnvironment = 'prod';
    writeFileSync(process.env.AWSOPS_CONFIG!, JSON.stringify(raw));

    const { authenticateLocalUser, isLocalAuthConfigured } = await import('./local-auth');
    expect(isLocalAuthConfigured()).toBe(false);
    expect(await authenticateLocalUser('local@awsops.internal', 'local-password')).toBeNull();
  });

  it('lets login use local auth without calling Cognito', async () => {
    writeConfig();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { initiateAuth } = await import('./login');
    const result = await initiateAuth('local@awsops.internal', 'local-password');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.idToken).toMatch(/^local\./);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await initiateAuth('local@awsops.internal', 'wrong')).toEqual({
      ok: false,
      code: 'invalid_credentials',
    });
  });

  it('lets verifyUser accept the local auth cookie', async () => {
    writeConfig();
    const { authenticateLocalUser } = await import('./local-auth');
    const { verifyUser } = await import('./auth');

    const auth = await authenticateLocalUser('local@awsops.internal', 'local-password');
    await expect(verifyUser(`awsops_token=${auth!.idToken}`)).resolves.toMatchObject({
      sub: 'local:local@awsops.internal',
      email: 'local@awsops.internal',
      groups: ['admins', 'operators'],
    });
  });
});
