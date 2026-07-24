import { randomUUID } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import { MissingDeletionReceiptTokenService } from '../../apps/api/src/privacy/deletion-receipt-token.js';
import { PrivacyController } from '../../apps/api/src/privacy/privacy.controller.js';

describe('Task 17 Privacy controller boundaries', () => {
  test('forwards the raw verified session cookie with the exact Owner context for export reads', async () => {
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const exportId = randomUUID();
    const context = {
      tenantId,
      workspaceId,
      actorUserId: randomUUID(),
      membershipId: randomUUID(),
      role: 'OWNER' as const,
    };
    const rawSessionToken = 'session-token';
    const readTenantExportArchive = vi.fn(() => Promise.resolve(null));
    const controller = new PrivacyController(
      {
        getSession: vi.fn(() => Promise.resolve({ subject: 'owner-subject' })),
      } as never,
      'http://127.0.0.1:3100',
      {} as never,
      { readTenantExportArchive } as never,
      {
        resolveTenantContext: vi.fn(() => Promise.resolve(context)),
      } as never,
      new MissingDeletionReceiptTokenService(),
    );
    const reply = replyDouble();

    await controller.downloadExport(
      tenantId,
      workspaceId,
      exportId,
      requestDouble(),
      reply as never,
    );

    expect(readTenantExportArchive).toHaveBeenCalledWith({
      sessionToken: rawSessionToken,
      context,
      exportId,
    });
  });

  test('fails closed before a durable deletion when receipt capability issuance is unavailable', async () => {
    const privacy = {
      requestTenantDeletion: vi.fn(() =>
        Promise.resolve({ outcome: 'SUCCEEDED', receipt: deletionReceipt() }),
      ),
    };
    const auth = {
      getSession: vi.fn(() => Promise.resolve({ subject: 'owner-subject' })),
      revokeSession: vi.fn(() => Promise.resolve()),
    };
    const controller = new PrivacyController(
      auth as never,
      'http://127.0.0.1:3100',
      privacy as never,
      {} as never,
      {} as never,
      new MissingDeletionReceiptTokenService(),
    );
    const reply = replyDouble();

    const response = await controller.deleteTenant(
      randomUUID(),
      randomUUID(),
      { reason: 'Owner-requested deletion.' },
      requestDouble(),
      reply as never,
    );

    expect(response).toMatchObject({ status: 503, code: 'DELETION_RECEIPT_UNAVAILABLE' });
    expect(privacy.requestTenantDeletion).not.toHaveBeenCalled();
    expect(auth.revokeSession).not.toHaveBeenCalled();
    expect(reply.clearCookie).not.toHaveBeenCalled();
  });

  test('never reports a durable accepted deletion as a failed mutation if token exposure faults', async () => {
    const receipt = deletionReceipt();
    const privacy = {
      requestTenantDeletion: vi.fn(() => Promise.resolve({ outcome: 'SUCCEEDED', receipt })),
    };
    const auth = {
      getSession: vi.fn(() => Promise.resolve({ subject: 'owner-subject' })),
      revokeSession: vi.fn(() => Promise.resolve()),
    };
    const controller = new PrivacyController(
      auth as never,
      'http://127.0.0.1:3100',
      privacy as never,
      {} as never,
      {} as never,
      {
        isReady: () => true,
        issue: () => {
          throw new Error('TOKEN_EXPOSURE_FAULT');
        },
        verify: () => null,
      },
    );
    const reply = replyDouble();

    const response = await controller.deleteTenant(
      randomUUID(),
      randomUUID(),
      { reason: 'Owner-requested deletion.' },
      requestDouble(),
      reply as never,
    );

    expect(response).toMatchObject({ data: { receipt } });
    expect(reply.statusCode).toBe(202);
    expect(privacy.requestTenantDeletion).toHaveBeenCalledOnce();
    expect(auth.revokeSession).toHaveBeenCalledWith('session-token');
    expect(reply.clearCookie).toHaveBeenCalled();
    expect(reply.header).toHaveBeenCalledWith('cache-control', 'private, no-store');
  });

  test('marks every authenticated privacy governance read as private and non-cacheable', async () => {
    const tenantId = randomUUID();
    const auth = {
      getSession: () => Promise.resolve({ subject: 'owner-subject' }),
      revokeSession: () => Promise.resolve(),
    };
    const privacy = {
      getPrivacyOverview: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED',
          overview: {
            tenantId,
            lifecycleState: 'ACTIVE',
            retention: {
              activeTenantDataDays: 30,
              backupCopyDays: 90,
              secretForceDeleteHours: 24,
              rawEvidenceDays: 180,
              screenshotDays: 90,
              applicationLogDays: 30,
              auditEvidenceDays: 365,
            },
            legalHolds: [],
            breakGlassGrants: [],
            latestAuditEventAt: null,
            latestDeletionReceipt: null,
          },
        }),
      listAuditEvents: () =>
        Promise.resolve({ outcome: 'SUCCEEDED', timeline: { events: [], nextCursor: null } }),
      listLegalHolds: () => Promise.resolve({ outcome: 'SUCCEEDED', holds: [] }),
      verifyAuditIntegrity: () =>
        Promise.resolve({ outcome: 'SUCCEEDED', valid: true, eventCount: 0, reason: null }),
    };
    const controller = new PrivacyController(
      auth as never,
      'http://127.0.0.1:3100',
      privacy as never,
      {} as never,
      {} as never,
      new MissingDeletionReceiptTokenService(),
    );
    const workspaceId = randomUUID();
    const reads = [
      (reply: ReturnType<typeof replyDouble>) =>
        controller.overview(tenantId, workspaceId, requestDouble(), reply as never),
      (reply: ReturnType<typeof replyDouble>) =>
        controller.auditEvents(
          tenantId,
          workspaceId,
          '2026-07-01T00:00:00.000Z',
          '2026-07-22T00:00:00.000Z',
          undefined,
          undefined,
          requestDouble(),
          reply as never,
        ),
      (reply: ReturnType<typeof replyDouble>) =>
        controller.legalHolds(tenantId, workspaceId, requestDouble(), reply as never),
      (reply: ReturnType<typeof replyDouble>) =>
        controller.auditIntegrity(tenantId, workspaceId, requestDouble(), reply as never),
    ];

    for (const read of reads) {
      const reply = replyDouble();
      await read(reply);
      expect(reply.header).toHaveBeenCalledWith('cache-control', 'private, no-store');
    }
  });
});

function deletionReceipt() {
  const requestedAt = new Date('2026-07-22T05:00:00.000Z');
  return {
    id: randomUUID(),
    scope: 'TENANT' as const,
    state: 'FROZEN' as const,
    requestedAt: requestedAt.toISOString(),
    secretForceDeleteBy: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    activeDeleteBy: new Date(requestedAt.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    backupDeleteBy: new Date(requestedAt.getTime() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
  };
}

function requestDouble() {
  return {
    cookies: { '__Host-aeo_session': 'session-token' },
    headers: { origin: 'http://127.0.0.1:3100' },
    id: 'task-17-controller-request',
  } as never;
}

function replyDouble() {
  return {
    statusCode: 200,
    code(status: number) {
      this.statusCode = status;
      return this;
    },
    clearCookie: vi.fn(),
    header: vi.fn(),
    send: vi.fn(),
    setCookie: vi.fn(),
  };
}
