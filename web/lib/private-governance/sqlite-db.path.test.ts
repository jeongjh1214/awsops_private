import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolvePrivateSqlitePath } from './sqlite-db';

const originalCwd = process.cwd();
const originalConfig = process.env.AWSOPS_CONFIG;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalConfig === undefined) delete process.env.AWSOPS_CONFIG;
  else process.env.AWSOPS_CONFIG = originalConfig;
});

describe('resolvePrivateSqlitePath', () => {
  it('resolves data sqlite paths relative to the repo root even when Next runs from web', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awsops-sqlite-path-'));
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(join(dir, 'web'), { recursive: true });
    writeFileSync(join(dir, 'data/config.json'), JSON.stringify({
      activeEnvironment: 'local',
      assetInventory: { sqlitePath: 'data/awsops.db' },
    }));
    process.env.AWSOPS_CONFIG = join(dir, 'data/config.json');
    process.chdir(join(dir, 'web'));

    try {
      expect(resolvePrivateSqlitePath()).toBe(join(dir, 'data/awsops.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
