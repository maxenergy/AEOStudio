import type {
  ActiveSignedWebhookEndpointVerification,
  PendingSignedWebhookEndpointVerification,
  SignedWebhookEndpointVerificationRecord,
  SignedWebhookEndpointVerificationStore,
} from '@aeostudio/application/channels-publishing';
import type { Pool } from 'pg';

import { TenantContextRunner } from '../tenant-context/index.js';

interface VerificationRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  channel_definition_id: string;
  status: 'PENDING' | 'VERIFIED' | 'REVOKED';
  endpoint_url: string;
  receipt_url: string;
  algorithm: 'HMAC_SHA256' | 'ED25519';
  key_id: string;
  verification_reference: string;
  challenge: string;
  challenge_expires_at: Date;
  receipt_challenge: string | null;
  receipt_challenge_expires_at: Date | null;
  created_by_user_id: string;
  created_at: Date;
  verified_by_user_id: string | null;
  verified_at: Date | null;
  revoked_at: Date | null;
}

const SAFE_COLUMNS = `id, tenant_id, workspace_id, channel_definition_id, status,
  endpoint_url, receipt_url, algorithm, key_id, verification_reference,
  challenge, challenge_expires_at, receipt_challenge, receipt_challenge_expires_at,
  created_by_user_id, created_at,
  verified_by_user_id, verified_at, revoked_at`;

export class PostgresSignedWebhookEndpointVerificationStore implements SignedWebhookEndpointVerificationStore {
  private readonly contexts: TenantContextRunner;

  constructor(private readonly pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  createPending(
    input: Parameters<SignedWebhookEndpointVerificationStore['createPending']>[0],
  ): Promise<PendingSignedWebhookEndpointVerification> {
    const proofs = exactProofColumns(input.endpointUrl, input.receiptUrl, input.proofs);
    return this.contexts.run(input.context, async (client) => {
      const inserted = await client.query<VerificationRow>(
        `INSERT INTO signed_webhook_endpoint_verifications
          (id, tenant_id, workspace_id, channel_definition_id, status,
           endpoint_url, receipt_url, algorithm, key_id, verification_reference,
           challenge, challenge_expires_at, receipt_challenge, receipt_challenge_expires_at,
           created_by_user_id, created_at, verified_by_user_id, verified_at, revoked_at)
         VALUES
          ($1, $2, $3, $4, 'PENDING', $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, NULL, NULL, NULL)
         RETURNING ${SAFE_COLUMNS}`,
        [
          input.verificationId,
          input.context.tenantId,
          input.context.workspaceId,
          input.channelDefinitionId,
          input.endpointUrl,
          input.receiptUrl,
          input.algorithm,
          input.keyId,
          input.verificationReference,
          proofs.delivery.challenge,
          proofs.delivery.challengeExpiresAt,
          proofs.receipt?.challenge ?? null,
          proofs.receipt?.challengeExpiresAt ?? null,
          input.context.actorUserId,
          input.createdAt,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_NOT_RETURNED');
      await appendAudit(client, {
        id: input.auditEventId,
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        actorUserId: input.context.actorUserId,
        action: 'SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_CHALLENGE_CREATED',
        resourceId: input.verificationId,
        outcome: 'SUCCEEDED',
        metadata: {
          channelDefinitionId: input.channelDefinitionId,
          challengeExpiresAt: proofs.delivery.challengeExpiresAt.toISOString(),
          proofCount: input.proofs.length,
        },
        occurredAt: input.createdAt,
      });
      return pendingFromRow(row);
    });
  }

  list(
    input: Parameters<SignedWebhookEndpointVerificationStore['list']>[0],
  ): Promise<SignedWebhookEndpointVerificationRecord[]> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<VerificationRow>(
        `SELECT ${SAFE_COLUMNS}
         FROM signed_webhook_endpoint_verifications
         WHERE workspace_id = $1
         ORDER BY created_at DESC, id DESC`,
        [input.context.workspaceId],
      );
      return result.rows.map(publicFromRow);
    });
  }

  findPending(
    input: Parameters<SignedWebhookEndpointVerificationStore['findPending']>[0],
  ): Promise<PendingSignedWebhookEndpointVerification | null> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<VerificationRow>(
        `SELECT ${SAFE_COLUMNS}
         FROM signed_webhook_endpoint_verifications
         WHERE workspace_id = $1 AND id = $2 AND status = 'PENDING'`,
        [input.context.workspaceId, input.verificationId],
      );
      const row = result.rows[0];
      return row === undefined ? null : pendingFromRow(row);
    });
  }

  markVerified(
    input: Parameters<SignedWebhookEndpointVerificationStore['markVerified']>[0],
  ): Promise<ActiveSignedWebhookEndpointVerification | null> {
    const expected = proofColumns(input.expectedProofs);
    return this.contexts.run(input.context, async (client) => {
      const updated = await client.query<VerificationRow>(
        `UPDATE signed_webhook_endpoint_verifications
         SET status = 'VERIFIED', verified_by_user_id = $3, verified_at = $4
         WHERE workspace_id = $1
           AND id = $2
           AND status = 'PENDING'
           AND challenge = $5
           AND challenge_expires_at = $6
           AND endpoint_url = $7
           AND receipt_challenge IS NOT DISTINCT FROM $8
           AND receipt_challenge_expires_at IS NOT DISTINCT FROM $9
           AND receipt_url = $10
           AND challenge_expires_at > $4
           AND (receipt_challenge_expires_at IS NULL OR receipt_challenge_expires_at > $4)
         RETURNING ${SAFE_COLUMNS}`,
        [
          input.context.workspaceId,
          input.verificationId,
          input.context.actorUserId,
          input.verifiedAt,
          expected.delivery.challenge,
          expected.delivery.challengeExpiresAt,
          expected.delivery.exactUrl,
          expected.receipt?.challenge ?? null,
          expected.receipt?.challengeExpiresAt ?? null,
          expected.receipt?.exactUrl ?? expected.delivery.exactUrl,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) return null;
      await appendAudit(client, {
        id: input.auditEventId,
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        actorUserId: input.context.actorUserId,
        action: 'SIGNED_WEBHOOK_ENDPOINT_OWNERSHIP_VERIFIED',
        resourceId: input.verificationId,
        outcome: 'SUCCEEDED',
        metadata: {
          channelDefinitionId: row.channel_definition_id,
          proofCount: row.receipt_challenge === null ? 1 : 2,
        },
        occurredAt: input.verifiedAt,
      });
      return activeFromRow(row);
    });
  }

  revoke(
    input: Parameters<SignedWebhookEndpointVerificationStore['revoke']>[0],
  ): Promise<SignedWebhookEndpointVerificationRecord | null> {
    return this.contexts.run(input.context, async (client) => {
      const updated = await client.query<VerificationRow>(
        `UPDATE signed_webhook_endpoint_verifications
         SET status = 'REVOKED', revoked_at = $3
         WHERE workspace_id = $1 AND id = $2 AND status IN ('PENDING', 'VERIFIED')
         RETURNING ${SAFE_COLUMNS}`,
        [input.context.workspaceId, input.verificationId, input.revokedAt],
      );
      const changed = updated.rows[0];
      if (changed !== undefined) {
        await appendAudit(client, {
          id: input.auditEventId,
          tenantId: input.context.tenantId,
          workspaceId: input.context.workspaceId,
          actorUserId: input.context.actorUserId,
          action: 'SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_REVOKED',
          resourceId: input.verificationId,
          outcome: 'SUCCEEDED',
          metadata: { channelDefinitionId: changed.channel_definition_id },
          occurredAt: input.revokedAt,
        });
        return publicFromRow(changed);
      }
      const existing = await client.query<VerificationRow>(
        `SELECT ${SAFE_COLUMNS}
         FROM signed_webhook_endpoint_verifications
         WHERE workspace_id = $1 AND id = $2 AND status = 'REVOKED'`,
        [input.context.workspaceId, input.verificationId],
      );
      const row = existing.rows[0];
      return row === undefined ? null : publicFromRow(row);
    });
  }

  findVerifiedEndpoint(
    input: Parameters<SignedWebhookEndpointVerificationStore['findVerifiedEndpoint']>[0],
  ): Promise<ActiveSignedWebhookEndpointVerification | null> {
    return this.contexts.run(
      {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        actorUserId: '00000000-0000-0000-0000-000000000000',
        membershipId: '00000000-0000-0000-0000-000000000000',
        role: 'PUBLISHER',
      },
      async (client) => {
        const result = await client.query<VerificationRow>(
          `SELECT ${SAFE_COLUMNS}
           FROM signed_webhook_endpoint_verifications
           WHERE workspace_id = $1
             AND channel_definition_id = $2
             AND id = $3
             AND status = 'VERIFIED'
             AND verified_at IS NOT NULL
             AND revoked_at IS NULL`,
          [input.workspaceId, input.channelDefinitionId, input.endpointVerificationId],
        );
        const row = result.rows[0];
        return row === undefined ? null : activeFromRow(row);
      },
    );
  }
}

function publicFromRow(row: VerificationRow): SignedWebhookEndpointVerificationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    channelDefinitionId: row.channel_definition_id,
    status: row.status,
    endpointUrl: row.endpoint_url,
    receiptUrl: row.receipt_url,
    algorithm: row.algorithm,
    keyId: row.key_id,
    verificationReference: row.verification_reference,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    challengeExpiresAt: earliestExpiration(row).toISOString(),
    verifiedAt: row.verified_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

function pendingFromRow(row: VerificationRow): PendingSignedWebhookEndpointVerification {
  const record = publicFromRow(row);
  if (record.status !== 'PENDING' || record.verifiedAt !== null || record.revokedAt !== null) {
    throw new Error('SIGNED_WEBHOOK_PENDING_VERIFICATION_STATE_INVALID');
  }
  return {
    ...record,
    status: 'PENDING',
    proofs: proofsFromRow(row),
    verifiedAt: null,
    revokedAt: null,
  };
}

function proofsFromRow(row: VerificationRow): PendingSignedWebhookEndpointVerification['proofs'] {
  if (row.endpoint_url === row.receipt_url) {
    if (row.receipt_challenge !== null || row.receipt_challenge_expires_at !== null) {
      throw new Error('SIGNED_WEBHOOK_COMBINED_PROOF_STATE_INVALID');
    }
    return [
      {
        purpose: 'DELIVERY_AND_RECEIPT',
        exactUrl: row.endpoint_url,
        challenge: row.challenge,
        challengeExpiresAt: row.challenge_expires_at.toISOString(),
      },
    ];
  }
  if (row.receipt_challenge === null || row.receipt_challenge_expires_at === null) {
    throw new Error('SIGNED_WEBHOOK_RECEIPT_PROOF_REQUIRED');
  }
  return [
    {
      purpose: 'DELIVERY',
      exactUrl: row.endpoint_url,
      challenge: row.challenge,
      challengeExpiresAt: row.challenge_expires_at.toISOString(),
    },
    {
      purpose: 'RECEIPT',
      exactUrl: row.receipt_url,
      challenge: row.receipt_challenge,
      challengeExpiresAt: row.receipt_challenge_expires_at.toISOString(),
    },
  ];
}

function exactProofColumns(
  endpointUrl: string,
  receiptUrl: string,
  proofs: Parameters<SignedWebhookEndpointVerificationStore['createPending']>[0]['proofs'],
) {
  const normalized = proofColumns(
    proofs.map((proof) => ({
      ...proof,
      challengeExpiresAt: proof.challengeExpiresAt.toISOString(),
    })),
  );
  if (
    normalized.delivery.exactUrl !== endpointUrl ||
    (normalized.receipt?.exactUrl ?? normalized.delivery.exactUrl) !== receiptUrl
  ) {
    throw new Error('SIGNED_WEBHOOK_PROOF_URL_MISMATCH');
  }
  return {
    delivery: {
      ...normalized.delivery,
      challengeExpiresAt: new Date(normalized.delivery.challengeExpiresAt),
    },
    receipt:
      normalized.receipt === null
        ? null
        : {
            ...normalized.receipt,
            challengeExpiresAt: new Date(normalized.receipt.challengeExpiresAt),
          },
  };
}

function proofColumns(proofs: PendingSignedWebhookEndpointVerification['proofs']): {
  delivery: PendingSignedWebhookEndpointVerification['proofs'][number];
  receipt: PendingSignedWebhookEndpointVerification['proofs'][number] | null;
} {
  if (proofs.length === 1 && proofs[0]?.purpose === 'DELIVERY_AND_RECEIPT') {
    return { delivery: proofs[0], receipt: null };
  }
  const delivery = proofs[0];
  const receipt = proofs[1];
  if (
    proofs.length !== 2 ||
    delivery?.purpose !== 'DELIVERY' ||
    receipt?.purpose !== 'RECEIPT' ||
    delivery.challenge === receipt.challenge
  ) {
    throw new Error('SIGNED_WEBHOOK_PROOF_SET_INVALID');
  }
  return { delivery, receipt };
}

function earliestExpiration(row: VerificationRow): Date {
  return row.receipt_challenge_expires_at !== null &&
    row.receipt_challenge_expires_at.getTime() < row.challenge_expires_at.getTime()
    ? row.receipt_challenge_expires_at
    : row.challenge_expires_at;
}

function activeFromRow(row: VerificationRow): ActiveSignedWebhookEndpointVerification {
  const record = publicFromRow(row);
  if (record.status !== 'VERIFIED' || record.verifiedAt === null || record.revokedAt !== null) {
    throw new Error('SIGNED_WEBHOOK_ACTIVE_VERIFICATION_STATE_INVALID');
  }
  return {
    ...record,
    endpointVerificationId: record.id,
    status: 'VERIFIED',
    verifiedAt: record.verifiedAt,
    revokedAt: null,
  };
}

async function appendAudit(
  client: {
    query(query: string, values: unknown[]): Promise<unknown>;
  },
  input: {
    id: string;
    tenantId: string;
    workspaceId: string;
    actorUserId: string;
    action: string;
    resourceId: string;
    outcome: string;
    metadata: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
       outcome, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, 'SIGNED_WEBHOOK_ENDPOINT_VERIFICATION', $6, $7, $8, $9)`,
    [
      input.id,
      input.tenantId,
      input.workspaceId,
      input.actorUserId,
      input.action,
      input.resourceId,
      input.outcome,
      JSON.stringify(input.metadata),
      input.occurredAt,
    ],
  );
}
