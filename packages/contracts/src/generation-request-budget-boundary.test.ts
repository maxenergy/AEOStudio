import { describe, expect, test } from 'vitest';

import { StartArtifactGenerationRequestSchema } from './artifacts/artifacts.contracts.js';
import { StartContentPlanRequestSchema } from './content-planning/content-planning.contracts.js';

const id = '00000000-0000-7000-8000-000000000001';

describe('generation request budget boundary', () => {
  test('Content Plan clients no longer have to supply a cost estimate', () => {
    expect(
      StartContentPlanRequestSchema.safeParse({
        profile: { id, revision: 1 },
        offering: { id, revision: 1 },
        promptSetId: id,
        promptRevisionId: id,
        primaryClaimRevisionIds: [id],
        comparisonClaimRevisionIds: [id],
        baselineId: id,
        methodPolicyVersion: 'content-plan-v1',
        idempotencyKey: 'server-estimated-content-plan',
      }).success,
    ).toBe(true);
  });

  test('Artifact clients no longer have to supply a cost estimate', () => {
    expect(
      StartArtifactGenerationRequestSchema.safeParse({
        briefId: id,
        locale: 'en-SG',
        market: 'SG',
        methodPolicyVersion: 'artifact-fixture-v1',
        idempotencyKey: 'server-estimated-artifact',
      }).success,
    ).toBe(true);
  });
});
