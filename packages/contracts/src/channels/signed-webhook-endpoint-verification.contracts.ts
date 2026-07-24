import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';
import {
  SignedWebhookKeyIdSchema,
  SignedWebhookSigningAlgorithmSchema,
  SignedWebhookUrlSchema,
} from './signed-webhook-target.contracts.js';

const UuidSchema = z.uuid();
const VerificationReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !hasControlCharacter(value), 'control characters are not allowed');

export const CreateSignedWebhookEndpointVerificationRequestSchema = z
  .object({
    channelDefinitionId: UuidSchema,
    endpointUrl: SignedWebhookUrlSchema,
    receiptUrl: SignedWebhookUrlSchema,
    algorithm: SignedWebhookSigningAlgorithmSchema,
    keyId: SignedWebhookKeyIdSchema,
    verificationReference: VerificationReferenceSchema,
  })
  .strict()
  .refine(
    ({ endpointUrl, receiptUrl }) => new URL(endpointUrl).origin === new URL(receiptUrl).origin,
    'delivery and receipt endpoints must share one verified origin',
  );

export const SignedWebhookEndpointVerificationPathParamsSchema = z
  .object({ verificationId: UuidSchema })
  .strict();

export const RevokeSignedWebhookEndpointVerificationRequestSchema = z.object({}).strict();
export const VerifySignedWebhookEndpointVerificationRequestSchema = z.object({}).strict();

export const SignedWebhookEndpointVerificationSchema = z
  .object({
    id: UuidSchema,
    channelDefinitionId: UuidSchema,
    status: z.enum(['PENDING', 'VERIFIED', 'REVOKED']),
    endpointUrl: SignedWebhookUrlSchema,
    receiptUrl: SignedWebhookUrlSchema,
    algorithm: SignedWebhookSigningAlgorithmSchema,
    keyId: SignedWebhookKeyIdSchema,
    verificationReference: VerificationReferenceSchema,
    createdAt: z.iso.datetime(),
    challengeExpiresAt: z.iso.datetime(),
    verifiedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .strict();

const ResponseMetaSchema = z
  .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();

export const SignedWebhookEndpointVerificationEnvelopeSchema = z
  .object({
    data: z.object({ verification: SignedWebhookEndpointVerificationSchema }).strict(),
    meta: ResponseMetaSchema,
  })
  .strict();

const SignedWebhookEndpointVerificationProofSchema = z
  .object({
    purpose: z.enum(['DELIVERY', 'RECEIPT', 'DELIVERY_AND_RECEIPT']),
    exactUrl: SignedWebhookUrlSchema,
    challenge: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
    challengeExpiresAt: z.iso.datetime(),
  })
  .strict();

const CreatedSignedWebhookEndpointVerificationSchema =
  SignedWebhookEndpointVerificationSchema.extend({
    proofs: z.array(SignedWebhookEndpointVerificationProofSchema).min(1).max(2),
  }).superRefine((verification, context) => {
    const expected =
      verification.endpointUrl === verification.receiptUrl
        ? [
            {
              purpose: 'DELIVERY_AND_RECEIPT',
              exactUrl: verification.endpointUrl,
            },
          ]
        : [
            { purpose: 'DELIVERY', exactUrl: verification.endpointUrl },
            { purpose: 'RECEIPT', exactUrl: verification.receiptUrl },
          ];
    const actual = verification.proofs.map(({ purpose, exactUrl }) => ({
      purpose,
      exactUrl,
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      context.addIssue({
        code: 'custom',
        message: 'proof challenges must bind every exact endpoint URL',
      });
    }
  });

export const CreatedSignedWebhookEndpointVerificationEnvelopeSchema = z
  .object({
    data: z
      .object({
        verification: CreatedSignedWebhookEndpointVerificationSchema,
      })
      .strict(),
    meta: ResponseMetaSchema,
  })
  .strict();

export const SignedWebhookEndpointVerificationListEnvelopeSchema = z
  .object({
    data: z.object({ verifications: z.array(SignedWebhookEndpointVerificationSchema) }).strict(),
    meta: ResponseMetaSchema,
  })
  .strict();

export type CreateSignedWebhookEndpointVerificationRequest = z.infer<
  typeof CreateSignedWebhookEndpointVerificationRequestSchema
>;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}
