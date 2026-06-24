import { makeAssetId, stableJsonHash } from './asset-id';
import type { AssetRecord } from './asset-types';

type SteampipeRow = Record<string, unknown>;

interface BaseAssetInput {
  row: SteampipeRow;
  now: string;
  service: string;
  resourceType: string;
  resourceId: string;
  resourceName: string;
  arn: string;
  status: string;
  nativeState: string;
  tags: Record<string, unknown>;
  sourceTable: string;
}

export function normalizeEc2Instance(row: SteampipeRow, now: string): AssetRecord {
  const tags = normalizeTags(row.tags);
  const instanceId = firstString(row, ['instance_id', 'id']);
  const state = firstString(row, ['instance_state', 'state', 'state_name', 'status']) || 'unknown';

  return normalizeBaseAsset({
    row,
    now,
    service: 'ec2',
    resourceType: 'ec2_instance',
    resourceId: instanceId,
    resourceName: tagName(tags) || firstString(row, ['name', 'title']) || instanceId,
    arn: firstString(row, ['arn']),
    status: state,
    nativeState: state,
    tags,
    sourceTable: 'aws_ec2_instance',
  });
}

export function normalizeS3Bucket(row: SteampipeRow, now: string): AssetRecord {
  const tags = normalizeTags(row.tags);
  const bucketName = firstString(row, ['name', 'bucket_name', 'title']);
  const region = firstString(row, ['region', 'bucket_region', 'location_constraint']) || 'global';

  return normalizeBaseAsset({
    row: { ...row, region },
    now,
    service: 's3',
    resourceType: 's3_bucket',
    resourceId: bucketName,
    resourceName: tagName(tags) || bucketName,
    arn: firstString(row, ['arn']) || (bucketName ? `arn:aws:s3:::${bucketName}` : ''),
    status: firstString(row, ['status']) || 'available',
    nativeState: firstString(row, ['status']) || 'available',
    tags,
    sourceTable: 'aws_s3_bucket',
  });
}

function normalizeBaseAsset(input: BaseAssetInput): AssetRecord {
  const accountId = firstString(input.row, ['account_id', 'account']) || 'unknown';
  const region = firstString(input.row, ['region']) || 'global';
  const sourceUpdatedAt = firstString(input.row, [
    'source_updated_at',
    'updated_at',
    'update_time',
    'last_updated',
    'akas_updated_at',
  ]) || input.now;

  const identity = {
    provider: 'aws' as const,
    accountId,
    region,
    service: input.service,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  };

  const hashInput = {
    provider: identity.provider,
    accountId: identity.accountId,
    region: identity.region,
    service: identity.service,
    resourceType: identity.resourceType,
    resourceId: identity.resourceId,
    accountName: firstString(input.row, ['account_name', 'account_alias', 'account_title']),
    resourceName: input.resourceName,
    arn: input.arn,
    status: input.status,
    nativeState: input.nativeState,
    tags: input.tags,
    sourceTable: input.sourceTable,
  };

  return {
    ...identity,
    id: makeAssetId(identity),
    accountName: hashInput.accountName,
    resourceName: input.resourceName,
    arn: input.arn,
    status: input.status,
    nativeState: input.nativeState,
    tags: input.tags,
    sourceTable: input.sourceTable,
    sourceUpdatedAt,
    firstDiscoveredAt: input.now,
    lastSeenAt: input.now,
    isActive: true,
    lastHash: stableJsonHash(hashInput),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function firstString(row: SteampipeRow, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function normalizeTags(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return normalizeTags(parsed);
    } catch {
      return {};
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function tagName(tags: Record<string, unknown>): string {
  const name = tags.Name;
  return typeof name === 'string' ? name : '';
}
