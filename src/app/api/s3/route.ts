import { NextRequest, NextResponse } from 'next/server';
import { listS3Buckets } from '@/lib/assets/s3-sdk-sync';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const accountId = optionalAccountId(searchParams.get('accountId'));
  if (accountId.error) {
    return NextResponse.json({ error: accountId.error }, { status: 400 });
  }

  const result = await listS3Buckets({ accountId: accountId.value });
  if (result.error) {
    return NextResponse.json({
      summary: { rows: [emptySummary()] },
      list: { rows: [], error: result.error },
      publicBuckets: { rows: [] },
    });
  }

  const rows = result.rows.map((row) => normalizeS3PageRow(row));
  return NextResponse.json({
    summary: {
      rows: [{
        total_buckets: rows.length,
        public_buckets: rows.filter((row) => row.bucket_policy_is_public).length,
        versioning_enabled: rows.filter((row) => row.versioning_enabled).length,
      }],
    },
    list: { rows },
    publicBuckets: { rows: rows.filter((row) => row.bucket_policy_is_public) },
  });
}

function normalizeS3PageRow(row: Record<string, unknown>): Record<string, unknown> {
  const name = stringValue(row.name);
  return {
    account_id: stringValue(row.account_id),
    name,
    arn: stringValue(row.arn) || (name ? `arn:aws:s3:::${name}` : ''),
    region: stringValue(row.region) || 'global',
    creation_date: stringValue(row.source_updated_at) || stringValue(row.creation_date),
    versioning_enabled: false,
    bucket_policy_is_public: false,
    encryption_enabled: false,
    logging_target: '',
    tags: row.tags && typeof row.tags === 'object' ? row.tags : {},
    block_public_acls: true,
    block_public_policy: true,
    ignore_public_acls: true,
    restrict_public_buckets: true,
    server_side_encryption_configuration: null,
    logging: null,
    lifecycle_rules: null,
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function emptySummary() {
  return { total_buckets: 0, public_buckets: 0, versioning_enabled: 0 };
}

function optionalAccountId(value: string | null): { value?: string; error?: string } {
  if (!value || value === '__all__') return {};
  return /^\d{12}$/.test(value)
    ? { value }
    : { error: 'accountId must be a 12-digit AWS account ID' };
}
