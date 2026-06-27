import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/app-config';
import { openAssetDb } from '@/lib/assets/asset-db';
import { runIdentityAudit } from '@/lib/identity-audit/audit-runner';
import { startIdentityAuditScheduler } from '@/lib/identity-audit/scheduler';
import {
  exportIdentityAuditFindingsCsv,
  getLatestIdentityAuditRun,
  listIdentityAuditFindings,
  listIdentityAuditRuns,
} from '@/lib/identity-audit/repository';

export const runtime = 'nodejs';

startIdentityAuditScheduler();

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const db = openAssetDb(getConfig().assetInventory?.sqlitePath);
  try {
    const runId = optionalString(searchParams.get('runId'));

    if (optionalString(searchParams.get('action')) === 'export') {
      const csv = exportIdentityAuditFindingsCsv(db, { runId });
      return new NextResponse(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="identity-audit-findings.csv"',
        },
      });
    }

    return NextResponse.json({
      latestRun: getLatestIdentityAuditRun(db) ?? null,
      runs: listIdentityAuditRuns(db, { limit: 20 }),
      findings: listIdentityAuditFindings(db, { runId, limit: 200 }),
    });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody(request);
  const action = optionalString(body.action);

  if (action !== 'run') {
    return NextResponse.json({ error: 'unsupported action' }, { status: 400 });
  }

  try {
    return NextResponse.json(await runIdentityAudit());
  } catch (error) {
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 500 });
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

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'identity audit failed';
}
