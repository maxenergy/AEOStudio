import { describe, expect, test } from 'vitest';

import { ProfileReadinessHandler } from './profile-readiness-handler.js';

describe('ProfileReadinessHandler', () => {
  test('returns the same revision-bound result for the same Profile snapshot', () => {
    const profile = {
      id: 'revision-1',
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      workspaceId: 'workspace-1',
      revision: 3,
      contentHash: 'sha256:fixture',
      displayName: 'Open Horizon',
      description: 'Industry-neutral fixture.',
      digitalAssets: [{ label: 'Website', url: 'https://example.test' }],
      targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      completeness: { completedFields: 4, totalFields: 4, percent: 100, missingFields: [] },
    };
    const handler = new ProfileReadinessHandler();

    expect(handler.execute(profile)).toEqual(handler.execute(structuredClone(profile)));
    expect(handler.execute(profile)).toEqual({
      readinessPercent: 100,
      completedFields: 4,
      totalFields: 4,
      missingFields: [],
      profileRevision: 3,
      contentHash: 'sha256:fixture',
    });
  });
});
