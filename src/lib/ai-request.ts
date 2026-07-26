export const MAX_AI_BODY_BYTES = 512_000;
export const MAX_AI_MESSAGES = 50;
export const MAX_AI_MESSAGE_CHARS = 50_000;
export const MAX_AI_TOTAL_MESSAGE_CHARS = 200_000;

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequestBody {
  messages: AiChatMessage[];
  model?: string;
  stream: boolean;
  lang?: string;
  accountId?: string;
}

export class AiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AiRequestError';
  }
}

export async function parseAiRequest(request: Request): Promise<AiRequestBody> {
  const rawBody = await readJsonBounded(request);
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new AiRequestError('Invalid JSON body', 400);
  }

  const body = rawBody as Record<string, unknown>;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AiRequestError('Messages required', 400);
  }
  if (body.messages.length > MAX_AI_MESSAGES) {
    throw new AiRequestError(`Too many messages; maximum is ${MAX_AI_MESSAGES}`, 413);
  }

  let totalChars = 0;
  const messages = body.messages.map((message, index): AiChatMessage => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new AiRequestError(`Invalid message at index ${index}`, 400);
    }
    const value = message as Record<string, unknown>;
    if ((value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') {
      throw new AiRequestError(`Invalid message at index ${index}`, 400);
    }
    if (value.content.length > MAX_AI_MESSAGE_CHARS) {
      throw new AiRequestError(`Message at index ${index} is too large`, 413);
    }
    totalChars += value.content.length;
    if (totalChars > MAX_AI_TOTAL_MESSAGE_CHARS) {
      throw new AiRequestError('Combined message content is too large', 413);
    }
    return { role: value.role, content: value.content };
  });

  return {
    messages,
    model: stringValue(body.model),
    stream: body.stream === true,
    lang: stringValue(body.lang),
    accountId: stringValue(body.accountId),
  };
}

async function readJsonBounded(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_AI_BODY_BYTES) {
    throw new AiRequestError('Request body too large', 413);
  }

  if (!request.body) {
    throw new AiRequestError('Invalid JSON body', 400);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_AI_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new AiRequestError('Request body too large', 413);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new AiRequestError('Invalid JSON body', 400);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
