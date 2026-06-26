import {
  DescribePermissionSetCommand,
  ListAccountAssignmentsCommand,
  ListAccountsForProvisionedPermissionSetCommand,
  ListInstancesCommand,
  ListPermissionSetsCommand,
  SSOAdminClient,
} from '@aws-sdk/client-sso-admin';
import {
  IdentitystoreClient,
  ListGroupMembershipsCommand,
  ListGroupsCommand,
  ListUsersCommand,
} from '@aws-sdk/client-identitystore';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import type {
  CollectedIdentityAssignment,
  CollectedIdentityCenterState,
  CollectedIdentityUser,
} from './types';

export interface IdentityCenterCollectorConfig {
  profile?: string;
  region: string;
  endpointUrls: Record<string, string>;
}

interface IdentityCenterGroup {
  groupId: string;
  displayName: string;
}

interface IdentityCenterAccountAssignment {
  AccountId?: string;
  PermissionSetArn?: string;
  PrincipalType?: unknown;
  PrincipalId?: string;
}

interface ExpandIdentityCenterAssignmentsInput {
  users: CollectedIdentityUser[];
  groupsById: Map<string, IdentityCenterGroup>;
  groupMembersByGroupId: Map<string, string[]>;
  permissionSetsByArn: Map<string, string>;
  accountAssignments: IdentityCenterAccountAssignment[];
}

export function createIdentityStoreClient(config: IdentityCenterCollectorConfig): IdentitystoreClient {
  return new IdentitystoreClient({
    region: config.region,
    endpoint: config.endpointUrls.identitystore,
    credentials: config.profile ? fromIni({ profile: config.profile }) : undefined,
  });
}

export function createSsoAdminClient(config: IdentityCenterCollectorConfig): SSOAdminClient {
  return new SSOAdminClient({
    region: config.region,
    endpoint: config.endpointUrls['sso-admin'] || config.endpointUrls.sso,
    credentials: config.profile ? fromIni({ profile: config.profile }) : undefined,
  });
}

export async function collectIdentityCenterState(
  config: IdentityCenterCollectorConfig,
): Promise<CollectedIdentityCenterState> {
  const identityStoreClient = createIdentityStoreClient(config);
  const ssoAdminClient = createSsoAdminClient(config);

  const instances = await ssoAdminClient.send(new ListInstancesCommand({}));
  const instance = instances.Instances?.[0];
  if (!instance?.IdentityStoreId || !instance.InstanceArn) {
    throw new Error('IAM Identity Center instance is missing IdentityStoreId or InstanceArn');
  }

  const identityStoreId = instance.IdentityStoreId;
  const instanceArn = instance.InstanceArn;
  const users = await listIdentityUsers(identityStoreClient, identityStoreId);
  const groupsById = await listIdentityGroups(identityStoreClient, identityStoreId);
  const groupMembersByGroupId = await listGroupMemberships(
    identityStoreClient,
    identityStoreId,
    groupsById,
  );
  const permissionSetsByArn = await listPermissionSets(ssoAdminClient, instanceArn);
  const accountAssignments = await listAccountAssignments(
    ssoAdminClient,
    instanceArn,
    Array.from(permissionSetsByArn.keys()),
  );

  return {
    users,
    assignments: expandIdentityCenterAssignments({
      users,
      groupsById,
      groupMembersByGroupId,
      permissionSetsByArn,
      accountAssignments,
    }),
  };
}

export function expandIdentityCenterAssignments(
  state: ExpandIdentityCenterAssignmentsInput,
): CollectedIdentityAssignment[] {
  const usersById = new Map(state.users.map((user) => [user.identityStoreUserId, user]));
  const rows: CollectedIdentityAssignment[] = [];

  for (const assignment of state.accountAssignments) {
    const principalType = String(assignment.PrincipalType || '');
    if (principalType === 'USER') {
      const user = assignment.PrincipalId ? usersById.get(assignment.PrincipalId) : undefined;
      if (!user) continue;
      rows.push(toCollectedAssignment(assignment, user, 'USER', '', '', state.permissionSetsByArn));
      continue;
    }

    if (principalType === 'GROUP') {
      const group = assignment.PrincipalId ? state.groupsById.get(assignment.PrincipalId) : undefined;
      if (!group) continue;

      const memberUserIds = state.groupMembersByGroupId.get(group.groupId) || [];
      for (const memberUserId of memberUserIds) {
        const user = usersById.get(memberUserId);
        if (!user) continue;
        rows.push(toCollectedAssignment(
          assignment,
          user,
          'GROUP',
          group.groupId,
          group.displayName,
          state.permissionSetsByArn,
        ));
      }
    }
  }

  return rows;
}

async function listIdentityUsers(
  client: IdentitystoreClient,
  identityStoreId: string,
): Promise<CollectedIdentityUser[]> {
  const users: CollectedIdentityUser[] = [];
  let nextToken: string | undefined;

  do {
    const result = await client.send(new ListUsersCommand({
      IdentityStoreId: identityStoreId,
      NextToken: nextToken,
    }));
    for (const user of result.Users || []) {
      if (!user.UserId) continue;
      users.push({
        displayName: user.DisplayName || user.UserName || user.UserId,
        identityStoreUserId: user.UserId,
        userName: user.UserName || '',
        email: user.Emails?.find((email) => email.Primary)?.Value || user.Emails?.[0]?.Value || '',
      });
    }
    nextToken = result.NextToken;
  } while (nextToken);

  return users;
}

async function listIdentityGroups(
  client: IdentitystoreClient,
  identityStoreId: string,
): Promise<Map<string, IdentityCenterGroup>> {
  const groupsById = new Map<string, IdentityCenterGroup>();
  let nextToken: string | undefined;

  do {
    const result = await client.send(new ListGroupsCommand({
      IdentityStoreId: identityStoreId,
      NextToken: nextToken,
    }));
    for (const group of result.Groups || []) {
      if (!group.GroupId) continue;
      groupsById.set(group.GroupId, {
        groupId: group.GroupId,
        displayName: group.DisplayName || '',
      });
    }
    nextToken = result.NextToken;
  } while (nextToken);

  return groupsById;
}

async function listGroupMemberships(
  client: IdentitystoreClient,
  identityStoreId: string,
  groupsById: Map<string, IdentityCenterGroup>,
): Promise<Map<string, string[]>> {
  const groupMembersByGroupId = new Map<string, string[]>();

  for (const groupId of groupsById.keys()) {
    const memberUserIds: string[] = [];
    let nextToken: string | undefined;

    do {
      const result = await client.send(new ListGroupMembershipsCommand({
        IdentityStoreId: identityStoreId,
        GroupId: groupId,
        NextToken: nextToken,
      }));
      for (const membership of result.GroupMemberships || []) {
        if (membership.MemberId?.UserId) {
          memberUserIds.push(membership.MemberId.UserId);
        }
      }
      nextToken = result.NextToken;
    } while (nextToken);

    groupMembersByGroupId.set(groupId, memberUserIds);
  }

  return groupMembersByGroupId;
}

async function listPermissionSets(
  client: SSOAdminClient,
  instanceArn: string,
): Promise<Map<string, string>> {
  const permissionSetArns: string[] = [];
  let nextToken: string | undefined;

  do {
    const result = await client.send(new ListPermissionSetsCommand({
      InstanceArn: instanceArn,
      NextToken: nextToken,
    }));
    permissionSetArns.push(...(result.PermissionSets || []));
    nextToken = result.NextToken;
  } while (nextToken);

  const permissionSetsByArn = new Map<string, string>();
  for (const permissionSetArn of permissionSetArns) {
    const result = await client.send(new DescribePermissionSetCommand({
      InstanceArn: instanceArn,
      PermissionSetArn: permissionSetArn,
    }));
    permissionSetsByArn.set(permissionSetArn, result.PermissionSet?.Name || '');
  }

  return permissionSetsByArn;
}

async function listAccountAssignments(
  client: SSOAdminClient,
  instanceArn: string,
  permissionSetArns: string[],
): Promise<IdentityCenterAccountAssignment[]> {
  const accountAssignments: IdentityCenterAccountAssignment[] = [];

  for (const permissionSetArn of permissionSetArns) {
    const accountIds = await listAccountsForPermissionSet(client, instanceArn, permissionSetArn);
    for (const accountId of accountIds) {
      let nextToken: string | undefined;

      do {
        const result = await client.send(new ListAccountAssignmentsCommand({
          AccountId: accountId,
          InstanceArn: instanceArn,
          PermissionSetArn: permissionSetArn,
          NextToken: nextToken,
        }));
        accountAssignments.push(...(result.AccountAssignments || []));
        nextToken = result.NextToken;
      } while (nextToken);
    }
  }

  return accountAssignments;
}

async function listAccountsForPermissionSet(
  client: SSOAdminClient,
  instanceArn: string,
  permissionSetArn: string,
): Promise<string[]> {
  const accountIds: string[] = [];
  let nextToken: string | undefined;

  do {
    const result = await client.send(new ListAccountsForProvisionedPermissionSetCommand({
      InstanceArn: instanceArn,
      PermissionSetArn: permissionSetArn,
      NextToken: nextToken,
    }));
    accountIds.push(...(result.AccountIds || []));
    nextToken = result.NextToken;
  } while (nextToken);

  return accountIds;
}

function toCollectedAssignment(
  assignment: IdentityCenterAccountAssignment,
  user: CollectedIdentityUser,
  assignmentType: 'USER' | 'GROUP',
  groupId: string,
  groupName: string,
  permissionSetsByArn: Map<string, string>,
): CollectedIdentityAssignment {
  const permissionSetArn = assignment.PermissionSetArn || '';
  return {
    displayName: user.displayName,
    identityStoreUserId: user.identityStoreUserId,
    accountId: assignment.AccountId || '',
    accountName: '',
    permissionSetArn,
    permissionSetName: permissionSetsByArn.get(permissionSetArn) || '',
    assignmentType,
    groupId,
    groupName,
  };
}
