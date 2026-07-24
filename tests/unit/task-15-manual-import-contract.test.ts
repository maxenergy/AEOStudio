import { randomUUID } from 'node:crypto';

import {
  ManualMeasurementImportDetailEnvelopeSchema,
  MeasurementProviderPolicyStateEnvelopeSchema,
  StartMeasurementRunRequestSchema,
  SubmitManualMeasurementImportRequestSchema,
} from '@aeostudio/contracts/measurement';
import { describe, expect, test } from 'vitest';

describe('Task 15 reviewed manual import contracts', () => {
  test('returns typed Provider policy eligibility without inventing an approval', () => {
    const envelope = {
      data: {
        state: {
          providerKey: 'user-selected-provider',
          surfaceKey: 'user-selected-surface',
          requiredAdapterVersion: 'adapter-v1',
          requiredTermsVersion: 'terms-v1',
          requiresAuthorization: true,
          eligible: false,
          reasons: ['POLICY_MISSING'],
          policy: null,
        },
      },
      meta: { requestId: 'request-policy-1', schemaVersion: '1.0.0' },
    };

    expect(MeasurementProviderPolicyStateEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      MeasurementProviderPolicyStateEnvelopeSchema.safeParse({
        ...envelope,
        data: { state: { ...envelope.data.state, reasons: ['APPROVED_BY_DEFAULT'] } },
      }).success,
    ).toBe(false);
  });

  test('returns a typed immutable slot manifest for substantive review', () => {
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const promptId = randomUUID();
    const manualImport = {
      id: randomUUID(),
      tenantId,
      workspaceId,
      schemaVersion: 'measurement-manual-import.v1',
      promptSetId: randomUUID(),
      promptRevisionId: randomUUID(),
      promptContentHash: 'a'.repeat(64),
      scenarioId: randomUUID(),
      scenarioContentHash: 'b'.repeat(64),
      providerKey: 'user-selected-provider',
      surfaceKey: 'user-selected-surface',
      adapterVersion: 'manual-import-v1',
      acquisitionClass: 'MANUAL_IMPORT',
      acquisitionMethod: 'MANUAL_IMPORT',
      status: 'SUBMITTED',
      contentHash: 'c'.repeat(64),
      expectedSlotCount: 1,
      providedSlotCount: 1,
      costCurrency: 'USD',
      submittedByUserId: randomUUID(),
      submittedAt: '2026-07-21T12:00:00.000Z',
      reviewedByUserId: null,
      reviewedAt: null,
      reviewNote: null,
    } as const;
    const slot = {
      prompt: { id: promptId, ordinal: 1, text: 'How does this workspace offering work?' },
      scope: { market: 'SG', locale: 'en-SG', region: 'Singapore' },
      scopeKey: 'SG|en-SG|Singapore',
      repetition: 1,
      provided: true,
      observedAt: '2026-07-21T12:00:00.000Z',
      result: {
        status: 'PASS',
        observation: { mention: true, citation: true, accuracy: 'MATCH', coverage: true },
        cost: { amount: '0.001000', currency: 'USD' },
        rawEvidence: {
          responseText: 'A reviewed answer.',
          citations: [
            { url: 'https://example.test/evidence', title: 'Evidence', snippet: 'Exact evidence.' },
          ],
          error: null,
        },
      },
      rawEvidenceContentHash: 'd'.repeat(64),
      contentHash: 'e'.repeat(64),
    } as const;
    const envelope = {
      data: { manualImport, slots: [slot] },
      meta: { requestId: 'request-1', schemaVersion: '1.0.0' },
    };

    expect(ManualMeasurementImportDetailEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      ManualMeasurementImportDetailEnvelopeSchema.safeParse({
        ...envelope,
        data: { ...envelope.data, slots: [{ ...slot, contentHash: undefined }] },
      }).success,
    ).toBe(false);
  });

  test('requires a non-empty bounded evidence batch and rejects oversized raw responses', () => {
    const source = {
      schemaVersion: 'measurement-manual-import.v1',
      promptSetId: randomUUID(),
      promptRevisionId: randomUUID(),
      scenarioId: randomUUID(),
      expectedPromptHash: 'a'.repeat(64),
      expectedScenarioHash: 'b'.repeat(64),
      idempotencyKey: randomUUID(),
    } as const;
    expect(
      SubmitManualMeasurementImportRequestSchema.safeParse({ ...source, entries: [] }).success,
    ).toBe(false);
    expect(
      SubmitManualMeasurementImportRequestSchema.safeParse({
        ...source,
        entries: [
          {
            promptId: randomUUID(),
            scope: { market: 'SG', locale: 'en-SG', region: 'Singapore' },
            repetition: 1,
            observedAt: '2026-07-21T12:00:00.000Z',
            result: {
              status: 'PASS',
              observation: {
                mention: true,
                citation: false,
                accuracy: 'MATCH',
                coverage: true,
              },
              cost: { amount: '0.000000', currency: 'USD' },
              rawEvidence: {
                responseText: 'x'.repeat(2_000_001),
                citations: [],
                error: null,
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  test('requires manual import id and optimistic content hash as an exact pair', () => {
    const start = {
      promptSetId: randomUUID(),
      promptRevisionId: randomUUID(),
      scenarioId: randomUUID(),
      expectedPromptHash: 'a'.repeat(64),
      expectedScenarioHash: 'b'.repeat(64),
      kind: 'BASELINE',
      idempotencyKey: randomUUID(),
    } as const;
    expect(StartMeasurementRunRequestSchema.safeParse(start).success).toBe(true);
    expect(
      StartMeasurementRunRequestSchema.safeParse({ ...start, manualImportId: randomUUID() })
        .success,
    ).toBe(false);
    expect(
      StartMeasurementRunRequestSchema.safeParse({
        ...start,
        manualImportId: randomUUID(),
        expectedManualImportHash: 'c'.repeat(64),
      }).success,
    ).toBe(true);
  });
});
