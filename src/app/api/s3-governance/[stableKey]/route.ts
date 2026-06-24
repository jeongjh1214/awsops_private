import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/app-config';
import { openAssetDb } from '@/lib/assets/asset-db';
import {
  getS3GovernanceRecord,
  updateS3GovernanceRecord,
  type S3GovernanceUpdateInput,
} from '@/lib/assets/s3-governance';

export const runtime = 'nodejs';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ stableKey: string }> },
) {
  const params = await context.params;
  const stableKey = decodeURIComponent(params.stableKey);
  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    const detail = getS3GovernanceRecord(db, stableKey);
    if (!detail) {
      return NextResponse.json({ error: 'S3 governance record not found' }, { status: 404 });
    }
    return NextResponse.json(detail);
  } finally {
    db.close();
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ stableKey: string }> },
) {
  const params = await context.params;
  const stableKey = decodeURIComponent(params.stableKey);
  const identity = parseStableKey(stableKey);
  if (!identity) {
    return NextResponse.json({ error: 'stableKey must be accountId:bucketName' }, { status: 400 });
  }

  const body = await readJsonBody(request);
  const input = parseUpdateBody(body, identity.accountId, identity.bucketName);
  if ('error' in input) {
    return NextResponse.json({ error: input.error }, { status: 400 });
  }

  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    updateS3GovernanceRecord(db, input.value);
    return NextResponse.json(getS3GovernanceRecord(db, stableKey));
  } finally {
    db.close();
  }
}

function parseStableKey(stableKey: string): { accountId: string; bucketName: string } | null {
  const separator = stableKey.indexOf(':');
  if (separator <= 0 || separator === stableKey.length - 1) return null;
  const accountId = stableKey.slice(0, separator);
  const bucketName = stableKey.slice(separator + 1);
  if (!/^\d{12}$/.test(accountId) || !bucketName) return null;
  return { accountId, bucketName };
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

function parseUpdateBody(
  body: Record<string, unknown>,
  accountId: string,
  bucketName: string,
): { value: S3GovernanceUpdateInput; error?: undefined } | { error: string; value?: undefined } {
  if (optionalString(body.accountId) && optionalString(body.accountId) !== accountId) {
    return { error: 'accountId cannot be changed' };
  }
  if (optionalString(body.bucketName) && optionalString(body.bucketName) !== bucketName) {
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

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}
