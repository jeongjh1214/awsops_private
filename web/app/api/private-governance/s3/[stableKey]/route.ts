import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { BodyTooLargeError, readJsonBounded } from '@/lib/http-body';
import {
  getS3GovernanceRecord,
  makeS3GovernanceStableKey,
  updateS3GovernanceRecord,
} from '@/lib/private-governance/s3-governance';
import { parseS3GovernanceUpdateBody, parseStableKey } from '../shared';

export const dynamic = 'force-dynamic';

const err = (message: string, status: number) => NextResponse.json({ message }, { status });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ stableKey: string }> },
) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);

  const stableKey = decodeURIComponent((await params).stableKey);
  const identity = parseStableKey(stableKey);
  if (!identity) return err('stableKey must be accountId:bucketName', 400);

  try {
    const detail = await getS3GovernanceRecord(makeS3GovernanceStableKey(identity.accountId, identity.bucketName));
    if (!detail) return err('S3 governance record not found', 404);
    return NextResponse.json(detail);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error), 500);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ stableKey: string }> },
) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);

  const stableKey = decodeURIComponent((await params).stableKey);
  const identity = parseStableKey(stableKey);
  if (!identity) return err('stableKey must be accountId:bucketName', 400);

  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonBounded(request);
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof BodyTooLargeError) return err('request body too large', 413);
    return err('invalid JSON', 400);
  }

  const input = parseS3GovernanceUpdateBody(body, identity);
  if (!input.value) return err(input.error ?? 'invalid request', 400);

  try {
    await updateS3GovernanceRecord(input.value);
    return NextResponse.json(await getS3GovernanceRecord(makeS3GovernanceStableKey(identity.accountId, identity.bucketName)));
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error), 500);
  }
}
