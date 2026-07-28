import { getConfig } from '@/lib/app-config';
import {
  getBlockedQueryServices,
  normalizeEnabledQueryServices,
  type QueryService,
} from '@/lib/query-policy-shared';

export function getEnabledQueryServices(): QueryService[] {
  return normalizeEnabledQueryServices(getConfig().queryPolicy?.enabledServices);
}

export function isQueryServiceEnabled(service: QueryService): boolean {
  return getEnabledQueryServices().includes(service);
}

export function validateQueryServicePolicy(sql: string): void {
  const blocked = getBlockedQueryServices(sql, getEnabledQueryServices());
  if (blocked.length > 0) {
    throw new Error(`Query service is disabled by queryPolicy: ${blocked.join(', ')}`);
  }
}
