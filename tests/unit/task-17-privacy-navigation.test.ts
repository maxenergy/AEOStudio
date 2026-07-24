import { describe, expect, test } from 'vitest';

import { auditTimelineNavigation } from '../../apps/web/src/app/app/privacy/privacy-navigation.js';

describe('Task 17 Privacy workbench navigation', () => {
  test('exposes the server-issued next Audit cursor and a route back to the latest page', () => {
    const tenantId = '019b7653-cfb0-7000-8000-000000000001';
    const workspaceId = '019b7653-cfb0-7000-8000-000000000002';
    const navigation = auditTimelineNavigation({
      tenantId,
      workspaceId,
      currentCursor: 'current/cursor',
      nextCursor: 'next/cursor+opaque',
    });

    expect(navigation.latestHref).toBe(`/app/privacy?tenant=${tenantId}&workspace=${workspaceId}`);
    expect(navigation.nextHref).toBe(
      `/app/privacy?tenant=${tenantId}&workspace=${workspaceId}&auditCursor=next%2Fcursor%2Bopaque`,
    );
  });
});
