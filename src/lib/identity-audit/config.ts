import {
  DEFAULT_IDENTITY_AUDIT_CONFIG,
  getConfig,
  type IdentityAuditConfig,
} from '../app-config';

export interface ResolvedIdentityAuditConfig extends IdentityAuditConfig {
  profile?: string;
  endpointUrls: Record<string, string>;
}

export function resolveIdentityAuditConfig(): ResolvedIdentityAuditConfig {
  const config = getConfig();
  const identityAudit = config.identityAudit ?? {};
  const environment = config.activeEnvironment
    ? config.environments?.[config.activeEnvironment]
    : undefined;

  return {
    ...DEFAULT_IDENTITY_AUDIT_CONFIG,
    ...identityAudit,
    schedule: {
      ...DEFAULT_IDENTITY_AUDIT_CONFIG.schedule,
      ...identityAudit.schedule,
    },
    organizationApi: {
      ...DEFAULT_IDENTITY_AUDIT_CONFIG.organizationApi,
      ...identityAudit.organizationApi,
    },
    profile: identityAudit.awsProfile
      ?? environment?.identityCenterProfile
      ?? environment?.awsProfile,
    endpointUrls: {
      ...(environment?.endpointUrls ?? {}),
    },
  };
}
