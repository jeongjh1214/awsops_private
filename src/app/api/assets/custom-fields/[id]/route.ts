import { NextRequest, NextResponse } from 'next/server';
import { requireAssetAdmin, isAssetAdminAuthError } from '@/lib/assets/asset-admin';
import { openAssetDb } from '@/lib/assets/asset-db';
import { deactivateCustomField, updateCustomField } from '@/lib/assets/custom-fields';
import { getConfig } from '@/lib/app-config';

export const runtime = 'nodejs';

interface RouteContext {
  params: {
    id: string;
  };
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const id = decodeFieldId(context.params.id);
  if (!id) {
    return NextResponse.json({ error: 'Invalid custom field id' }, { status: 400 });
  }

  const authError = authorize(request);
  if (authError) return authError;

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
    const field = updateCustomField(db, id, body as Parameters<typeof updateCustomField>[2]);
    if (!field) {
      return NextResponse.json({ error: 'Custom field not found' }, { status: 404 });
    }
    return NextResponse.json({ field });
  } catch (error) {
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const id = decodeFieldId(context.params.id);
  if (!id) {
    return NextResponse.json({ error: 'Invalid custom field id' }, { status: 400 });
  }

  const authError = authorize(request);
  if (authError) return authError;

  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    const field = deactivateCustomField(db, id, request.headers.get('x-awsops-asset-admin-user') || 'admin');
    if (!field) {
      return NextResponse.json({ error: 'Custom field not found' }, { status: 404 });
    }
    return NextResponse.json({ field });
  } finally {
    db.close();
  }
}

function authorize(request: NextRequest): NextResponse | null {
  try {
    requireAssetAdmin(request.headers);
    return null;
  } catch (error) {
    if (isAssetAdminAuthError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    throw error;
  }
}

function decodeFieldId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}
