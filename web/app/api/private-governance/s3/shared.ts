import type { S3GovernanceFilters, S3GovernanceRow, S3GovernanceUpdateInput } from '@/lib/private-governance/s3-governance';

const ACCOUNT_ID_RE = /^\d{12}$/;

export function parseListFilters(searchParams: URLSearchParams):
  { value: S3GovernanceFilters; action?: string; error?: undefined } | { error: string; value?: undefined; action?: undefined } {
  const booleanParams = parseBooleanParams(searchParams, [
    'active',
    'containsPersonalInfo',
    'piiRetentionAware',
    'piiRetentionApplied',
  ]);
  if (booleanParams.error) return { error: booleanParams.error };

  return {
    action: optionalString(searchParams.get('action')),
    value: {
      accountId: optionalString(searchParams.get('accountId')),
      phase: optionalString(searchParams.get('phase')),
      ownerTeam: optionalString(searchParams.get('ownerTeam')),
      active: booleanParams.values.active ?? undefined,
      containsPersonalInfo: booleanParams.values.containsPersonalInfo,
      piiRetentionAware: booleanParams.values.piiRetentionAware,
      piiRetentionApplied: booleanParams.values.piiRetentionApplied,
      q: optionalString(searchParams.get('q')),
      limit: optionalNumber(searchParams.get('limit')),
      offset: optionalNumber(searchParams.get('offset')),
    },
  };
}

export function parseS3GovernanceUpdateBody(
  body: Record<string, unknown>,
  identity?: { accountId: string; bucketName: string },
): { value: S3GovernanceUpdateInput; error?: undefined } | { error: string; value?: undefined } {
  const accountId = identity?.accountId ?? optionalString(body.accountId);
  const bucketName = identity?.bucketName ?? optionalString(body.bucketName);
  if (!accountId) return { error: 'accountId is required' };
  if (!ACCOUNT_ID_RE.test(accountId)) return { error: 'accountId must be a 12-digit AWS account ID' };
  if (!bucketName) return { error: 'bucketName is required' };
  if (identity && optionalString(body.accountId) && optionalString(body.accountId) !== accountId) {
    return { error: 'accountId cannot be changed' };
  }
  if (identity && optionalString(body.bucketName) && optionalString(body.bucketName) !== bucketName) {
    return { error: 'bucketName cannot be changed' };
  }

  const containsPersonalInfo = parseNullableBooleanBodyField(body, 'containsPersonalInfo');
  if (containsPersonalInfo.error) return { error: containsPersonalInfo.error };
  const piiRetentionAware = parseNullableBooleanBodyField(body, 'piiRetentionAware');
  if (piiRetentionAware.error) return { error: piiRetentionAware.error };
  const piiRetentionApplied = parseNullableBooleanBodyField(body, 'piiRetentionApplied');
  if (piiRetentionApplied.error) return { error: piiRetentionApplied.error };

  return {
    value: {
      accountId,
      bucketName,
      accountName: optionalString(body.accountName),
      phase: optionalString(body.phase),
      ownerTeam: optionalString(body.ownerTeam),
      purpose: optionalString(body.purpose),
      history: optionalString(body.history),
      containsPersonalInfo: containsPersonalInfo.value,
      piiRetentionAware: piiRetentionAware.value,
      piiRetentionApplied: piiRetentionApplied.value,
      piiRetentionPeriod: optionalString(body.piiRetentionPeriod),
      remarks: optionalString(body.remarks),
      updatedBy: optionalString(body.updatedBy) ?? 'awsops-ui',
    },
  };
}

export function parseStableKey(stableKey: string): { accountId: string; bucketName: string } | null {
  const separator = stableKey.indexOf(':');
  if (separator <= 0 || separator === stableKey.length - 1) return null;
  const accountId = stableKey.slice(0, separator).trim();
  const bucketName = stableKey.slice(separator + 1).trim();
  if (!ACCOUNT_ID_RE.test(accountId) || !bucketName) return null;
  return { accountId, bucketName };
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}

export function toCsv(rows: S3GovernanceRow[]): string {
  const headers = [
    'account name',
    'accountid',
    'phase',
    'bucketname',
    '담당조직',
    '용도',
    '이력',
    '데이터 개인정보 유무 여부',
    '개인정보 데이터 유효기간 인지여부',
    '개인정보 데이터 유효기간 적용여부',
    '적용데이터 유효기간',
    '비고',
    'active',
    'last_seen_at',
  ];
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => [
      row.accountName,
      row.accountId,
      row.phase,
      row.bucketName,
      row.ownerTeam,
      row.purpose,
      row.history,
      formatNullableBoolean(row.containsPersonalInfo),
      formatNullableBoolean(row.piiRetentionAware),
      formatNullableBoolean(row.piiRetentionApplied),
      row.piiRetentionPeriod,
      row.remarks,
      row.active ? 'Y' : 'N',
      row.assetCapturedAt ?? '',
    ].map((value) => csvEscape(sanitizeCsvCell(value))).join(',')),
  ];
  return `${lines.join('\n')}\n`;
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNullableBooleanBodyField(
  body: Record<string, unknown>,
  key: string,
): { value: boolean | null | undefined; error?: undefined } | { error: string; value?: undefined } {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { value: undefined };
  const value = body[key];
  if (value === null || value === '' || value === 'unknown') return { value: null };
  if (value === true || value === 'true' || value === 1 || value === '1') return { value: true };
  if (value === false || value === 'false' || value === 0 || value === '0') return { value: false };
  return { error: `Invalid boolean value for ${key}` };
}

function parseBooleanParams(
  searchParams: URLSearchParams,
  names: string[],
): { values: Record<string, boolean | null | undefined>; error?: string } {
  const values: Record<string, boolean | null | undefined> = {};

  for (const name of names) {
    const value = searchParams.get(name);
    if (value === null || value.trim() === '') {
      values[name] = undefined;
      continue;
    }

    const normalized = value.toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      values[name] = true;
      continue;
    }
    if (normalized === 'false' || normalized === '0') {
      values[name] = false;
      continue;
    }
    if (normalized === 'unknown' || normalized === 'null') {
      if (name === 'active') return { values, error: 'active must be true or false' };
      values[name] = null;
      continue;
    }

    return { values, error: `${name} must be true, false, or unknown` };
  }

  return { values };
}

function formatNullableBoolean(value: boolean | null): string {
  if (value === null) return '';
  return value ? 'Y' : 'N';
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function sanitizeCsvCell(value: string): string {
  return /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
}
