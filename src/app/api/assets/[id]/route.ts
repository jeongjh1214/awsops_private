import { NextRequest, NextResponse } from 'next/server';
import { openAssetDb } from '@/lib/assets/asset-db';
import {
  getAssetDetail,
  updateAssetMetadata,
  type AssetMetadataUpdateInput,
} from '@/lib/assets/asset-repository';
import { getConfig } from '@/lib/app-config';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{
    id: string;
  }>;
}

const STRING_FIELDS = [
  'ownerTeam',
  'ownerPerson',
  'businessSystem',
  'moduleName',
  'phase',
  'purpose',
  'criticality',
  'securityGrade',
  'costCenter',
  'remarks',
  'updatedBy',
] as const;

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const assetId = decodeAssetId(id);
  if (!assetId) {
    return NextResponse.json({ error: 'Invalid asset id' }, { status: 400 });
  }

  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    const detail = getAssetDetail(db, assetId);
    if (!detail) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }
    return NextResponse.json(detail);
  } finally {
    db.close();
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const assetId = decodeAssetId(id);
  if (!assetId) {
    return NextResponse.json({ error: 'Invalid asset id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = parseMetadataUpdateBody(body);
  if (parsed.error) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    const updated = updateAssetMetadata(db, assetId, parsed.input);
    if (!updated) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }

    const detail = getAssetDetail(db, assetId);
    return NextResponse.json(detail);
  } finally {
    db.close();
  }
}

function decodeAssetId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

function parseMetadataUpdateBody(body: unknown): { input: AssetMetadataUpdateInput; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { input: {}, error: 'Body must be an object' };
  }

  const record = body as Record<string, unknown>;
  const input: AssetMetadataUpdateInput = {};

  for (const field of STRING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    if (record[field] !== undefined && typeof record[field] !== 'string') {
      return { input: {}, error: `${field} must be a string` };
    }
    input[field] = record[field] as string | undefined;
  }

  if (Object.prototype.hasOwnProperty.call(record, 'containsPersonalInfo')) {
    const value = record.containsPersonalInfo;
    if (value !== null && typeof value !== 'boolean') {
      return { input: {}, error: 'containsPersonalInfo must be boolean or null' };
    }
    input.containsPersonalInfo = value;
  }

  return { input };
}
