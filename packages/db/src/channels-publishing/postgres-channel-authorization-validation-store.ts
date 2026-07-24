import type {
  ChannelAuthorizationValidationCommandStore,
  ChannelAuthorizationValidationLease,
} from '@aeostudio/application/channels-publishing';
import type { Pool } from 'pg';

interface ValidationLeaseRow {
  command_id: string;
  tenant_id: string;
  workspace_id: string;
  authorization_id: string;
  channel_definition_id: string;
  adapter_version_id: string;
  adapter_key: string;
  adapter_version: string;
  target: string;
  requested_scopes: string[];
  accepted_terms_version: string;
  secret_reference: string;
  authorization_expires_at: Date | null;
  worker_id: string;
  lease_token: string;
  lease_expires_at: Date;
}

/** Worker-only adapter for the security-definer validation command functions. */
export class PostgresChannelAuthorizationValidationStore implements ChannelAuthorizationValidationCommandStore {
  constructor(private readonly pool: Pool) {}

  async claimNext(
    input: Parameters<ChannelAuthorizationValidationCommandStore['claimNext']>[0],
  ): Promise<ChannelAuthorizationValidationLease | null> {
    const result = await this.pool.query<ValidationLeaseRow>(
      `SELECT * FROM claim_channel_authorization_validation($1, $2, $3, $4)`,
      [input.workerId, input.leaseToken, input.now, input.leaseUntil],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          commandId: row.command_id,
          tenantId: row.tenant_id,
          workspaceId: row.workspace_id,
          authorizationId: row.authorization_id,
          channelDefinitionId: row.channel_definition_id,
          adapterVersionId: row.adapter_version_id,
          adapterKey: row.adapter_key,
          adapterVersion: row.adapter_version,
          target: row.target,
          requestedScopes: row.requested_scopes,
          acceptedTermsVersion: row.accepted_terms_version,
          secretReference: row.secret_reference,
          authorizationExpiresAt: row.authorization_expires_at?.toISOString() ?? null,
          workerId: row.worker_id,
          leaseToken: row.lease_token,
          leaseExpiresAt: row.lease_expires_at.toISOString(),
        };
  }

  async completeVerified(
    input: Parameters<ChannelAuthorizationValidationCommandStore['completeVerified']>[0],
  ): Promise<boolean> {
    const result = await this.pool.query<{ completed: boolean }>(
      `SELECT complete_channel_authorization_validation_verified(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      ) AS completed`,
      [
        input.lease.commandId,
        input.lease.tenantId,
        input.lease.workspaceId,
        input.lease.authorizationId,
        input.lease.workerId,
        input.lease.leaseToken,
        input.actualTarget,
        input.actualScopes,
        input.acceptedTermsVersion,
        input.credentialFingerprint,
        input.validatedAt,
        input.validUntil,
      ],
    );
    return result.rows[0]?.completed === true;
  }

  async completeInvalid(
    input: Parameters<ChannelAuthorizationValidationCommandStore['completeInvalid']>[0],
  ): Promise<boolean> {
    const result = await this.pool.query<{ completed: boolean }>(
      `SELECT complete_channel_authorization_validation_invalid(
        $1, $2, $3, $4, $5, $6, $7, $8
      ) AS completed`,
      [
        input.lease.commandId,
        input.lease.tenantId,
        input.lease.workspaceId,
        input.lease.authorizationId,
        input.lease.workerId,
        input.lease.leaseToken,
        input.failureCode,
        input.validatedAt,
      ],
    );
    return result.rows[0]?.completed === true;
  }
}
