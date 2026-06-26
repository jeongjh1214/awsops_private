import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-identity-audit-config-'));
const configPath = resolve('data/config.json');
const hadConfig = existsSync(configPath);
const previousConfig = hadConfig ? readFileSync(configPath, 'utf8') : undefined;
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

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    activeEnvironment: 'local',
    environments: {
      local: {
        networkMode: 'external-explicit-vpce',
        endpointMode: 'explicit',
        bedrockProfile: 'bedrock-local-profile',
        awsProfile: 'awsops-local-profile',
        identityCenterProfile: 'identity-center-local-profile',
        endpointUrls: {
          identitystore: 'https://vpce-identitystore.example',
          'sso-admin': 'https://vpce-sso-admin.example',
          sts: 'https://vpce-sts.example',
        },
      },
    },
    identityAudit: {
      enabled: true,
      awsProfile: 'identity-audit-profile',
      organizationApi: {
        apiKeyEnv: 'KREW_API_KEY',
        concurrency: 7,
      },
    },
  }, null, 2), 'utf8');

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
  if (hadConfig) {
    writeFileSync(configPath, previousConfig, 'utf8');
  } else {
    rmSync(configPath, { force: true });
  }
  rmSync(outDir, { recursive: true, force: true });
}
