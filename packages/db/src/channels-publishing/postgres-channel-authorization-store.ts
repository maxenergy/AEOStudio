import type { ChannelAuthorizationStore } from '@aeostudio/application/channels-publishing';
import type {
  ChannelAuthorizationEligibility,
  ChannelAuthorizationMetadata,
} from '@aeostudio/domain/channels-publishing';
import type { Pool } from 'pg';

import { TenantContextRunner } from '../tenant-context/index.js';

interface ChannelAuthorizationEligibilityRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  adapter_version_id: string;
  status: 'ACTIVE' | 'REVOKED';
  granted_scopes: string[];
  accepted_terms_version: string;
  target: string;
  expires_at: Date | null;
  validation_status: 'PENDING_VALIDATION' | 'VERIFIED' | 'INVALID';
  validation_actual_target: string | null;
  validation_actual_scopes: string[] | null;
  validation_terms_version: string | null;
  validated_at: Date | null;
  validation_valid_until: Date | null;
  validation_failure_code: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

const SAFE_COLUMNS = `id, tenant_id, workspace_id, adapter_version_id, status, granted_scopes,
  accepted_terms_version, target, expires_at, validation_status, validation_actual_target,
  validation_actual_scopes, validation_terms_version, validated_at, validation_valid_until,
  validation_failure_code, created_by_user_id, created_at, updated_at`;

export class PostgresChannelAuthorizationStore implements ChannelAuthorizationStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  create(input: Parameters<ChannelAuthorizationStore['create']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const inserted = await client.query<ChannelAuthorizationEligibilityRow>(
        `INSERT INTO channel_authorizations
          (id, tenant_id, workspace_id, adapter_version_id, status, secret_arn, granted_scopes,
            accepted_terms_version, target, expires_at, created_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7, $8, $9, $10, $11, $11)
         RETURNING ${SAFE_COLUMNS}`,
        [
          input.authorizationId,
          input.context.tenantId,
          input.context.workspaceId,
          input.adapterVersionId,
          input.secretArn,
          input.grantedScopes,
          input.acceptedTermsVersion,
          input.target,
          input.expiresAt,
          input.context.actorUserId,
          input.createdAt,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('CHANNEL_AUTHORIZATION_INSERT_NOT_RETURNED');
      await client.query(
        `INSERT INTO channel_authorization_validation_commands
          (id, tenant_id, workspace_id, authorization_id, status, created_at)
         VALUES ($1, $2, $3, $1, 'PENDING', $4)`,
        [input.authorizationId, input.context.tenantId, input.context.workspaceId, input.createdAt],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'CHANNEL_AUTHORIZATION_CREATED', 'CHANNEL_AUTHORIZATION', $5,
           'SUCCEEDED', jsonb_build_object(
             'adapterVersionId', $6::uuid,
             'grantedScopeCount', $7::integer,
             'acceptedTermsVersion', $8::text,
             'expiresAt', $9::timestamptz), $10)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.authorizationId,
          input.adapterVersionId,
          input.grantedScopes.length,
          input.acceptedTermsVersion,
          input.expiresAt,
          input.createdAt,
        ],
      );
      return toMetadata(row);
    });
  }

  revoke(input: Parameters<ChannelAuthorizationStore['revoke']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const transition = await client.query<{ changed: boolean }>(
        `SELECT revoke_channel_authorization($1, $2) AS changed`,
        [input.authorizationId, input.revokedAt],
      );
      const existing = await client.query<ChannelAuthorizationEligibilityRow>(
        `SELECT ${SAFE_COLUMNS}
         FROM channel_authorizations
         WHERE workspace_id = $1 AND id = $2 AND status = 'REVOKED'`,
        [input.context.workspaceId, input.authorizationId],
      );
      const row = existing.rows[0];
      if (row === undefined) return null;
      if (transition.rows[0]?.changed === true) {
        await client.query(
          `INSERT INTO audit_events
            (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
              outcome, metadata, occurred_at)
           VALUES ($1, $2, $3, $4, 'CHANNEL_AUTHORIZATION_REVOKED',
             'CHANNEL_AUTHORIZATION', $5, 'SUCCEEDED',
             jsonb_build_object('adapterVersionId', $6::uuid), $7)`,
          [
            input.auditEventId,
            input.context.tenantId,
            input.context.workspaceId,
            input.context.actorUserId,
            input.authorizationId,
            row.adapter_version_id,
            input.revokedAt,
          ],
        );
      }
      return toMetadata(row);
    });
  }

  list(input: Parameters<ChannelAuthorizationStore['list']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ChannelAuthorizationEligibilityRow>(
        `SELECT ${SAFE_COLUMNS}
         FROM channel_authorizations
         WHERE workspace_id = $1
         ORDER BY created_at DESC, id DESC`,
        [input.context.workspaceId],
      );
      return result.rows.map(toMetadata);
    });
  }

  findForTarget(input: Parameters<ChannelAuthorizationStore['findForTarget']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ChannelAuthorizationEligibilityRow>(
        `SELECT ${SAFE_COLUMNS}
         FROM channel_authorizations
         WHERE workspace_id = $1 AND adapter_version_id = $2 AND target = $3
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [input.context.workspaceId, input.adapterVersionId, input.target],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapEligibility(row);
    });
  }
}

function toMetadata(row: ChannelAuthorizationEligibilityRow): ChannelAuthorizationMetadata {
  const eligibility = mapEligibility(row);
  const snapshot = eligibility.validationSnapshot;
  return {
    ...eligibility,
    validationSnapshot:
      snapshot === null
        ? null
        : {
            actualTarget: snapshot.actualTarget,
            actualScopes: snapshot.actualScopes,
            acceptedTermsVersion: snapshot.acceptedTermsVersion,
            validatedAt: snapshot.validatedAt,
            validUntil: snapshot.validUntil,
          },
    secretConfigured: true,
  };
}

function mapEligibility(row: ChannelAuthorizationEligibilityRow): ChannelAuthorizationEligibility {
  const validationSnapshot =
    row.validation_status === 'VERIFIED' &&
    row.validation_actual_target !== null &&
    row.validation_actual_scopes !== null &&
    row.validation_terms_version !== null &&
    row.validated_at !== null &&
    row.validation_valid_until !== null
      ? {
          actualTarget: row.validation_actual_target,
          actualScopes: row.validation_actual_scopes,
          acceptedTermsVersion: row.validation_terms_version,
          validatedAt: row.validated_at.toISOString(),
          validUntil: row.validation_valid_until.toISOString(),
        }
      : null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    adapterVersionId: row.adapter_version_id,
    status: row.status,
    grantedScopes: row.granted_scopes,
    acceptedTermsVersion: row.accepted_terms_version,
    target: row.target,
    expiresAt: row.expires_at?.toISOString() ?? null,
    validationStatus: row.validation_status,
    validationSnapshot,
    validationFailureCode: row.validation_failure_code,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
