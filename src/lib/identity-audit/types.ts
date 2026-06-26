export interface IdentityAuditUserInput {
  displayName: string;
  identityStoreUserId: string;
  userName: string;
  email: string;
  orgCode: string;
  orgName: string;
  rawOrg: unknown;
}

export interface IdentityAuditAssignmentInput {
  displayName: string;
  identityStoreUserId: string;
  accountId: string;
  accountName: string;
  permissionSetArn: string;
  permissionSetName: string;
  assignmentType: 'USER' | 'GROUP';
  groupId: string;
  groupName: string;
}

export interface PersistIdentityAuditSnapshotInput {
  runId: string;
  collectedAt: string;
  users: IdentityAuditUserInput[];
  assignments: IdentityAuditAssignmentInput[];
}

export interface IdentityAuditPersistSummary {
  totalUsers: number;
  orgResolvedUsers: number;
  changedUsers: number;
  riskyUsers: number;
  errorCount: number;
}
