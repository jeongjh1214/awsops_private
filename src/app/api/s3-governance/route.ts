import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/app-config';
import { openAssetDb } from '@/lib/assets/asset-db';
import {
  listS3GovernanceRecords,
  getS3GovernanceRecord,
  makeS3GovernanceStableKey,
  seedS3GovernanceRecordsFromAssets,
  updateS3GovernanceRecord,
  type S3GovernanceFilters,
  type S3GovernanceRow,
  type S3GovernanceUpdateInput,
} from '@/lib/assets/s3-governance';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const booleanParams = parseBooleanParams(searchParams, [
    'active',
    'containsPersonalInfo',
    'piiRetentionAware',
    'piiRetentionApplied',
  ]);
  if (booleanParams.error) {
    return NextResponse.json({ error: booleanParams.error }, { status: 400 });
  }

  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    const filters: S3GovernanceFilters = {
      accountId: optionalString(searchParams.get('accountId')),
      phase: optionalString(searchParams.get('phase')),
      ownerTeam: optionalString(searchParams.get('ownerTeam')),
      active: booleanParams.values.active,
      containsPersonalInfo: booleanParams.values.containsPersonalInfo,
      piiRetentionAware: booleanParams.values.piiRetentionAware,
      piiRetentionApplied: booleanParams.values.piiRetentionApplied,
      q: optionalString(searchParams.get('q')),
      limit: optionalNumber(searchParams.get('limit')),
      offset: optionalNumber(searchParams.get('offset')),
    };

    const result = listS3GovernanceRecords(db, filters);
    if (optionalString(searchParams.get('action')) === 'export') {
      return new NextResponse(toCsv(result.rows), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="awsops-s3-governance.csv"',
        },
      });
    }

    return NextResponse.json(result);
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody(request);
  const { searchParams } = new URL(request.url);
  const action = optionalString(searchParams.get('action')) ?? optionalString(body.action);

  if (action === 'seed-from-assets') {
    const accountId = optionalString(body.accountId);
    if (accountId && !/^\d{12}$/.test(accountId)) {
      return NextResponse.json({ error: 'accountId must be a 12-digit AWS account ID' }, { status: 400 });
    }

    const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
    try {
      const summary = seedS3GovernanceRecordsFromAssets(db, {
        accountId,
        updatedBy: optionalString(body.updatedBy) ?? 'awsops-ui',
      });
      return NextResponse.json({ ok: true, summary });
    } finally {
      db.close();
    }
  }

  const input = parseS3GovernanceUpdateBody(body);
  if ('error' in input) {
    return NextResponse.json({ error: input.error }, { status: 400 });
  }

  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    const ok = updateS3GovernanceRecord(db, input.value);
    if (!ok) {
      return NextResponse.json({ error: 'accountId and bucketName are required' }, { status: 400 });
    }
    const stableKey = makeS3GovernanceStableKey(input.value.accountId, input.value.bucketName);
    return NextResponse.json({ ok: true, record: getS3GovernanceRecord(db, stableKey) });
  } finally {
    db.close();
  }
}

async function readJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseS3GovernanceUpdateBody(
  body: Record<string, unknown>,
): { value: S3GovernanceUpdateInput; error?: undefined } | { error: string; value?: undefined } {
  const accountId = optionalString(body.accountId);
  const bucketName = optionalString(body.bucketName);
  if (!accountId) return { error: 'accountId is required' };
  if (!/^\d{12}$/.test(accountId)) return { error: 'accountId must be a 12-digit AWS account ID' };
  if (!bucketName) return { error: 'bucketName is required' };

  const containsPersonalInfo = parseNullableBooleanBodyField(body, 'containsPersonalInfo');
  if (containsPersonalInfo.error) return { error: containsPersonalInfo.error };
  const piiRetentionAware = parseNullableBooleanBodyField(body, 'piiRetentionAware');
  if (piiRetentionAware.error) return { error: piiRetentionAware.error };
  const piiRetentionApplied = parseNullableBooleanBodyField(body, 'piiRetentionApplied');
  if (piiRetentionApplied.error) return { error: piiRetentionApplied.error };

  const input: S3GovernanceUpdateInput = {
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
  };

  return { value: input };
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
): { values: Record<string, boolean | undefined>; error?: string } {
  const values: Record<string, boolean | undefined> = {};

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

    return { values, error: `${name} must be true or false` };
  }

  return { values };
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toCsv(rows: S3GovernanceRow[]): string {
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
  const keys: Array<keyof S3GovernanceRow> = [
    'account_name',
    'account_id',
    'phase',
    'bucket_name',
    'owner_team',
    'purpose',
    'history',
    'contains_personal_info',
    'pii_retention_aware',
    'pii_retention_applied',
    'pii_retention_period',
    'remarks',
    'asset_is_active',
    'asset_last_seen_at',
  ];

  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => keys.map((key) => csvEscape(sanitizeCsvCell(formatCsvValue(row[key])))).join(',')),
  ];
  return `${lines.join('\n')}\n`;
}

function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value === 1) return 'Y';
  if (value === 0) return 'N';
  return String(value);
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function sanitizeCsvCell(value: string): string {
  return /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
}
