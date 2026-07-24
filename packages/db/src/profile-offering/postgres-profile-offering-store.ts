import type {
  CreateProfileStoreInput,
  ProfileOfferingStore,
  ProfileReadinessExecutionStore,
} from '@aeostudio/application/profile-offering';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import type {
  CompletenessSummary,
  OfferingContent,
  OfferingRevision,
  ProfileContent,
  ProfileRevision,
} from '@aeostudio/domain/profile-offering';
import type { Pool } from 'pg';

import { TenantContextRunner } from '../tenant-context/tenant-context-runner.js';

interface ProfileRevisionRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  profile_id: string;
  revision: number;
  content_hash: string;
  content: ProfileContent;
  completeness: CompletenessSummary;
}

interface OfferingRevisionRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  offering_id: string;
  profile_id: string;
  revision: number;
  content_hash: string;
  content: OfferingContent;
  completeness: CompletenessSummary;
}

export class PostgresProfileOfferingStore
  implements ProfileOfferingStore, ProfileReadinessExecutionStore
{
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  createProfile(input: CreateProfileStoreInput): Promise<ProfileRevision> {
    return this.contexts.run(input.context, async (client) => {
      await client.query(
        `INSERT INTO profiles (id, tenant_id, workspace_id, current_revision)
         VALUES ($1, $2, $3, 1)`,
        [input.profileId, input.context.tenantId, input.context.workspaceId],
      );
      const inserted = await client.query<ProfileRevisionRow>(
        `INSERT INTO profile_revisions
          (id, tenant_id, workspace_id, profile_id, revision, content_hash, content,
            completeness, created_by_user_id)
         VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, $7::jsonb, $8)
         RETURNING id, tenant_id, workspace_id, profile_id, revision, content_hash,
           content, completeness`,
        [
          input.revisionId,
          input.context.tenantId,
          input.context.workspaceId,
          input.profileId,
          input.contentHash,
          JSON.stringify(input.content),
          JSON.stringify(input.completeness),
          input.context.actorUserId,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata)
         VALUES ($1, $2, $3, $4, 'PROFILE_REVISION_CREATED', 'PROFILE', $5, 'SUCCEEDED',
           jsonb_build_object('revision', 1, 'contentHash', $6::text))`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.profileId,
          input.contentHash,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('PROFILE_REVISION_DID_NOT_RETURN_RESULT');
      }
      return this.mapProfile(row);
    });
  }

  createProfileRevision(
    input: Parameters<ProfileOfferingStore['createProfileRevision']>[0],
  ): Promise<ProfileRevision | null> {
    return this.contexts.run(input.context, async (client) => {
      const aggregate = await client.query<{ current_revision: number }>(
        `SELECT current_revision
         FROM profiles
         WHERE id = $1 AND workspace_id = $2
         FOR UPDATE`,
        [input.profileId, input.context.workspaceId],
      );
      const current = aggregate.rows[0];
      if (current === undefined) {
        return null;
      }
      const nextRevision = current.current_revision + 1;
      const inserted = await client.query<ProfileRevisionRow>(
        `INSERT INTO profile_revisions
          (id, tenant_id, workspace_id, profile_id, revision, content_hash, content,
            completeness, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
         RETURNING id, tenant_id, workspace_id, profile_id, revision, content_hash,
           content, completeness`,
        [
          input.revisionId,
          input.context.tenantId,
          input.context.workspaceId,
          input.profileId,
          nextRevision,
          input.contentHash,
          JSON.stringify(input.content),
          JSON.stringify(input.completeness),
          input.context.actorUserId,
        ],
      );
      await client.query('UPDATE profiles SET current_revision = $1 WHERE id = $2', [
        nextRevision,
        input.profileId,
      ]);
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata)
         VALUES ($1, $2, $3, $4, 'PROFILE_REVISION_CREATED', 'PROFILE', $5, 'SUCCEEDED',
           jsonb_build_object('revision', $6::integer, 'contentHash', $7::text))`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.profileId,
          nextRevision,
          input.contentHash,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('PROFILE_REVISION_DID_NOT_RETURN_RESULT');
      }
      return this.mapProfile(row);
    });
  }

  findProfileRevision(
    input: Parameters<ProfileOfferingStore['findProfileRevision']>[0],
  ): Promise<ProfileRevision | null> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ProfileRevisionRow>(
        `SELECT id, tenant_id, workspace_id, profile_id, revision, content_hash,
           content, completeness
         FROM profile_revisions
         WHERE profile_id = $1 AND revision = $2 AND workspace_id = $3`,
        [input.profileId, input.revision, input.context.workspaceId],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.mapProfile(row);
    });
  }

  loadCurrentProfile(job: JobRecord): Promise<ProfileRevision | null> {
    const context = {
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      actorUserId: job.id,
      membershipId: job.id,
      role: 'OWNER' as const,
    };
    return this.contexts.run(context, async (client) => {
      if (job.jobType !== 'PROFILE_READINESS') return null;
      const result = await client.query<ProfileRevisionRow>(
        `SELECT revision.id, revision.tenant_id, revision.workspace_id,
           revision.profile_id, revision.revision, revision.content_hash,
           revision.content, revision.completeness
         FROM profiles profile
         JOIN profile_revisions revision
           ON revision.tenant_id = profile.tenant_id
          AND revision.workspace_id = profile.workspace_id
          AND revision.profile_id = profile.id
          AND revision.revision = profile.current_revision
          WHERE profile.id = $1
            AND profile.workspace_id = $2
            AND profile.tenant_id = $3`,
        [job.aggregateId, job.workspaceId, job.tenantId],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.mapProfile(row);
    });
  }

  createOffering(
    input: Parameters<ProfileOfferingStore['createOffering']>[0],
  ): Promise<OfferingRevision | null> {
    return this.contexts.run(input.context, async (client) => {
      const profile = await client.query<{ id: string }>(
        'SELECT id FROM profiles WHERE id = $1 AND workspace_id = $2',
        [input.profileId, input.context.workspaceId],
      );
      if (profile.rows[0] === undefined) {
        return null;
      }
      await client.query(
        `INSERT INTO offerings
          (id, tenant_id, workspace_id, profile_id, current_revision)
         VALUES ($1, $2, $3, $4, 1)`,
        [input.offeringId, input.context.tenantId, input.context.workspaceId, input.profileId],
      );
      const inserted = await client.query<OfferingRevisionRow>(
        `INSERT INTO offering_revisions
          (id, tenant_id, workspace_id, offering_id, profile_id, revision, content_hash,
            content, completeness, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7::jsonb, $8::jsonb, $9)
         RETURNING id, tenant_id, workspace_id, offering_id, profile_id, revision,
           content_hash, content, completeness`,
        [
          input.revisionId,
          input.context.tenantId,
          input.context.workspaceId,
          input.offeringId,
          input.profileId,
          input.contentHash,
          JSON.stringify(input.content),
          JSON.stringify(input.completeness),
          input.context.actorUserId,
        ],
      );
      for (const entry of input.attributes) {
        await client.query(
          `INSERT INTO offering_attribute_definitions
            (id, tenant_id, workspace_id, offering_id, offering_revision_id, attribute_key,
              label, value_type, is_required)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            entry.definitionId,
            input.context.tenantId,
            input.context.workspaceId,
            input.offeringId,
            input.revisionId,
            entry.attribute.key,
            entry.attribute.label,
            entry.attribute.valueType,
            entry.attribute.required,
          ],
        );
        await client.query(
          `INSERT INTO offering_attribute_values
            (id, tenant_id, workspace_id, offering_revision_id, definition_id, value)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            entry.valueId,
            input.context.tenantId,
            input.context.workspaceId,
            input.revisionId,
            entry.definitionId,
            JSON.stringify(entry.attribute.value),
          ],
        );
      }
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata)
         VALUES ($1, $2, $3, $4, 'OFFERING_REVISION_CREATED', 'OFFERING', $5,
           'SUCCEEDED', jsonb_build_object('revision', 1, 'contentHash', $6::text))`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.offeringId,
          input.contentHash,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('OFFERING_REVISION_DID_NOT_RETURN_RESULT');
      }
      return this.mapOffering(row);
    });
  }

  createOfferingRevision(
    input: Parameters<ProfileOfferingStore['createOfferingRevision']>[0],
  ): Promise<OfferingRevision | null> {
    return this.contexts.run(input.context, async (client) => {
      const aggregate = await client.query<{ profile_id: string; current_revision: number }>(
        `SELECT profile_id, current_revision
         FROM offerings
         WHERE id = $1 AND workspace_id = $2
         FOR UPDATE`,
        [input.offeringId, input.context.workspaceId],
      );
      const current = aggregate.rows[0];
      if (current === undefined) {
        return null;
      }
      const nextRevision = current.current_revision + 1;
      const inserted = await client.query<OfferingRevisionRow>(
        `INSERT INTO offering_revisions
          (id, tenant_id, workspace_id, offering_id, profile_id, revision, content_hash,
            content, completeness, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
         RETURNING id, tenant_id, workspace_id, offering_id, profile_id, revision,
           content_hash, content, completeness`,
        [
          input.revisionId,
          input.context.tenantId,
          input.context.workspaceId,
          input.offeringId,
          current.profile_id,
          nextRevision,
          input.contentHash,
          JSON.stringify(input.content),
          JSON.stringify(input.completeness),
          input.context.actorUserId,
        ],
      );
      for (const entry of input.attributes) {
        await client.query(
          `INSERT INTO offering_attribute_definitions
            (id, tenant_id, workspace_id, offering_id, offering_revision_id, attribute_key,
              label, value_type, is_required)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            entry.definitionId,
            input.context.tenantId,
            input.context.workspaceId,
            input.offeringId,
            input.revisionId,
            entry.attribute.key,
            entry.attribute.label,
            entry.attribute.valueType,
            entry.attribute.required,
          ],
        );
        await client.query(
          `INSERT INTO offering_attribute_values
            (id, tenant_id, workspace_id, offering_revision_id, definition_id, value)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            entry.valueId,
            input.context.tenantId,
            input.context.workspaceId,
            input.revisionId,
            entry.definitionId,
            JSON.stringify(entry.attribute.value),
          ],
        );
      }
      await client.query('UPDATE offerings SET current_revision = $1 WHERE id = $2', [
        nextRevision,
        input.offeringId,
      ]);
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata)
         VALUES ($1, $2, $3, $4, 'OFFERING_REVISION_CREATED', 'OFFERING', $5,
           'SUCCEEDED', jsonb_build_object('revision', $6::integer, 'contentHash', $7::text))`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.offeringId,
          nextRevision,
          input.contentHash,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('OFFERING_REVISION_DID_NOT_RETURN_RESULT');
      }
      return this.mapOffering(row);
    });
  }

  findOfferingRevision(
    input: Parameters<ProfileOfferingStore['findOfferingRevision']>[0],
  ): Promise<OfferingRevision | null> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<OfferingRevisionRow>(
        `SELECT id, tenant_id, workspace_id, offering_id, profile_id, revision,
           content_hash, content, completeness
         FROM offering_revisions
         WHERE offering_id = $1 AND revision = $2 AND workspace_id = $3`,
        [input.offeringId, input.revision, input.context.workspaceId],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.mapOffering(row);
    });
  }

  private mapProfile(row: ProfileRevisionRow): ProfileRevision {
    return {
      id: row.id,
      profileId: row.profile_id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      revision: row.revision,
      contentHash: row.content_hash,
      completeness: row.completeness,
      ...row.content,
    };
  }

  private mapOffering(row: OfferingRevisionRow): OfferingRevision {
    return {
      id: row.id,
      offeringId: row.offering_id,
      profileId: row.profile_id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      revision: row.revision,
      contentHash: row.content_hash,
      completeness: row.completeness,
      ...row.content,
    };
  }
}
