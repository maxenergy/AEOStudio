import { z } from 'zod';

export const SCHEMA_VERSION = '1.0.0' as const;

export const ProblemDetailsSchema = z
  .object({
    type: z.string().url(),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    detail: z.string(),
    requestId: z.string().min(1),
    retryable: z.boolean(),
  })
  .passthrough();

export const SessionEnvelopeSchema = z
  .object({
    data: z
      .object({
        email: z.string().email(),
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    meta: z
      .object({
        requestId: z.string().min(1),
        schemaVersion: z.literal(SCHEMA_VERSION),
      })
      .strict(),
  })
  .strict();

export const HealthEnvelopeSchema = z
  .object({
    data: z.object({ status: z.enum(['alive', 'ready']) }).strict(),
    meta: z
      .object({
        requestId: z.string().min(1),
        schemaVersion: z.literal(SCHEMA_VERSION),
      })
      .strict(),
  })
  .strict();

export const RuntimeBuildIdentitySchema = z
  .object({
    schemaVersion: z.literal('aeostudio.runtime-build-identity.v1'),
    source: z.literal('ecs-container-metadata-v4'),
    service: z.enum(['api', 'web', 'worker']),
    taskArn: z.string().min(1).max(2_048),
    taskDefinitionArn: z.string().min(1).max(2_048),
    containerArn: z.string().min(1).max(2_048),
    image: z.string().min(1).max(2_048),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    capturedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const RuntimeBuildIdentityEnvelopeSchema = z
  .object({
    data: z.object({ identity: RuntimeBuildIdentitySchema }).strict(),
    meta: z
      .object({
        requestId: z.string().min(1),
        schemaVersion: z.literal(SCHEMA_VERSION),
      })
      .strict(),
  })
  .strict();

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
export type SessionEnvelope = z.infer<typeof SessionEnvelopeSchema>;
export type HealthEnvelope = z.infer<typeof HealthEnvelopeSchema>;
export type RuntimeBuildIdentityContract = z.infer<typeof RuntimeBuildIdentitySchema>;
export type RuntimeBuildIdentityEnvelope = z.infer<typeof RuntimeBuildIdentityEnvelopeSchema>;
