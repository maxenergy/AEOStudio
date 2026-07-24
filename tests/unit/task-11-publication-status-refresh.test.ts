import * as ChannelPublishing from '@aeostudio/application/channels-publishing';
import type { TenantContext } from '@aeostudio/application/identity-access';
import type { PublicationRecord } from '@aeostudio/domain/channels-publishing';
import { describe, expect, test, vi } from 'vitest';

const context: TenantContext = {
  tenantId: '00000000-0000-7000-8000-000000001101',
  workspaceId: '00000000-0000-7000-8000-000000001102',
  actorUserId: '00000000-0000-7000-8000-000000001103',
  membershipId: '00000000-0000-7000-8000-000000001104',
  role: 'PUBLISHER',
};

const publication: PublicationRecord = {
  id: '00000000-0000-7000-8000-000000001105',
  tenantId: context.tenantId,
  workspaceId: context.workspaceId,
  channelPackageId: '00000000-0000-7000-8000-000000001106',
  packageChecksum: 'a'.repeat(64),
  artifactRevisionId: '00000000-0000-7000-8000-000000001107',
  artifactContentHash: 'b'.repeat(64),
  adapterVersionId: '00000000-0000-7000-8000-000000001108',
  channelAuthorizationId: '00000000-0000-7000-8000-000000001109',
  target: 'git-pr:v1:fixture',
  idempotencyKey: 'task-11-status-refresh',
  requestHash: 'c'.repeat(64),
  status: 'REMOTE_APPLIED',
  jobId: '00000000-0000-7000-8000-000000001110',
  remoteRef: 'https://git.example.test/acme/site/pull/7',
  remoteState: {
    status: 'MERGED',
    number: 7,
    isProductionLive: false,
    rollbackHandle: null,
  },
  requestedByUserId: context.actorUserId,
  createdAt: '2026-07-21T08:00:00.000Z',
  updatedAt: '2026-07-21T08:05:00.000Z',
};

describe('Task 11 Publication remote status refresh authorization', () => {
  test('a current Publisher refreshes one existing Publication in its tenant and Workspace', async () => {
    const Service = serviceConstructor();

    expect(Service, 'expected an application-owned refresh command service').toBeTypeOf('function');
    if (Service === undefined) throw new Error('PublicationRemoteStatusRefreshService missing');

    const refresh = vi.fn().mockResolvedValue({ outcome: 'SUCCEEDED', publication });
    const appendDeniedAudit = vi.fn();
    const service = new Service(
      { refresh },
      {
        resolveTenantContext: vi.fn().mockResolvedValue(context),
        appendDeniedAudit,
      },
      { next: () => '00000000-0000-7000-8000-000000001111' },
    );

    await expect(
      service.refresh({
        actorSubject: 'oidc|publisher',
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        publicationId: publication.id,
      }),
    ).resolves.toEqual({ outcome: 'SUCCEEDED', publication });
    expect(refresh).toHaveBeenCalledWith({
      context,
      actorSubject: 'oidc|publisher',
      publicationId: publication.id,
    });
    expect(appendDeniedAudit).not.toHaveBeenCalled();
  });

  test.each(['REVIEWER', 'EDITOR'] as const)(
    'a current %s cannot call the remote Adapter status boundary',
    async (role) => {
      const Service = serviceConstructor();
      if (Service === undefined) throw new Error('PublicationRemoteStatusRefreshService missing');
      const refresh = vi.fn();
      const appendDeniedAudit = vi.fn();
      const restrictedContext: TenantContext = { ...context, role };
      const service = new Service(
        { refresh },
        {
          resolveTenantContext: vi.fn().mockResolvedValue(restrictedContext),
          appendDeniedAudit,
        },
        { next: () => '00000000-0000-7000-8000-000000001112' },
      );

      await expect(
        service.refresh({
          actorSubject: `oidc|${role.toLowerCase()}`,
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          publicationId: publication.id,
        }),
      ).resolves.toEqual({ outcome: 'FORBIDDEN' });
      expect(refresh).not.toHaveBeenCalled();
      expect(appendDeniedAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          context: restrictedContext,
          action: 'PUBLICATION_REMOTE_STATUS_REFRESH',
          resourceType: 'PUBLICATION',
        }),
      );
    },
  );
});

function serviceConstructor() {
  const Service = (
    ChannelPublishing as unknown as {
      PublicationRemoteStatusRefreshService?: new (
        store: {
          refresh(input: {
            context: TenantContext;
            actorSubject: string;
            publicationId: string;
          }): Promise<{ outcome: 'SUCCEEDED'; publication: PublicationRecord }>;
        },
        tenancy: {
          resolveTenantContext(input: {
            actorSubject: string;
            tenantId: string;
            workspaceId: string;
          }): Promise<TenantContext | null>;
          appendDeniedAudit(input: unknown): Promise<void>;
        },
        ids: { next(): string },
      ) => {
        refresh(input: {
          actorSubject: string;
          tenantId: string;
          workspaceId: string;
          publicationId: string;
        }): Promise<{ outcome: string; publication?: PublicationRecord }>;
      };
    }
  ).PublicationRemoteStatusRefreshService;
  expect(Service, 'expected an application-owned refresh command service').toBeTypeOf('function');
  return Service;
}
