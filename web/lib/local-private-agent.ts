import type { AgentEvent, InvokeInput } from './agentcore';
import { getPrivateRuntimeConfig } from './private-runtime-config';

interface SseFrame {
  event?: string;
  data?: string;
}

export async function* invokeLocalPrivateAgentStream(
  input: InvokeInput,
  opts: { abortSignal?: AbortSignal } = {},
): AsyncGenerator<AgentEvent> {
  const config = getPrivateRuntimeConfig();
  const baseUrl = config.agent.langgraphApiUrl.replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: input.messages,
      accountId: input.accountId,
      route: input.gateway,
      model: config.agent.modelId,
      extraContext: input.extraContext,
    }),
    signal: opts.abortSignal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`local private agent failed: HTTP ${response.status}`);
  }

  for await (const frame of readSseFrames(response.body)) {
    if (!frame.data) continue;
    const parsed = parseJson(frame.data);
    if (frame.event === 'error') {
      const message = typeof parsed?.error === 'string' ? parsed.error : frame.data;
      throw new Error(message);
    }
    if (typeof parsed?.delta === 'string') yield { delta: parsed.delta };
    if (typeof parsed?.content === 'string' && frame.event === 'done') yield { model: config.agent.modelId };
    if (typeof parsed?.model === 'string') yield { model: parsed.model };
    if (typeof parsed?.inputTokens === 'number' && typeof parsed?.outputTokens === 'number') {
      yield { usage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens } };
    }
  }
}

async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        yield parseFrame(raw);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield parseFrame(buffer);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseFrame(raw: string): SseFrame {
  const frame: SseFrame = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) frame.event = line.slice(6).trim();
    if (line.startsWith('data:')) frame.data = `${frame.data ?? ''}${line.slice(5).trim()}`;
  }
  return frame;
}

function parseJson(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
