import type {
  AccessibleWorkspace,
  BootstrapTenantResult,
  IdentityIdGenerator,
  TenancyStore,
  WorkspaceAccessResult,
  MembershipMutationResult,
} from './ports.js';
import { roleAllows, type TenantRole } from '@aeostudio/domain/identity-access';

export interface CreateTenantInput {
  actorSubject: string;
  actorEmail: string;
  tenantName: string;
  workspaceName: string;
}

export class TenancyService {
  constructor(
    private readonly store: TenancyStore,
    private readonly ids: IdentityIdGenerator,
  ) {}

  async createTenant(input: CreateTenantInput): Promise<BootstrapTenantResult> {
    return this.store.bootstrapTenant({
      actorSubject: input.actorSubject,
      actorEmail: input.actorEmail,
      tenantName: input.tenantName,
      workspaceName: input.workspaceName,
      userId: this.ids.next(),
      tenantId: this.ids.next(),
      workspaceId: this.ids.next(),
      membershipId: this.ids.next(),
      roleBindingId: this.ids.next(),
      auditEventId: this.ids.next(),
    });
  }

  async getWorkspace(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<WorkspaceAccessResult | null> {
    return this.store.findWorkspaceForActor(input);
  }

  async listWorkspaces(input: { actorSubject: string }): Promise<AccessibleWorkspace[]> {
    return this.store.listWorkspacesForActor(input);
  }

  async inviteMembership(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    email: string;
    role: TenantRole;
  }): Promise<MembershipMutationResult> {
    const context = await this.store.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'MEMBERSHIP_INVITE')) {
      await this.store.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'MEMBERSHIP_INVITE',
        resourceType: 'MEMBERSHIP',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const membership = await this.store.inviteMembership({
      context,
      invitedEmail: input.email,
      role: input.role,
      invitedUserId: this.ids.next(),
      membershipId: this.ids.next(),
      roleBindingId: this.ids.next(),
      auditEventId: this.ids.next(),
    });
    return { outcome: 'SUCCEEDED', membership };
  }

  async acceptMembership(input: {
    actorSubject: string;
    actorEmail: string;
    tenantId: string;
    workspaceId: string;
    membershipId: string;
  }): Promise<MembershipMutationResult> {
    const membership = await this.store.acceptMembership({
      ...input,
      auditEventId: this.ids.next(),
    });
    return membership === null ? { outcome: 'NOT_FOUND' } : { outcome: 'SUCCEEDED', membership };
  }

  async changeMembershipRole(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    membershipId: string;
    role: TenantRole;
  }): Promise<MembershipMutationResult> {
    const context = await this.store.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'MEMBERSHIP_ROLE_CHANGE')) {
      await this.store.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'MEMBERSHIP_ROLE_CHANGE',
        resourceType: 'MEMBERSHIP',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const membership = await this.store.changeMembershipRole({
      context,
      membershipId: input.membershipId,
      role: input.role,
      auditEventId: this.ids.next(),
    });
    return membership === null ? { outcome: 'NOT_FOUND' } : { outcome: 'SUCCEEDED', membership };
  }

  async revokeMembership(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    membershipId: string;
  }): Promise<MembershipMutationResult> {
    const context = await this.store.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'MEMBERSHIP_REVOKE')) {
      await this.store.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'MEMBERSHIP_REVOKE',
        resourceType: 'MEMBERSHIP',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const membership = await this.store.revokeMembership({
      context,
      membershipId: input.membershipId,
      auditEventId: this.ids.next(),
    });
    return membership === null ? { outcome: 'NOT_FOUND' } : { outcome: 'SUCCEEDED', membership };
  }
}
