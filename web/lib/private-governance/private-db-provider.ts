import { getPrivateRuntimeConfig, isLocalPrivateAgentEnabled } from '../private-runtime-config';

export type PrivateGovernanceDbProvider = 'aurora' | 'sqlite';

export function getPrivateGovernanceDbProvider(): PrivateGovernanceDbProvider {
  const configured = normalizeProvider(process.env.AWSOPS_PRIVATE_DB_PROVIDER)
    ?? normalizeProvider(process.env.AWSOPS_ASSET_DB_PROVIDER)
    ?? normalizeProvider(getPrivateRuntimeConfig().assetInventory?.dbProvider);

  if (configured) return configured;
  if (process.env.AURORA_ENDPOINT || process.env.AURORA_CLUSTER_ARN) return 'aurora';
  if (isLocalPrivateAgentEnabled()) return 'sqlite';
  return 'aurora';
}

function normalizeProvider(value: string | undefined): PrivateGovernanceDbProvider | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'aurora' || normalized === 'postgres' || normalized === 'postgresql') return 'aurora';
  if (normalized === 'sqlite' || normalized === 'local') return 'sqlite';
  return null;
}
