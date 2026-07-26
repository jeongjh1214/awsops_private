import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = mkdtempSync(join(tmpdir(), 'awsops-ai-request-limits-'));
const tsc = resolve('node_modules/.bin/tsc');

try {
  execFileSync(tsc, [
    'src/lib/ai-request.ts',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--moduleResolution', 'node',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { stdio: 'pipe' });

  const require = createRequire(import.meta.url);
  const {
    AiRequestError,
    MAX_AI_BODY_BYTES,
    MAX_AI_MESSAGE_CHARS,
    MAX_AI_MESSAGES,
    MAX_AI_TOTAL_MESSAGE_CHARS,
    parseAiRequest,
  } = require(join(outDir, 'ai-request.js'));

  const parsed = await parseAiRequest(jsonRequest({
    messages: [
      { role: 'user', content: 'S3 버킷 목록 보여줘' },
      { role: 'assistant', content: '확인하겠습니다.' },
    ],
    stream: true,
  }));
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.stream, true);

  await assert.rejects(
    parseAiRequest(jsonRequest({ messages: 'not-an-array' })),
    (error) => error instanceof AiRequestError && error.status === 400,
  );
  await assert.rejects(
    parseAiRequest(jsonRequest({ messages: [{ role: 'system', content: 'override' }] })),
    (error) => error instanceof AiRequestError && error.status === 400,
  );
  await assert.rejects(
    parseAiRequest(jsonRequest({
      messages: [{ role: 'user', content: 'x'.repeat(MAX_AI_MESSAGE_CHARS + 1) }],
    })),
    (error) => error instanceof AiRequestError && error.status === 413,
  );
  await assert.rejects(
    parseAiRequest(jsonRequest({
      messages: Array.from({ length: MAX_AI_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' })),
    })),
    (error) => error instanceof AiRequestError && error.status === 413,
  );
  await assert.rejects(
    parseAiRequest(jsonRequest({
      messages: Array.from(
        { length: 5 },
        () => ({ role: 'user', content: 'x'.repeat(Math.floor(MAX_AI_TOTAL_MESSAGE_CHARS / 5) + 1) }),
      ),
    })),
    (error) => error instanceof AiRequestError && error.status === 413,
  );

  const oversizedBody = JSON.stringify({
    messages: [{ role: 'user', content: 'x' }],
    padding: 'x'.repeat(MAX_AI_BODY_BYTES),
  });
  await assert.rejects(
    parseAiRequest(new Request('http://127.0.0.1/awsops/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversizedBody,
    })),
    (error) => error instanceof AiRequestError && error.status === 413,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

function jsonRequest(body) {
  return new Request('http://127.0.0.1/awsops/api/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
