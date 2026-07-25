import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';

const MetaSchema = z
  .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();

// --- Candidates ---
export const WebsiteImportProfileCandidateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).default(''),
    websiteUrl: z.url({ protocol: /^https?$/ }),
    locale: z.string().trim().min(1).max(20),
    market: z.string().trim().min(1).max(10),
  })
  .strict();

export const WebsiteImportOfferingCandidateSchema = z
  .object({
    candidateId: z.uuid(),
    kind: z.string().trim().min(1).max(50),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).default(''),
    locale: z.string().trim().min(1).max(20),
    market: z.string().trim().min(1).max(10),
  })
  .strict();

export const WebsiteImportFaqCandidateSchema = z
  .object({
    candidateId: z.uuid(),
    question: z.string().trim().min(1).max(500),
    answer: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const WebsiteImportStatusSchema = z.enum(['PENDING_CONFIRMATION', 'CONFIRMED']);

// --- Session ---
export const WebsiteImportSessionSchema = z
  .object({
    importId: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    url: z.url({ protocol: /^https?$/ }),
    status: WebsiteImportStatusSchema,
    profile: WebsiteImportProfileCandidateSchema,
    offerings: z.array(WebsiteImportOfferingCandidateSchema).max(50),
    faqs: z.array(WebsiteImportFaqCandidateSchema).max(50),
    createdAt: z.iso.datetime(),
  })
  .strict();

// --- Request: start import ---
export const WebsiteImportRequestSchema = z
  .object({
    url: z.string().trim().min(1).max(500),
  })
  .strict();

// --- Envelope: session (start import response) ---
export const WebsiteImportEnvelopeSchema = z
  .object({
    data: z.object({ websiteImport: WebsiteImportSessionSchema }).strict(),
    meta: MetaSchema,
  })
  .strict();

// --- Request: confirm import ---
export const WebsiteImportConfirmRequestSchema = z
  .object({
    createProfile: z.boolean().default(true),
    offeringCandidateIds: z.array(z.uuid()).max(50).default([]),
  })
  .strict();

// --- Envelope: confirm import response ---
export const WebsiteImportConfirmEnvelopeSchema = z
  .object({
    data: z
      .object({
        importId: z.uuid(),
        profileId: z.uuid().nullable(),
        offeringIds: z.array(z.uuid()),
        pendingFaqs: z.array(WebsiteImportFaqCandidateSchema),
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();

export type WebsiteImportProfileCandidate = z.infer<typeof WebsiteImportProfileCandidateSchema>;
export type WebsiteImportOfferingCandidate = z.infer<typeof WebsiteImportOfferingCandidateSchema>;
export type WebsiteImportFaqCandidate = z.infer<typeof WebsiteImportFaqCandidateSchema>;
export type WebsiteImportStatus = z.infer<typeof WebsiteImportStatusSchema>;
export type WebsiteImportSession = z.infer<typeof WebsiteImportSessionSchema>;
export type WebsiteImportRequest = z.infer<typeof WebsiteImportRequestSchema>;
export type WebsiteImportEnvelope = z.infer<typeof WebsiteImportEnvelopeSchema>;
export type WebsiteImportConfirmRequest = z.infer<typeof WebsiteImportConfirmRequestSchema>;
export type WebsiteImportConfirmEnvelope = z.infer<typeof WebsiteImportConfirmEnvelopeSchema>;
