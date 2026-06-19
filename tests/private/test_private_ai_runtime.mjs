import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-private-ai-runtime-'));
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
    'src/lib/private-ai-runtime.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const runtime = require(join(outDir, 'private-ai-runtime.js'));

  assert.equal(
    runtime.shouldDelegateRouteToLocalPrivateAgent('local-mcp-langgraph', { handler: 'sql' }),
    false,
    'private mode must keep Steampipe SQL routes inside the Next API',
  );
  assert.equal(
    runtime.shouldDelegateRouteToLocalPrivateAgent('local-mcp-langgraph', { handler: 'auto-collect' }),
    false,
    'private mode must keep auto-collect routes inside the Next API',
  );
  assert.equal(
    runtime.shouldDelegateRouteToLocalPrivateAgent('local-mcp-langgraph', { gateway: 'network' }),
    true,
    'private mode may delegate AgentCore-only routes to the local private agent',
  );
  assert.equal(
    runtime.shouldDelegateRouteToLocalPrivateAgent('agentcore', { handler: 'sql' }),
    false,
    'agentcore mode must not delegate to the local private agent',
  );

  const context = runtime.getPrivateBedrockRuntimeContext({
    activeEnvironment: 'local',
    environments: {
      local: {
        endpointMode: 'explicit',
        bedrockProfile: 'bedrock-local-profile',
        endpointUrls: {
          'bedrock-runtime': 'https://vpce-123.bedrock-runtime.ap-northeast-2.vpce.amazonaws.com',
        },
      },
    },
    agent: {
      modelId: 'arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/example',
    },
  });

  assert.equal(context.profile, 'bedrock-local-profile');
  assert.equal(context.endpointUrl, 'https://vpce-123.bedrock-runtime.ap-northeast-2.vpce.amazonaws.com');
  assert.equal(context.modelId, 'arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/example');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
