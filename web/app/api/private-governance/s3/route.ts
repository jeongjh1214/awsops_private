import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { BodyTooLargeError, readJsonBounded } from '@/lib/http-body';
import {
  getS3GovernanceRecord,
  listS3GovernanceRecords,
  makeS3GovernanceStableKey,
  seedS3GovernanceRecordsFromInventory,
  updateS3GovernanceRecord,
} from '@/lib/private-governance/s3-governance';
import { optionalString, parseListFilters, parseS3GovernanceUpdateBody, toCsv } from './shared';

export const dynamic = 'force-dynamic';

const err = (message: string, status: number) => NextResponse.json({ message }, { status });

export async function GET(request: NextRequest) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);

  const parsed = parseListFilters(new URL(request.url).searchParams);
  if (parsed.error) return err(parsed.error, 400);

  try {
    const result = await listS3GovernanceRecords(parsed.value);
    if (parsed.action === 'export') {
      return new NextResponse(toCsv(result.rows), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="awsops-s3-governance.csv"',
        },
      });
    }
    return NextResponse.json(result);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error), 500);
  }
}

export async function POST(request: NextRequest) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);

  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonBounded(request);
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof BodyTooLargeError) return err('request body too large', 413);
    return err('invalid JSON', 400);
  }

  const action = optionalString(new URL(request.url).searchParams.get('action')) ?? optionalString(body.action);
  if (action === 'seed-from-inventory') {
    const accountId = optionalString(body.accountId);
    if (accountId && !/^\d{12}$/.test(accountId)) return err('accountId must be a 12-digit AWS account ID', 400);
    try {
      const summary = await seedS3GovernanceRecordsFromInventory({
        accountId,
        updatedBy: optionalString(body.updatedBy) ?? 'awsops-ui',
      });
      return NextResponse.json({ ok: true, summary });
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error), 500);
    }
  }

  const input = parseS3GovernanceUpdateBody(body);
  if (!input.value) return err(input.error ?? 'invalid request', 400);

  try {
    const ok = await updateS3GovernanceRecord(input.value);
    if (!ok) return err('accountId and bucketName are required', 400);
    const stableKey = makeS3GovernanceStableKey(input.value.accountId, input.value.bucketName);
    return NextResponse.json({ ok: true, record: await getS3GovernanceRecord(stableKey) });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error), 500);
  }
}
