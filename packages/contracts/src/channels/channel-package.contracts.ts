import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';

const UuidSchema = z.uuid();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const BuildChannelPackageRequestSchema = z
  .object({
    artifactId: UuidSchema,
    artifactRevisionId: UuidSchema,
    revision: z.number().int().positive(),
    expectedContentHash: Sha256Schema,
    channelKey: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9][a-z0-9._-]{0,159}$/),
  })
  .strict();

export const ChannelPackageFileSchema = z
  .object({
    path: z.string().min(1).max(500),
    mediaType: z.string().min(1).max(160),
    sha256: Sha256Schema,
    byteLength: z.number().int().positive(),
  })
  .strict();

export const ChannelPackageClaimSourceMapEntrySchema = z
  .object({
    claimId: UuidSchema,
    claimRevisionId: UuidSchema,
    claimContentHash: Sha256Schema,
    evidence: z.array(
      z
        .object({
          sourceId: UuidSchema,
          snapshotId: UuidSchema,
          sourceHash: Sha256Schema,
        })
        .strict(),
    ),
  })
  .strict();

export const ChannelPackageManifestSchema = z
  .object({
    schemaVersion: z.string().trim().min(1).max(80),
    files: z.array(ChannelPackageFileSchema).min(3),
    assetRefs: z.array(z.string().trim().min(1).max(2_048)),
    claimSourceMap: z.array(ChannelPackageClaimSourceMapEntrySchema),
  })
  .strict();

export const ChannelPackageArtifactSchema = z
  .object({
    artifactId: UuidSchema,
    artifactRevisionId: UuidSchema,
    revision: z.number().int().positive(),
    contentHash: Sha256Schema,
    type: z.enum(['DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE']),
    locale: z.string().min(2).max(35),
    market: z.string().min(1).max(120),
    methodPolicyVersion: z.string().min(1).max(160),
  })
  .strict();

export const ChannelPackageDocumentSchema = z
  .object({
    id: UuidSchema,
    packageRevision: z.number().int().positive(),
    packageChecksum: Sha256Schema,
    channel: z
      .object({ definitionId: UuidSchema, channelKey: z.string().min(1).max(160) })
      .strict(),
    transformer: z
      .object({ key: z.string().min(1).max(160), version: z.string().min(1).max(80) })
      .strict(),
    artifact: ChannelPackageArtifactSchema,
    manifest: ChannelPackageManifestSchema,
    preview: z
      .object({
        markdown: z.string().min(1),
        html: z.string().min(1),
        jsonLd: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

export const ChannelPackageEnvelopeSchema = z
  .object({
    data: z.object({ package: ChannelPackageDocumentSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const ChannelPackageExportSchema = z
  .object({
    id: UuidSchema,
    packageRevision: z.number().int().positive(),
    packageChecksum: Sha256Schema,
    manifest: ChannelPackageManifestSchema,
    channel: z
      .object({ definitionId: UuidSchema, channelKey: z.string().min(1).max(160) })
      .strict(),
    transformer: z
      .object({ key: z.string().min(1).max(160), version: z.string().min(1).max(80) })
      .strict(),
    artifact: ChannelPackageArtifactSchema,
    files: z
      .object({
        'content.md': z.string().min(1),
        'content.html': z.string().min(1),
        'structured-data.json': z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type BuildChannelPackageRequest = z.infer<typeof BuildChannelPackageRequestSchema>;
export type ChannelPackageEnvelope = z.infer<typeof ChannelPackageEnvelopeSchema>;
export type ChannelPackageExportContract = z.infer<typeof ChannelPackageExportSchema>;
