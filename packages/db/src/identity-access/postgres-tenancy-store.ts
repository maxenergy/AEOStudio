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
import type { Pool } from 'pg';

import { TenantContextRunner } from '../tenant-context/tenant-context-runner.js';

interface BootstrapTenantRow {
  user_id: string;
  tenant_id: string;
  tenant_name: string;
  workspace_id: string;
  workspace_name: string;
  membership_id: string;
  role: TenantRole;
  membership_status: 'ACTIVE';
}

interface MembershipContextRow {
  user_id: string;
  membership_id: string;
  role: TenantRole;
}

interface WorkspaceRow {
  id: string;
  tenant_id: string;
  name: string;
}

interface AccessibleWorkspaceRow {
  tenant_id: string;
  tenant_name: string;
  workspace_id: string;
  workspace_name: string;
  membership_id: string;
  role: TenantRole;
}

interface MembershipMutationRow {
  membership_id: string;
  user_id: string;
  invited_email: string;
  role: TenantRole;
  membership_status: 'PENDING' | 'ACTIVE' | 'REVOKED';
}

export class PostgresTenancyStore implements TenancyStore {
  private readonly contexts: TenantContextRunner;

  constructor(private readonly pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  async bootstrapTenant(input: BootstrapTenantInput): Promise<BootstrapTenantResult> {
    const result = await this.pool.query<BootstrapTenantRow>(
      `SELECT * FROM bootstrap_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.actorSubject,
        input.actorEmail,
        input.userId,
        input.tenantId,
        input.tenantName,
        input.workspaceId,
        input.workspaceName,
        input.membershipId,
        input.roleBindingId,
        input.auditEventId,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('TENANT_BOOTSTRAP_DID_NOT_RETURN_RESULT');
    }
    return {
      tenant: { id: row.tenant_id, name: row.tenant_name },
      workspace: {
        id: row.workspace_id,
        tenantId: row.tenant_id,
        name: row.workspace_name,
      },
      membership: {
        id: row.membership_id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        userId: row.user_id,
        role: row.role,
        status: row.membership_status,
      },
    };
  }

  async findWorkspaceForActor(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<WorkspaceAccessResult | null> {
    const context = await this.resolveTenantContext(input);
    if (context === null) {
      return null;
    }
    const workspace = await this.findWorkspaceInContext(context, input.workspaceId);
    return workspace === null ? null : { workspace, activeRole: context.role };
  }

  async listWorkspacesForActor(input: { actorSubject: string }): Promise<AccessibleWorkspace[]> {
    const result = await this.pool.query<AccessibleWorkspaceRow>(
      'SELECT * FROM list_actor_workspaces($1)',
      [input.actorSubject],
    );
    return result.rows.map((row) => ({
      tenant: { id: row.tenant_id, name: row.tenant_name },
      workspace: {
        id: row.workspace_id,
        tenantId: row.tenant_id,
        name: row.workspace_name,
      },
      membershipId: row.membership_id,
      activeRole: row.role,
    }));
  }

  async resolveTenantContext(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<TenantContext | null> {
    const membership = await this.pool.query<MembershipContextRow>(
      'SELECT * FROM resolve_active_workspace_membership($1, $2, $3)',
      [input.actorSubject, input.tenantId, input.workspaceId],
    );
    const row = membership.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      actorUserId: row.user_id,
      membershipId: row.membership_id,
      role: row.role,
    };
  }

  async resolvePrivacyGovernanceContext(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<TenantContext | null> {
    const membership = await this.pool.query<MembershipContextRow>(
      'SELECT * FROM resolve_privacy_governance_owner($1, $2, $3)',
      [input.actorSubject, input.tenantId, input.workspaceId],
    );
    const row = membership.rows[0];
    if (row === undefined) return null;
    return {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      actorUserId: row.user_id,
      membershipId: row.membership_id,
      role: row.role,
    };
  }

  async findWorkspaceInContext(
    context: TenantContext | undefined,
    workspaceId: string,
  ): Promise<{ id: string; tenantId: string; name: string } | null> {
    return this.contexts.run(context, async (client) => {
      const result = await client.query<WorkspaceRow>(
        'SELECT id, tenant_id, name FROM workspaces WHERE id = $1',
        [workspaceId],
      );
      const row = result.rows[0];
      return row === undefined ? null : { id: row.id, tenantId: row.tenant_id, name: row.name };
    });
  }

  async inviteMembership(input: {
    context: TenantContext;
    invitedEmail: string;
    role: TenantRole;
    invitedUserId: string;
    membershipId: string;
    roleBindingId: string;
    auditEventId: string;
  }): Promise<MembershipResult> {
    const result = await this.pool.query<MembershipMutationRow>(
      'SELECT * FROM invite_workspace_member($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        input.context.actorUserId,
        input.context.tenantId,
        input.context.workspaceId,
        input.invitedEmail,
        input.role,
        input.invitedUserId,
        input.membershipId,
        input.roleBindingId,
        input.auditEventId,
      ],
    );
    return this.mapMembership(result.rows[0], input.context);
  }

  async acceptMembership(input: {
    actorSubject: string;
    actorEmail: string;
    tenantId: string;
    workspaceId: string;
    membershipId: string;
    auditEventId: string;
  }): Promise<MembershipResult | null> {
    const result = await this.pool.query<MembershipMutationRow>(
      'SELECT * FROM accept_workspace_membership($1, $2, $3, $4, $5, $6)',
      [
        input.actorSubject,
        input.actorEmail,
        input.tenantId,
        input.workspaceId,
        input.membershipId,
        input.auditEventId,
      ],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          id: row.membership_id,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          userId: row.user_id,
          email: row.invited_email,
          role: row.role,
          status: row.membership_status,
        };
  }

  async changeMembershipRole(input: {
    context: TenantContext;
    membershipId: string;
    role: TenantRole;
    auditEventId: string;
  }): Promise<MembershipResult | null> {
    const result = await this.pool.query<MembershipMutationRow>(
      'SELECT * FROM change_workspace_member_role($1, $2, $3, $4, $5, $6)',
      [
        input.context.actorUserId,
        input.context.tenantId,
        input.context.workspaceId,
        input.membershipId,
        input.role,
        input.auditEventId,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.mapMembership(row, input.context);
  }

  async revokeMembership(input: {
    context: TenantContext;
    membershipId: string;
    auditEventId: string;
  }): Promise<MembershipResult | null> {
    const result = await this.pool.query<MembershipMutationRow>(
      'SELECT * FROM revoke_workspace_membership($1, $2, $3, $4, $5)',
      [
        input.context.actorUserId,
        input.context.tenantId,
        input.context.workspaceId,
        input.membershipId,
        input.auditEventId,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.mapMembership(row, input.context);
  }

  async appendDeniedAudit(input: {
    context: TenantContext;
    auditEventId: string;
    action: string;
    resourceType: string;
  }): Promise<void> {
    await this.contexts.run(input.context, async (client) => {
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, 'DENIED')`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.action,
          input.resourceType,
        ],
      );
    });
  }

  private mapMembership(
    row: MembershipMutationRow | undefined,
    context: TenantContext,
  ): MembershipResult {
    if (row === undefined) {
      throw new Error('MEMBERSHIP_MUTATION_DID_NOT_RETURN_RESULT');
    }
    return {
      id: row.membership_id,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      userId: row.user_id,
      email: row.invited_email,
      role: row.role,
      status: row.membership_status,
    };
  }
}
