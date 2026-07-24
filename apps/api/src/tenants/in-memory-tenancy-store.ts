import type {
  AccessibleWorkspace,
  BootstrapTenantInput,
  BootstrapTenantResult,
  MembershipResult,
  TenantContext,
  TenancyStore,
  WorkspaceAccessResult,
} from '@aeostudio/application/identity-access';
import type { TenantRole } from '@aeostudio/domain/identity-access';

import type { InMemoryAuditSink } from '../privacy/in-memory-audit-sink.js';

interface UserRecord {
  id: string;
  email: string;
}

interface TenantRecord {
  id: string;
  name: string;
  lifecycleState: 'ACTIVE' | 'FROZEN';
  frozenAt: string | null;
}

interface WorkspaceRecord {
  id: string;
  tenantId: string;
  name: string;
  sequence: number;
  lifecycleState: 'ACTIVE' | 'FROZEN';
  frozenAt: string | null;
}

interface AuditRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  actorUserId: string;
  action: string;
  resourceType: string;
  outcome: 'SUCCEEDED' | 'DENIED';
}

export class InMemoryTenancyStore implements TenancyStore {
  private readonly identities = new Map<string, string>();
  private readonly users = new Map<string, UserRecord>();
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly memberships = new Map<string, MembershipResult>();
  private readonly audit: AuditRecord[] = [];
  private sequence = 0;

  public constructor(private readonly auditSink?: InMemoryAuditSink) {}

  bootstrapTenant(input: BootstrapTenantInput): Promise<BootstrapTenantResult> {
    const existingUserId = this.identities.get(input.actorSubject);
    const userId = existingUserId ?? input.userId;
    this.identities.set(input.actorSubject, userId);
    this.users.set(userId, { id: userId, email: input.actorEmail.toLowerCase() });
    const tenant: TenantRecord = {
      id: input.tenantId,
      name: input.tenantName,
      lifecycleState: 'ACTIVE',
      frozenAt: null,
    };
    const workspace: WorkspaceRecord = {
      id: input.workspaceId,
      tenantId: input.tenantId,
      name: input.workspaceName,
      sequence: (this.sequence += 1),
      lifecycleState: 'ACTIVE',
      frozenAt: null,
    };
    const membership: MembershipResult = {
      id: input.membershipId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      userId,
      email: input.actorEmail.toLowerCase(),
      role: 'OWNER',
      status: 'ACTIVE',
    };
    this.tenants.set(tenant.id, tenant);
    this.workspaces.set(workspace.id, workspace);
    this.memberships.set(membership.id, membership);
    this.auditSink?.bindSubject({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      actorUserId: userId,
    });
    this.appendAudit({
      id: input.auditEventId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      actorUserId: userId,
      action: 'TENANT_CREATED',
      resourceType: 'TENANT',
      outcome: 'SUCCEEDED',
    });
    return Promise.resolve({
      tenant: { id: tenant.id, name: tenant.name },
      workspace: { id: workspace.id, tenantId: workspace.tenantId, name: workspace.name },
      membership,
    });
  }

  async findWorkspaceForActor(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<WorkspaceAccessResult | null> {
    const context = await this.resolveTenantContext(input);
    const workspace = this.workspaces.get(input.workspaceId);
    if (context === null || workspace === undefined || workspace.tenantId !== input.tenantId) {
      return null;
    }
    return {
      workspace: { id: workspace.id, tenantId: workspace.tenantId, name: workspace.name },
      activeRole: context.role,
    };
  }

  listWorkspacesForActor(input: { actorSubject: string }): Promise<AccessibleWorkspace[]> {
    const userId = this.identities.get(input.actorSubject);
    if (userId === undefined) {
      return Promise.resolve([]);
    }
    const workspaces = [...this.memberships.values()]
      .filter((membership) => membership.userId === userId && membership.status === 'ACTIVE')
      .map((membership) => {
        const tenant = this.tenants.get(membership.tenantId);
        const workspace = this.workspaces.get(membership.workspaceId);
        if (
          tenant === undefined ||
          tenant.lifecycleState !== 'ACTIVE' ||
          workspace === undefined ||
          workspace.lifecycleState !== 'ACTIVE'
        ) {
          return null;
        }
        return {
          tenant: { id: tenant.id, name: tenant.name },
          workspace: { id: workspace.id, tenantId: workspace.tenantId, name: workspace.name },
          membershipId: membership.id,
          activeRole: membership.role,
          sequence: workspace.sequence,
        };
      })
      .filter((entry): entry is AccessibleWorkspace & { sequence: number } => entry !== null)
      .sort((left, right) => right.sequence - left.sequence)
      .map((entry) => ({
        tenant: entry.tenant,
        workspace: entry.workspace,
        membershipId: entry.membershipId,
        activeRole: entry.activeRole,
      }));
    return Promise.resolve(workspaces);
  }

  resolveTenantContext(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<TenantContext | null> {
    return Promise.resolve(this.resolveTenantContextNow(input));
  }

  /** Fake-runtime atomic effect boundary; never exposed through an API response. */
  resolveTenantContextNow(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): TenantContext | null {
    if (
      this.tenants.get(input.tenantId)?.lifecycleState !== 'ACTIVE' ||
      this.workspaces.get(input.workspaceId)?.lifecycleState !== 'ACTIVE'
    ) {
      return null;
    }
    const userId = this.identities.get(input.actorSubject);
    const membership = [...this.memberships.values()].find(
      (candidate) =>
        candidate.userId === userId &&
        candidate.tenantId === input.tenantId &&
        candidate.workspaceId === input.workspaceId &&
        candidate.status === 'ACTIVE',
    );
    return membership === undefined
      ? null
      : {
          tenantId: membership.tenantId,
          workspaceId: membership.workspaceId,
          actorUserId: membership.userId,
          membershipId: membership.id,
          role: membership.role,
        };
  }

  resolvePrivacyGovernanceContext(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<TenantContext | null> {
    const tenant = this.tenants.get(input.tenantId);
    const workspace = this.workspaces.get(input.workspaceId);
    if (tenant === undefined || workspace?.tenantId !== tenant.id) {
      return Promise.resolve(null);
    }
    const userId = this.identities.get(input.actorSubject);
    const membership = [...this.memberships.values()].find(
      (candidate) =>
        candidate.userId === userId &&
        candidate.tenantId === input.tenantId &&
        candidate.workspaceId === input.workspaceId &&
        candidate.status === 'ACTIVE' &&
        candidate.role === 'OWNER',
    );
    return Promise.resolve(
      membership === undefined
        ? null
        : {
            tenantId: membership.tenantId,
            workspaceId: membership.workspaceId,
            actorUserId: membership.userId,
            membershipId: membership.id,
            role: 'OWNER',
          },
    );
  }

  inviteMembership(input: {
    context: TenantContext;
    invitedEmail: string;
    role: TenantRole;
    invitedUserId: string;
    membershipId: string;
    roleBindingId: string;
    auditEventId: string;
  }): Promise<MembershipResult> {
    const email = input.invitedEmail.toLowerCase();
    const existingUser = [...this.users.values()].find((user) => user.email === email);
    const userId = existingUser?.id ?? input.invitedUserId;
    this.users.set(userId, { id: userId, email });
    const membership: MembershipResult = {
      id: input.membershipId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      userId,
      email,
      role: input.role,
      status: 'PENDING',
    };
    this.memberships.set(membership.id, membership);
    this.appendAudit({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorUserId: input.context.actorUserId,
      action: 'MEMBERSHIP_INVITED',
      resourceType: 'MEMBERSHIP',
      outcome: 'SUCCEEDED',
    });
    return Promise.resolve(membership);
  }

  acceptMembership(input: {
    actorSubject: string;
    actorEmail: string;
    tenantId: string;
    workspaceId: string;
    membershipId: string;
    auditEventId: string;
  }): Promise<MembershipResult | null> {
    const membership = this.memberships.get(input.membershipId);
    if (
      membership === undefined ||
      membership.tenantId !== input.tenantId ||
      membership.workspaceId !== input.workspaceId ||
      membership.status !== 'PENDING' ||
      membership.email !== input.actorEmail.toLowerCase()
    ) {
      return Promise.resolve(null);
    }
    membership.status = 'ACTIVE';
    this.identities.set(input.actorSubject, membership.userId);
    this.auditSink?.bindSubject({
      actorSubject: input.actorSubject,
      tenantId: membership.tenantId,
      actorUserId: membership.userId,
    });
    this.appendAudit({
      id: input.auditEventId,
      tenantId: membership.tenantId,
      workspaceId: membership.workspaceId,
      actorUserId: membership.userId,
      action: 'MEMBERSHIP_ACCEPTED',
      resourceType: 'MEMBERSHIP',
      outcome: 'SUCCEEDED',
    });
    return Promise.resolve(membership);
  }

  changeMembershipRole(input: {
    context: TenantContext;
    membershipId: string;
    role: TenantRole;
    auditEventId: string;
  }): Promise<MembershipResult | null> {
    const membership = this.memberships.get(input.membershipId);
    if (membership === undefined || membership.tenantId !== input.context.tenantId) {
      return Promise.resolve(null);
    }
    membership.role = input.role;
    this.appendAudit({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorUserId: input.context.actorUserId,
      action: 'MEMBERSHIP_ROLE_CHANGED',
      resourceType: 'MEMBERSHIP',
      outcome: 'SUCCEEDED',
    });
    return Promise.resolve(membership);
  }

  revokeMembership(input: {
    context: TenantContext;
    membershipId: string;
    auditEventId: string;
  }): Promise<MembershipResult | null> {
    const membership = this.memberships.get(input.membershipId);
    if (membership === undefined || membership.tenantId !== input.context.tenantId) {
      return Promise.resolve(null);
    }
    membership.status = 'REVOKED';
    this.appendAudit({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorUserId: input.context.actorUserId,
      action: 'MEMBERSHIP_REVOKED',
      resourceType: 'MEMBERSHIP',
      outcome: 'SUCCEEDED',
    });
    return Promise.resolve(membership);
  }

  appendDeniedAudit(input: {
    context: TenantContext;
    auditEventId: string;
    action: string;
    resourceType: string;
  }): Promise<void> {
    this.appendAudit({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorUserId: input.context.actorUserId,
      action: input.action,
      resourceType: input.resourceType,
      outcome: 'DENIED',
    });
    return Promise.resolve();
  }

  freezeTenant(input: { tenantId: string; frozenAt: Date }): {
    changed: boolean;
    subjects: string[];
  } | null {
    const tenant = this.tenants.get(input.tenantId);
    if (tenant === undefined) return null;
    const changed = tenant.lifecycleState === 'ACTIVE';
    tenant.lifecycleState = 'FROZEN';
    tenant.frozenAt ??= input.frozenAt.toISOString();
    const userIds = new Set(
      [...this.memberships.values()]
        .filter((membership) => membership.tenantId === input.tenantId)
        .map((membership) => membership.userId),
    );
    const subjects = [...this.identities.entries()]
      .filter(([, userId]) => userIds.has(userId))
      .map(([subject]) => subject)
      .sort();
    return { changed, subjects };
  }

  getTenantLifecycleState(tenantId: string): 'ACTIVE' | 'FROZEN' | null {
    return this.tenants.get(tenantId)?.lifecycleState ?? null;
  }

  allTenantWorkspacesActive(tenantId: string): boolean {
    if (this.tenants.get(tenantId)?.lifecycleState !== 'ACTIVE') return false;
    const workspaces = [...this.workspaces.values()].filter(
      (workspace) => workspace.tenantId === tenantId,
    );
    return (
      workspaces.length > 0 &&
      workspaces.every((workspace) => workspace.lifecycleState === 'ACTIVE')
    );
  }

  isCurrentOwnerContext(context: TenantContext): boolean {
    const tenant = this.tenants.get(context.tenantId);
    const workspace = this.workspaces.get(context.workspaceId);
    const membership = this.memberships.get(context.membershipId);
    return (
      context.role === 'OWNER' &&
      tenant?.lifecycleState === 'ACTIVE' &&
      workspace?.tenantId === context.tenantId &&
      workspace.lifecycleState === 'ACTIVE' &&
      membership?.tenantId === context.tenantId &&
      membership.workspaceId === context.workspaceId &&
      membership.userId === context.actorUserId &&
      membership.status === 'ACTIVE' &&
      membership.role === 'OWNER'
    );
  }

  freezeWorkspace(input: {
    tenantId: string;
    workspaceId: string;
    frozenAt: Date;
  }): { changed: boolean; subjects: string[] } | null {
    const workspace = this.workspaces.get(input.workspaceId);
    if (workspace === undefined || workspace.tenantId !== input.tenantId) return null;
    const changed = workspace.lifecycleState === 'ACTIVE';
    workspace.lifecycleState = 'FROZEN';
    workspace.frozenAt ??= input.frozenAt.toISOString();
    return { changed, subjects: this.subjectsForScope(input.tenantId, input.workspaceId) };
  }

  getWorkspaceLifecycleState(input: {
    tenantId: string;
    workspaceId: string;
  }): 'ACTIVE' | 'FROZEN' | null {
    const workspace = this.workspaces.get(input.workspaceId);
    return workspace?.tenantId === input.tenantId ? workspace.lifecycleState : null;
  }

  listTenantAuditRecords(tenantId: string): readonly AuditRecord[] {
    return this.audit
      .filter((record) => record.tenantId === tenantId)
      .map((record) => structuredClone(record));
  }

  private appendAudit(record: AuditRecord): void {
    this.audit.push(record);
    this.auditSink?.append({
      id: record.id,
      tenantId: record.tenantId,
      workspaceId: record.workspaceId,
      actorKind: 'USER',
      actorId: record.actorUserId,
      action: record.action,
      resourceType: record.resourceType,
      resourceId: null,
      outcome: record.outcome,
      metadata: {},
    });
  }

  private subjectsForScope(tenantId: string, workspaceId?: string): string[] {
    const userIds = new Set(
      [...this.memberships.values()]
        .filter(
          (membership) =>
            membership.tenantId === tenantId &&
            (workspaceId === undefined || membership.workspaceId === workspaceId),
        )
        .map((membership) => membership.userId),
    );
    return [...this.identities.entries()]
      .filter(([, userId]) => userIds.has(userId))
      .map(([subject]) => subject)
      .sort();
  }
}
