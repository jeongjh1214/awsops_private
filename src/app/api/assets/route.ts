import { NextRequest, NextResponse } from 'next/server';
import { exportAssetsCsv, previewAssetCsvImport, applyAssetCsvImport } from '@/lib/assets/asset-csv';
import { openAssetDb } from '@/lib/assets/asset-db';
import { listAssets, type AssetListFilters } from '@/lib/assets/asset-repository';
import { parseAssetSyncResourceTypesInput, runAssetSync } from '@/lib/assets/asset-sync';
import { getConfig } from '@/lib/app-config';
import { runQuery } from '@/lib/steampipe';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const booleanParams = parseBooleanParams(searchParams, ['active', 'metadataMissing']);
  if (booleanParams.error) {
    return NextResponse.json({ error: booleanParams.error }, { status: 400 });
  }

  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    const filters: AssetListFilters = {
      accountId: optionalString(searchParams.get('accountId')),
      region: optionalString(searchParams.get('region')),
      service: optionalString(searchParams.get('service')),
      resourceType: optionalString(searchParams.get('resourceType')),
      phase: optionalString(searchParams.get('phase')),
      ownerTeam: optionalString(searchParams.get('ownerTeam')),
      active: booleanParams.values.active,
      metadataMissing: booleanParams.values.metadataMissing,
      q: optionalString(searchParams.get('q')),
      limit: optionalNumber(searchParams.get('limit')),
      offset: optionalNumber(searchParams.get('offset')),
    };

    if (optionalString(searchParams.get('action')) === 'export') {
      const csv = exportAssetsCsv(db, filters);
      return new NextResponse(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="awsops-assets.csv"',
        },
      });
    }

    return NextResponse.json(listAssets(db, filters));
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody(request);
  const { searchParams } = new URL(request.url);
  const action = optionalString(searchParams.get('action')) ?? optionalString(body.action);

  if (action === 'sync') {
    const resourceTypesInput = parseAssetSyncResourceTypesInput(body.resourceTypes);
    if (resourceTypesInput.error) {
      return NextResponse.json({ error: resourceTypesInput.error }, { status: 400 });
    }
    const accountId = resolveSyncAccountId(body.accountId);
    if (accountId.error) {
      return NextResponse.json({ error: accountId.error }, { status: 400 });
    }

    const summary = await runAssetSync({
      resourceTypes: resourceTypesInput.resourceTypes,
      accountId: accountId.value,
      dependencies: {
        runQuery,
        getAssetInventoryConfig: () => getConfig().assetInventory,
        openAssetDb,
      },
    });

    return NextResponse.json({ ok: true, summary });
  }

  if (action === 'import-preview' || action === 'import-apply') {
    if (typeof body.csvText !== 'string') {
      return NextResponse.json({ error: 'csvText is required' }, { status: 400 });
    }

    const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
    try {
      if (action === 'import-preview') {
        return NextResponse.json(previewAssetCsvImport(db, body.csvText));
      }

      const updatedBy = optionalString(body.updatedBy) ?? 'csv-import';
      return NextResponse.json(applyAssetCsvImport(db, body.csvText, updatedBy));
    } finally {
      db.close();
    }
  }

  return NextResponse.json({ error: 'unsupported action' }, { status: 400 });
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

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value;
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveSyncAccountId(value: unknown): { value?: string; error?: string } {
  const requested = optionalString(value);
  if (requested) {
    return /^\d{12}$/.test(requested)
      ? { value: requested }
      : { error: 'accountId must be a 12-digit AWS account ID' };
  }

  const accounts = getConfig().accounts || [];
  if (accounts.length === 1 && /^\d{12}$/.test(accounts[0].accountId)) {
    return { value: accounts[0].accountId };
  }

  return {};
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
