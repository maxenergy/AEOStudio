import type { TenantContext } from '@aeostudio/application/identity-access';
import type { Pool, PoolClient } from 'pg';

export class TenantContextRunner {
  constructor(private readonly pool: Pool) {}

  async run<T>(
    context: TenantContext | undefined,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.runWithLifecycle(context, false, operation);
  }

  async runActive<T>(
    context: TenantContext | undefined,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.runWithLifecycle(context, true, operation);
  }

  private async runWithLifecycle<T>(
    context: TenantContext | undefined,
    requireActive: boolean,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (context === undefined) {
      throw new Error('TENANT_CONTEXT_REQUIRED');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE aeostudio_runtime');
      await client.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.workspace_id', $2, true),
          set_config('app.actor_id', $3, true)`,
        [context.tenantId, context.workspaceId, context.actorUserId],
      );
      if (requireActive) {
        const active = await client.query(
          `SELECT 1
           FROM tenants tenant
           JOIN workspaces workspace
             ON workspace.tenant_id = tenant.id AND workspace.id = $2
           WHERE tenant.id = $1
             AND tenant.lifecycle_state = 'ACTIVE'
             AND workspace.lifecycle_state = 'ACTIVE'
           FOR KEY SHARE OF tenant, workspace`,
          [context.tenantId, context.workspaceId],
        );
        if (active.rowCount !== 1) throw new Error('TENANT_SCOPE_NOT_ACTIVE');
      }
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
