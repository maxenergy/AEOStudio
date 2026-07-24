import type { MembershipStatus, TenantRole } from '@aeostudio/domain/identity-access';

export interface BootstrapTenantInput {
  actorSubject: string;
  actorEmail: string;
  userId: string;
  tenantId: string;
  tenantName: string;
  workspaceId: string;
  workspaceName: string;
  membershipId: string;
  roleBindingId: string;
  auditEventId: string;
}

export interface BootstrapTenantResult {
  tenant: { id: string; name: string };
  workspace: { id: string; tenantId: string; name: string };
  membership: {
    id: string;
    tenantId: string;
    workspaceId: string;
    userId: string;
    role: TenantRole;
    status: MembershipStatus;
  };
}

export interface TenantContext {
  tenantId: string;
  workspaceId: string;
  actorUserId: string;
  membershipId: string;
  role: TenantRole;
}

export interface WorkspaceAccessResult {
  workspace: { id: string; tenantId: string; name: string };
  activeRole: TenantRole;
}

export interface AccessibleWorkspace {
  tenant: { id: string; name: string };
  workspace: { id: string; tenantId: string; name: string };
  membershipId: string;
  activeRole: TenantRole;
}

export interface MembershipResult {
  id: string;
  tenantId: string;
  workspaceId: string;
  userId: string;
  email: string;
  role: TenantRole;
  status: MembershipStatus;
}

export type MembershipMutationResult =
  | { outcome: 'SUCCEEDED'; membership: MembershipResult }
  | { outcome: 'FORBIDDEN' }
  | { outcome: 'NOT_FOUND' };

export interface TenancyStore {
  bootstrapTenant(input: BootstrapTenantInput): Promise<BootstrapTenantResult>;
  findWorkspaceForActor(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<WorkspaceAccessResult | null>;
  listWorkspacesForActor(input: { actorSubject: string }): Promise<AccessibleWorkspace[]>;
  resolveTenantContext(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<TenantContext | null>;
  resolvePrivacyGovernanceContext(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<TenantContext | null>;
  inviteMembership(input: {
    context: TenantContext;
    invitedEmail: string;
    role: TenantRole;
    invitedUserId: string;
    membershipId: string;
    roleBindingId: string;
    auditEventId: string;
  }): Promise<MembershipResult>;
  acceptMembership(input: {
    actorSubject: string;
    actorEmail: string;
    tenantId: string;
    workspaceId: string;
    membershipId: string;
    auditEventId: string;
  }): Promise<MembershipResult | null>;
  changeMembershipRole(input: {
    context: TenantContext;
    membershipId: string;
    role: TenantRole;
    auditEventId: string;
  }): Promise<MembershipResult | null>;
  revokeMembership(input: {
    context: TenantContext;
    membershipId: string;
    auditEventId: string;
  }): Promise<MembershipResult | null>;
  appendDeniedAudit(input: {
    context: TenantContext;
    auditEventId: string;
    action: string;
    resourceType: string;
  }): Promise<void>;
}

export interface IdentityIdGenerator {
  next(): string;
}
