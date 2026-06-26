export interface OrganizationApiRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  concurrency: number;
  timeoutMs: number;
  retryCount: number;
}

export interface OrganizationPosition {
  displayName: string;
  orgCode: string;
  orgName: string;
  raw: unknown;
  error?: string;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function fetchOrganizationPositionsForUsers(
  displayNames: string[],
  config: OrganizationApiRuntimeConfig,
  fetcher: FetchLike = fetch as FetchLike,
): Promise<Map<string, OrganizationPosition>> {
  const positions = new Map<string, OrganizationPosition>();
  if (displayNames.length === 0) {
    return positions;
  }

  let nextIndex = 0;
  const workerCount = Math.max(
    1,
    Math.min(displayNames.length, Math.floor(config.concurrency) || 1),
  );

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= displayNames.length) {
        return;
      }

      const displayName = displayNames[index];
      positions.set(displayName, await fetchOrganizationPosition(displayName, config, fetcher));
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return positions;
}

export function parseOrganizationPosition(displayName: string, raw: unknown): OrganizationPosition {
  const mainPosition = readMainPosition(raw);

  return {
    displayName,
    orgCode: readString(mainPosition, 'orgCode'),
    orgName: readString(mainPosition, 'orgName'),
    raw,
  };
}

async function fetchOrganizationPosition(
  displayName: string,
  config: OrganizationApiRuntimeConfig,
  fetcher: FetchLike,
): Promise<OrganizationPosition> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
    try {
      const raw = await fetchOrganizationPositionRaw(displayName, config, fetcher);
      return parseOrganizationPosition(displayName, raw);
    } catch (error) {
      lastError = error;
    }
  }

  return {
    displayName,
    orgCode: '',
    orgName: '',
    raw: null,
    error: toErrorMessage(lastError),
  };
}

async function fetchOrganizationPositionRaw(
  displayName: string,
  config: OrganizationApiRuntimeConfig,
  fetcher: FetchLike,
): Promise<unknown> {
  const controller = typeof AbortController !== 'undefined'
    ? new AbortController()
    : undefined;
  const timeoutId = controller && config.timeoutMs > 0
    ? setTimeout(() => controller.abort(), config.timeoutMs)
    : undefined;

  try {
    const response = await fetcher(buildOrganizationUrl(config.baseUrl, displayName), {
      headers: {
        'X-API-Key': config.apiKey,
      },
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (!response.ok) {
      throw new Error(`Organization API request failed with status ${response.status}`);
    }

    return await response.json();
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function buildOrganizationUrl(baseUrl: string, displayName: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(displayName)}`;
}

function readMainPosition(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    return {};
  }

  const data = raw.data;
  if (!isRecord(data)) {
    return {};
  }

  const mainPosition = data.mainPosition;
  return isRecord(mainPosition) ? mainPosition : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === 'string' && error.length > 0) {
    return error;
  }

  return 'Organization API request failed';
}
