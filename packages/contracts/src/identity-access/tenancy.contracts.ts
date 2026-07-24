import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';

export const TenantRoleSchema = z.enum([
  'OWNER',
  'ADMIN',
  'EDITOR',
  'REVIEWER',
  'PUBLISHER',
  'ANALYST',
  'VIEWER',
]);

export const CreateTenantRequestSchema = z
  .object({
    tenantName: z.string().trim().min(1).max(120),
    workspaceName: z.string().trim().min(1).max(120),
  })
  .strict();

export const CreateTenantEnvelopeSchema = z
  .object({
    data: z
      .object({
        tenant: z.object({ id: z.uuid(), name: z.string().min(1) }).strict(),
        workspace: z.object({ id: z.uuid(), tenantId: z.uuid(), name: z.string().min(1) }).strict(),
        membership: z
          .object({
            id: z.uuid(),
            tenantId: z.uuid(),
            workspaceId: z.uuid(),
            userId: z.uuid(),
            role: TenantRoleSchema,
            status: z.enum(['PENDING', 'ACTIVE', 'REVOKED']),
          })
          .strict(),
      })
      .strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const WorkspaceAccessEnvelopeSchema = z
  .object({
    data: z
      .object({
        workspace: z.object({ id: z.uuid(), tenantId: z.uuid(), name: z.string().min(1) }).strict(),
        activeRole: TenantRoleSchema,
      })
      .strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const WorkspaceListEnvelopeSchema = z
  .object({
    data: z
      .object({
        workspaces: z.array(
          z
            .object({
              tenant: z.object({ id: z.uuid(), name: z.string().min(1) }).strict(),
              workspace: z
                .object({ id: z.uuid(), tenantId: z.uuid(), name: z.string().min(1) })
                .strict(),
              membershipId: z.uuid(),
              activeRole: TenantRoleSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const InviteMembershipRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    role: TenantRoleSchema,
  })
  .strict();

export const ChangeMembershipRoleRequestSchema = z
  .object({
    role: TenantRoleSchema,
  })
  .strict();

export const MembershipEnvelopeSchema = z
  .object({
    data: z
      .object({
        membership: z
          .object({
            id: z.uuid(),
            tenantId: z.uuid(),
            workspaceId: z.uuid(),
            userId: z.uuid(),
            email: z.string().email(),
            role: TenantRoleSchema,
            status: z.enum(['PENDING', 'ACTIVE', 'REVOKED']),
          })
          .strict(),
      })
      .strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;
export type CreateTenantEnvelope = z.infer<typeof CreateTenantEnvelopeSchema>;
export type WorkspaceListEnvelope = z.infer<typeof WorkspaceListEnvelopeSchema>;
export type MembershipEnvelope = z.infer<typeof MembershipEnvelopeSchema>;
