import * as ChannelApplication from '@aeostudio/application/channels-publishing';
import * as ChannelContracts from '@aeostudio/contracts/channels';
import type {
  PublicationAttemptRecord,
  PublicationRecord,
} from '@aeostudio/domain/channels-publishing';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import { describe, expect, test, vi } from 'vitest';

const tenantId = '00000000-0000-7000-8000-000000001201';
const workspaceId = '00000000-0000-7000-8000-000000001202';
const publicationId = '00000000-0000-7000-8000-000000001203';
const jobId = '00000000-0000-7000-8000-000000001204';

const publication: PublicationRecord = {
  id: publicationId,
  tenantId,
  workspaceId,
  channelPackageId: '00000000-0000-7000-8000-000000001205',
  packageChecksum: 'a'.repeat(64),
  artifactRevisionId: '00000000-0000-7000-8000-000000001206',
  artifactContentHash: 'b'.repeat(64),
  adapterVersionId: '00000000-0000-7000-8000-000000001207',
  channelAuthorizationId: '00000000-0000-7000-8000-000000001208',
  target: 'fixture://query/target',
  idempotencyKey: 'publication-query-fixture',
  requestHash: 'c'.repeat(64),
  status: 'PUBLISHED',
  jobId,
  remoteRef: `fake://remote/${publicationId}`,
  requestedByUserId: '00000000-0000-7000-8000-000000001209',
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:02.000Z',
};

const attempts: PublicationAttemptRecord[] = [
  {
    id: '00000000-0000-7000-8000-000000001210',
    tenantId,
    workspaceId,
    publicationId,
    attemptNumber: 1,
    operation: 'PUBLISH',
    outcome: 'AMBIGUOUS',
    remoteRef: null,
    errorCode: 'ADAPTER_PUBLISH_OUTCOME_UNKNOWN',
    startedAt: '2026-07-21T00:00:00.000Z',
    finishedAt: '2026-07-21T00:00:01.000Z',
  },
  {
    id: '00000000-0000-7000-8000-000000001211',
    tenantId,
    workspaceId,
    publicationId,
    attemptNumber: 2,
    operation: 'RECONCILE',
    outcome: 'APPLIED',
    remoteRef: `fake://remote/${publicationId}`,
    errorCode: null,
    startedAt: '2026-07-21T00:00:01.000Z',
    finishedAt: '2026-07-21T00:00:02.000Z',
  },
];

const job: JobRecord = {
  id: jobId,
  tenantId,
  workspaceId,
  providerKey: 'fixture-adapter',
  jobType: 'PUBLICATION',
  aggregateId: publicationId,
  status: 'SUCCEEDED',
  progress: 100,
  attempt: 1,
  maxAttempts: 3,
  budgetWarning: false,
  estimatedUnits: 5,
  heartbeatAt: '2026-07-21T00:00:02.000Z',
  result: {
    publicationId,
    publicationStatus: 'PUBLISHED',
    remoteRef: `fake://remote/${publicationId}`,
  },
  errorCode: null,
};

type QueryService = {
  get(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    publicationId: string;
  }): Promise<{
    publication: PublicationRecord;
    attempts: PublicationAttemptRecord[];
    job: JobRecord;
  } | null>;
};

type QueryServiceConstructor = new (
  store: {
    findDetail(input: {
      context: {
        tenantId: string;
        workspaceId: string;
        actorUserId: string;
        membershipId: string;
        role: 'VIEWER';
      };
      publicationId: string;
    }): Promise<{
      publication: PublicationRecord;
      attempts: PublicationAttemptRecord[];
      job: JobRecord;
    } | null>;
  },
  tenancy: {
    resolveTenantContext(input: {
      actorSubject: string;
      tenantId: string;
      workspaceId: string;
    }): Promise<{
      tenantId: string;
      workspaceId: string;
      actorUserId: string;
      membershipId: string;
      role: 'VIEWER';
    } | null>;
  },
) => QueryService;

describe('Task 10 Publication read model and eligibility contracts', () => {
  test('a Workspace reader can query the durable Publication, ordered attempts, and Job without secret material', async () => {
    const Constructor = (
      ChannelApplication as unknown as { PublicationQueryService?: QueryServiceConstructor }
    ).PublicationQueryService;
    expect(
      Constructor,
      'expected a Workspace-scoped PublicationQueryService instead of UI-owned publication state',
    ).toBeTypeOf('function');
    if (Constructor === undefined) throw new Error('PUBLICATION_QUERY_SERVICE_UNAVAILABLE');

    const context = {
      tenantId,
      workspaceId,
      actorUserId: '00000000-0000-7000-8000-000000001212',
      membershipId: '00000000-0000-7000-8000-000000001213',
      role: 'VIEWER' as const,
    };
    const findDetail = vi.fn().mockResolvedValue({ publication, attempts, job });
    const service = new Constructor(
      { findDetail },
      { resolveTenantContext: vi.fn().mockResolvedValue(context) },
    );

    const result = await service.get({
      actorSubject: 'fixture-viewer',
      tenantId,
      workspaceId,
      publicationId,
    });
    expect(result).toEqual({ publication, attempts, job });
    expect(findDetail).toHaveBeenCalledWith({ context, publicationId });
    expect(JSON.stringify(result)).not.toMatch(/secretArn|secretValue|credential/i);
  });

  test('an unresolved Tenant context is opaque and never reaches the query store', async () => {
    const Constructor = (
      ChannelApplication as unknown as { PublicationQueryService?: QueryServiceConstructor }
    ).PublicationQueryService;
    expect(Constructor).toBeTypeOf('function');
    if (Constructor === undefined) throw new Error('PUBLICATION_QUERY_SERVICE_UNAVAILABLE');
    const findDetail = vi.fn();
    const service = new Constructor(
      { findDetail },
      { resolveTenantContext: vi.fn().mockResolvedValue(null) },
    );
    await expect(
      service.get({
        actorSubject: 'cross-tenant-viewer',
        tenantId,
        workspaceId,
        publicationId,
      }),
    ).resolves.toBeNull();
    expect(findDetail).not.toHaveBeenCalled();
  });

  test('strict eligibility and Publication detail envelopes expose no command-only or secret fields', () => {
    const contracts = ChannelContracts as unknown as {
      CheckPublicationEligibilitySchema?: {
        safeParse(value: unknown): { success: boolean };
      };
      PublicationEligibilityEnvelopeSchema?: { parse(value: unknown): unknown };
      PublicationDetailEnvelopeSchema?: { parse(value: unknown): unknown };
    };
    expect(
      contracts.CheckPublicationEligibilitySchema,
      'expected a side-effect-free eligibility request contract',
    ).toBeDefined();
    expect(contracts.PublicationEligibilityEnvelopeSchema).toBeDefined();
    expect(contracts.PublicationDetailEnvelopeSchema).toBeDefined();
    expect(
      contracts.CheckPublicationEligibilitySchema?.safeParse({
        channelPackageId: publication.channelPackageId,
        adapterVersionId: publication.adapterVersionId,
        target: publication.target,
        expectedPackageChecksum: publication.packageChecksum,
        idempotencyKey: 'must-not-be-accepted-by-a-read-only-check',
      }).success,
      'eligibility checks must reject command-only idempotency fields',
    ).toBe(false);
  });

  test('the publication command rejects client-supplied cost estimates', () => {
    const schema = (
      ChannelContracts as unknown as {
        RequestPublicationSchema: { safeParse(value: unknown): { success: boolean } };
      }
    ).RequestPublicationSchema;
    const input = {
      channelPackageId: publication.channelPackageId,
      adapterVersionId: publication.adapterVersionId,
      target: publication.target,
      expectedPackageChecksum: publication.packageChecksum,
      idempotencyKey: 'server-priced-publication',
    };

    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, estimatedUnits: 1 }).success).toBe(false);
  });
});
