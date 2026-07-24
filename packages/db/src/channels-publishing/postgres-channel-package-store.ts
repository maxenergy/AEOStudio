import type { ChannelPackageStore } from '@aeostudio/application/channels-publishing';
import type {
  ChannelPackageManifest,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';
import type { ArtifactType } from '@aeostudio/domain/artifacts';
import type { Pool } from 'pg';

import { TenantContextRunner } from '../tenant-context/index.js';
import { lockCurrentApprovedArtifactForPublication } from './postgres-current-approved-artifact-fence.js';

interface ChannelPackageRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  package_revision: number;
  channel_definition_id: string;
  channel_key: string;
  transformer_key: string;
  transformer_version: string;
  package_schema_version: string;
  artifact_id: string;
  artifact_revision_id: string;
  artifact_revision: number;
  artifact_content_hash: string;
  artifact_type: ArtifactType;
  artifact_locale: string;
  artifact_market: string;
  artifact_method_policy_version: string;
  manifest: ChannelPackageManifest;
  package_checksum: string;
  payload_object_ref: string;
  created_by_user_id: string;
  created_at: Date;
}

const SELECT_COLUMNS = `id, tenant_id, workspace_id, package_revision,
  channel_definition_id, channel_key, transformer_key, transformer_version,
  package_schema_version, artifact_id, artifact_revision_id, artifact_revision,
  artifact_content_hash, artifact_type, artifact_locale, artifact_market,
  artifact_method_policy_version, manifest, package_checksum, payload_object_ref,
  created_by_user_id, created_at`;

export class PostgresChannelPackageStore implements ChannelPackageStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  createOrFind(input: Parameters<ChannelPackageStore['createOrFind']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        [
          input.context.tenantId,
          input.context.workspaceId,
          input.artifact.artifactId,
          input.channel.definitionId,
        ].join(':'),
      ]);
      const currentApproval = await lockCurrentApprovedArtifactForPublication(client, {
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        artifactId: input.artifact.artifactId,
        artifactRevisionId: input.artifact.artifactRevisionId,
        revision: input.artifact.revision,
        contentHash: input.artifact.contentHash,
        effectiveAt: input.createdAt,
      });
      if (!currentApproval) {
        return { outcome: 'APPROVAL_STALE' as const };
      }
      const next = await client.query<{ package_revision: number }>(
        `SELECT COALESCE(MAX(package_revision), 0) + 1 AS package_revision
         FROM channel_packages
         WHERE workspace_id = $1 AND artifact_id = $2 AND channel_definition_id = $3`,
        [input.context.workspaceId, input.artifact.artifactId, input.channel.definitionId],
      );
      const packageRevision = next.rows[0]?.package_revision;
      if (packageRevision === undefined) throw new Error('CHANNEL_PACKAGE_REVISION_NOT_RETURNED');
      const inserted = await client.query<ChannelPackageRow>(
        `INSERT INTO channel_packages
          (id, tenant_id, workspace_id, package_revision, channel_definition_id, channel_key,
            transformer_key, transformer_version, package_schema_version, artifact_id,
            artifact_revision_id, artifact_revision, artifact_content_hash, artifact_type,
            artifact_locale, artifact_market, artifact_method_policy_version, manifest,
            package_checksum, payload_object_ref, created_by_user_id, created_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
            $17, $18::jsonb, $19, $20, $21, $22)
         ON CONFLICT
          (tenant_id, workspace_id, artifact_revision_id, artifact_content_hash,
            channel_definition_id, transformer_key, transformer_version, package_schema_version)
         DO NOTHING
         RETURNING ${SELECT_COLUMNS}`,
        [
          input.packageId,
          input.context.tenantId,
          input.context.workspaceId,
          packageRevision,
          input.channel.definitionId,
          input.channel.channelKey,
          input.transformer.key,
          input.transformer.version,
          input.packageSchemaVersion,
          input.artifact.artifactId,
          input.artifact.artifactRevisionId,
          input.artifact.revision,
          input.artifact.contentHash,
          input.artifact.type,
          input.artifact.locale,
          input.artifact.market,
          input.artifact.methodPolicyVersion,
          JSON.stringify(input.manifest),
          input.packageChecksum,
          input.payloadObjectRef,
          input.context.actorUserId,
          input.createdAt,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow !== undefined) {
        await client.query(
          `INSERT INTO audit_events
            (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
              outcome, metadata, occurred_at)
           VALUES ($1, $2, $3, $4, 'CHANNEL_PACKAGE_BUILT', 'CHANNEL_PACKAGE', $5,
             'SUCCEEDED', jsonb_build_object(
               'artifactId', $6::uuid,
               'artifactRevisionId', $7::uuid,
               'artifactRevision', $8::integer,
               'artifactContentHash', $9::text,
               'channelDefinitionId', $10::uuid,
               'channelKey', $11::text,
               'packageChecksum', $12::text), $13)`,
          [
            input.auditEventId,
            input.context.tenantId,
            input.context.workspaceId,
            input.context.actorUserId,
            input.packageId,
            input.artifact.artifactId,
            input.artifact.artifactRevisionId,
            input.artifact.revision,
            input.artifact.contentHash,
            input.channel.definitionId,
            input.channel.channelKey,
            input.packageChecksum,
            input.createdAt,
          ],
        );
        return { outcome: 'SUCCEEDED' as const, record: mapRow(insertedRow), created: true };
      }
      const existing = await client.query<ChannelPackageRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM channel_packages
         WHERE workspace_id = $1
           AND artifact_revision_id = $2
           AND artifact_content_hash = $3
           AND channel_definition_id = $4
           AND transformer_key = $5
           AND transformer_version = $6
           AND package_schema_version = $7`,
        [
          input.context.workspaceId,
          input.artifact.artifactRevisionId,
          input.artifact.contentHash,
          input.channel.definitionId,
          input.transformer.key,
          input.transformer.version,
          input.packageSchemaVersion,
        ],
      );
      const row = existing.rows[0];
      if (row === undefined) throw new Error('CHANNEL_PACKAGE_UPSERT_NOT_RETURNED');
      return { outcome: 'SUCCEEDED' as const, record: mapRow(row), created: false };
    });
  }

  findById(input: Parameters<ChannelPackageStore['findById']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ChannelPackageRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM channel_packages WHERE id = $1 AND workspace_id = $2`,
        [input.packageId, input.context.workspaceId],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapRow(row);
    });
  }
}

function mapRow(row: ChannelPackageRow): ChannelPackageRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    packageRevision: row.package_revision,
    channel: { definitionId: row.channel_definition_id, channelKey: row.channel_key },
    transformer: { key: row.transformer_key, version: row.transformer_version },
    packageSchemaVersion: row.package_schema_version,
    artifact: {
      artifactId: row.artifact_id,
      artifactRevisionId: row.artifact_revision_id,
      revision: row.artifact_revision,
      contentHash: row.artifact_content_hash,
      type: row.artifact_type,
      locale: row.artifact_locale,
      market: row.artifact_market,
      methodPolicyVersion: row.artifact_method_policy_version,
    },
    manifest: row.manifest,
    packageChecksum: row.package_checksum,
    payloadObjectRef: row.payload_object_ref,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
  };
}
