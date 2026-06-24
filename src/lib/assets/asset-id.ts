import { createHash } from 'crypto';
import type { AssetIdentityInput } from './asset-types';

export function makeAssetId(input: AssetIdentityInput): string {
  return [
    input.provider,
    input.accountId,
    input.region || 'global',
    input.service,
    input.resourceType,
    input.resourceId,
  ].join(':');
}

export function stableJsonHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}
