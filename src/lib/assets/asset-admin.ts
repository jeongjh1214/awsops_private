import { createHash, timingSafeEqual } from 'crypto';
import { getConfig } from '../app-config';

const ADMIN_TOKEN_HEADER = 'x-awsops-asset-admin-token';
const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class AssetAdminAuthError extends Error {
  constructor(message = 'Asset admin token is invalid') {
    super(message);
    this.name = 'AssetAdminAuthError';
  }
}

export function hashAdminToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

export function verifyAdminToken(token: string, expectedHash: string): boolean {
  if (!token || !SHA256_HASH_PATTERN.test(expectedHash)) return false;

  const actual = Buffer.from(hashAdminToken(token).slice('sha256:'.length), 'hex');
  const expected = Buffer.from(expectedHash.slice('sha256:'.length), 'hex');
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}

export function requireAssetAdmin(headers: Headers): void {
  const expectedHash = process.env.AWSOPS_ASSET_ADMIN_TOKEN_HASH
    || getConfig().assetInventory?.adminTokenHash
    || '';
  const token = headers.get(ADMIN_TOKEN_HEADER) || '';

  if (!verifyAdminToken(token, expectedHash)) {
    throw new AssetAdminAuthError();
  }
}

export function isAssetAdminAuthError(error: unknown): error is AssetAdminAuthError {
  return error instanceof AssetAdminAuthError
    || (error instanceof Error && error.name === 'AssetAdminAuthError');
}
