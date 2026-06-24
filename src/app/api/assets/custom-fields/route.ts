import { NextRequest, NextResponse } from 'next/server';
import { requireAssetAdmin, isAssetAdminAuthError } from '@/lib/assets/asset-admin';
import { openAssetDb } from '@/lib/assets/asset-db';
import { createCustomField, listCustomFields } from '@/lib/assets/custom-fields';
import { getConfig } from '@/lib/app-config';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const includeInactive = parseBoolean(searchParams.get('includeInactive')) ?? false;

  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    return NextResponse.json({ fields: listCustomFields(db, includeInactive) });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  try {
    requireAssetAdmin(request.headers);
  } catch (error) {
    if (isAssetAdminAuthError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    const field = createCustomField(db, body as Parameters<typeof createCustomField>[1]);
    return NextResponse.json({ field }, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  } finally {
    db.close();
  }
}

function parseBoolean(value: string | null): boolean | undefined {
  if (value === null || value.trim() === '') return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}
