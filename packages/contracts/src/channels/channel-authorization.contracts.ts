import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';

const SingaporeSecretArnSchema = z
  .string()
  .regex(/^arn:aws[a-zA-Z-]*:secretsmanager:ap-southeast-1:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/);

const GrantedScopesSchema = z
  .array(z.string().trim().min(1).max(160))
  .max(100)
  .refine((scopes) => new Set(scopes).size === scopes.length, 'Scopes must be unique.');

export const CreateChannelAuthorizationRequestSchema = z
  .object({
    adapterVersionId: z.uuid(),
    target: z.string().trim().min(1).max(2_048),
    grantedScopes: GrantedScopesSchema,
    acceptedTermsVersion: z.string().trim().min(1).max(120),
    secretArn: SingaporeSecretArnSchema,
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export const RevokeChannelAuthorizationRequestSchema = z.object({}).strict();

export const ChannelAuthorizationPathParamsSchema = z
  .object({ authorizationId: z.uuid() })
  .strict();

export const ChannelAuthorizationMetadataSchema = z
  .object({
    id: z.uuid(),
    adapterVersionId: z.uuid(),
    status: z.enum(['ACTIVE', 'REVOKED']),
    target: z.string().min(1).max(2_048),
    grantedScopes: z.array(z.string().min(1).max(160)),
    acceptedTermsVersion: z.string().min(1).max(120),
    expiresAt: z.iso.datetime().nullable(),
    validationStatus: z.enum(['PENDING_VALIDATION', 'VERIFIED', 'INVALID']),
    validationSnapshot: z
      .object({
        actualTarget: z.string().min(1).max(2_048),
        actualScopes: GrantedScopesSchema,
        acceptedTermsVersion: z.string().min(1).max(120),
        validatedAt: z.iso.datetime(),
        validUntil: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    validationFailureCode: z.string().trim().min(1).max(120).nullable(),
    secretConfigured: z.literal(true),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const ResponseMetaSchema = z
  .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();

export const ChannelAuthorizationEnvelopeSchema = z
  .object({
    data: z.object({ authorization: ChannelAuthorizationMetadataSchema }).strict(),
    meta: ResponseMetaSchema,
  })
  .strict();

export const ChannelAuthorizationListEnvelopeSchema = z
  .object({
    data: z.object({ authorizations: z.array(ChannelAuthorizationMetadataSchema) }).strict(),
    meta: ResponseMetaSchema,
  })
  .strict();

export type CreateChannelAuthorizationRequest = z.infer<
  typeof CreateChannelAuthorizationRequestSchema
>;
export type RevokeChannelAuthorizationRequest = z.infer<
  typeof RevokeChannelAuthorizationRequestSchema
>;
export type ChannelAuthorizationEnvelope = z.infer<typeof ChannelAuthorizationEnvelopeSchema>;
