import type { BudgetAlertScope } from '@aeostudio/domain/jobs-budgets';
import type { PoolClient } from 'pg';

export async function persistTenantOwnerBudgetAlert(
  client: PoolClient,
  input: {
    tenantId: string;
    sourceWorkspaceId: string;
    jobId: string;
    budgetScope: BudgetAlertScope;
    policyId: string;
    providerKey: string | null;
    thresholdPercent: number;
    createdAt?: Date;
  },
): Promise<void> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tenant_owner_budget_alerts
      (tenant_id, source_workspace_id, job_id, budget_scope,
        tenant_budget_policy_id, provider_budget_policy_id, provider_key,
        threshold_percent, created_at)
     VALUES (
       $1, $2, $3, $4,
       CASE WHEN $4 = 'TENANT' THEN $5::uuid ELSE NULL END,
       CASE WHEN $4 = 'PROVIDER' THEN $5::uuid ELSE NULL END,
       $6, $7, COALESCE($8, now())
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      input.sourceWorkspaceId,
      input.jobId,
      input.budgetScope,
      input.policyId,
      input.providerKey,
      input.thresholdPercent,
      input.createdAt ?? null,
    ],
  );
  let alertId = inserted.rows[0]?.id;
  if (alertId === undefined) {
    const existing = await client.query<{ id: string }>(
      `SELECT id
       FROM tenant_owner_budget_alerts
       WHERE tenant_id = $1
         AND budget_scope = $2
         AND threshold_percent = $4
         AND (
           ($2 = 'TENANT' AND tenant_budget_policy_id = $3)
           OR ($2 = 'PROVIDER' AND provider_budget_policy_id = $3)
         )`,
      [input.tenantId, input.budgetScope, input.policyId, input.thresholdPercent],
    );
    alertId = existing.rows[0]?.id;
  }
  if (alertId === undefined) throw new Error('TENANT_OWNER_BUDGET_ALERT_DID_NOT_PERSIST');

  await client.query(
    `INSERT INTO tenant_owner_budget_alert_recipients
      (alert_id, tenant_id, recipient_user_id, audience, created_at)
     SELECT $1, $2, owner_membership.user_id, 'TENANT_OWNER', COALESCE($3, now())
     FROM memberships owner_membership
     WHERE owner_membership.tenant_id = $2
       AND owner_membership.status = 'ACTIVE'
       AND EXISTS (
         SELECT 1
         FROM role_bindings owner_binding
         WHERE owner_binding.tenant_id = owner_membership.tenant_id
           AND owner_binding.membership_id = owner_membership.id
           AND owner_binding.role = 'OWNER'
       )
     ON CONFLICT (alert_id, recipient_user_id) DO NOTHING`,
    [alertId, input.tenantId, input.createdAt ?? null],
  );
}
