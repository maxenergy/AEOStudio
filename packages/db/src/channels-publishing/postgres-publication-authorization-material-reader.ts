import type { PublicationAuthorizationMaterialReader } from '@aeostudio/application/channels-publishing';
import type { Pool } from 'pg';

interface PublicationAuthorizationMaterialRow {
  secret_reference: string;
  credential_fingerprint: string;
}

/**
 * Lifecycle-worker-only adapter. Its Pool must use the dedicated lifecycle login; the database
 * function, not this process, owns the sensitive-table read and validates the live Job lease.
 */
export class PostgresPublicationAuthorizationMaterialReader implements PublicationAuthorizationMaterialReader {
  public constructor(private readonly pool: Pool) {}

  public async readForPublication(
    input: Parameters<PublicationAuthorizationMaterialReader['readForPublication']>[0],
  ) {
    const lease = input.lease;
    const result = await this.pool.query<PublicationAuthorizationMaterialRow>(
      `SELECT secret_reference, credential_fingerprint
       FROM read_publication_authorization_material($1, $2, $3, $4, $5, $6)`,
      [
        lease.job.tenantId,
        lease.job.workspaceId,
        lease.job.aggregateId,
        lease.job.id,
        lease.messageId,
        lease.leaseToken,
      ],
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      row.secret_reference.length < 1 ||
      row.secret_reference.length > 2_048 ||
      !/^[a-f0-9]{64}$/u.test(row.credential_fingerprint)
    ) {
      return null;
    }
    return {
      secretReference: row.secret_reference,
      credentialFingerprint: row.credential_fingerprint,
    };
  }
}
