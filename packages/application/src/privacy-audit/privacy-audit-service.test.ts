import { createHash } from 'node:crypto';

import type { TenantContext, TenancyStore } from '@aeostudio/application/identity-access';
import { describe, expect, test } from 'vitest';

import type { PrivacyAuditStore } from './ports.js';
import { PrivacyAuditService } from './privacy-audit-service.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000017';
const WORKSPACE_ID = '00000000-0000-7000-8000-000000000018';
const USER_ID = '00000000-0000-7000-8000-000000000019';
const MEMBERSHIP_ID = '00000000-0000-7000-8000-000000000020';
const EXPORT_ID = '00000000-0000-7000-8000-000000000021';
const AUDIT_ID = '00000000-0000-7000-8000-000000000022';
const DELETION_ID = '00000000-0000-7000-8000-000000000025';
const HOLD_ID = '00000000-0000-7000-8000-000000000026';
const OBJECT_VERSION_ID = '00000000-0000-7000-8000-000000000027';
const SIBLING_VERSION_ID = '00000000-0000-7000-8000-000000000028';
const GRANT_ID = '00000000-0000-7000-8000-000000000029';
const OPERATOR_ID = '00000000-0000-7000-8000-000000000030';
const DIGEST_ID = '00000000-0000-7000-8000-000000000031';
const ACCESS_AUDIT_ID = '00000000-0000-7000-8000-000000000032';
const STORED_EXPORT_ID = '00000000-0000-7000-8000-000000000033';
const NOW = new Date('2026-07-22T04:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

describe('PrivacyAuditService', () => {
  test('builds a deterministic tenant-only export with object and file hashes', async () => {
    const context = ownerContext();
    let canonicalFiles: Array<{
      path: string;
      content: string;
      contentHash: string;
      byteLength: number;
    }> = [];
    const store = {
      loadTenantExportObjects: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId: TENANT_ID,
              workspaceId: null,
              kind: 'AUDIT_EVENT',
              objectId: '00000000-0000-7000-8000-000000000024',
              occurredAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
              payload: { action: 'TENANT_CREATED', tenantId: TENANT_ID },
            },
            {
              tenantId: TENANT_ID,
              workspaceId: WORKSPACE_ID,
              kind: 'PROFILE_REVISION',
              objectId: '00000000-0000-7000-8000-000000000023',
              occurredAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
              payload: { displayName: 'Industry-neutral product', tenantId: TENANT_ID },
            },
          ],
        }),
      saveTenantExport: (input: {
        exportId: string;
        createdAt: Date;
        canonicalFiles: Array<{
          path: string;
          content: string;
          contentHash: string;
          byteLength: number;
        }>;
      }) => {
        canonicalFiles = input.canonicalFiles;
        return Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          exportId: STORED_EXPORT_ID,
          created: false,
          archiveStatus: 'PENDING' as const,
          archiveReady: false as const,
          objectRef: null,
          createdAt: input.createdAt.toISOString(),
        });
      },
    } as unknown as PrivacyAuditStore;
    const service = new PrivacyAuditService(
      store,
      tenancy(context),
      sequenceIds(EXPORT_ID, AUDIT_ID),
      { now: () => new Date(NOW) },
    );

    const result = await service.exportTenant({
      actorSubject: 'owner-subject',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      from: '2026-07-01T00:00:00.000Z',
      to: new Date(NOW.getTime() - 1).toISOString(),
    });

    expect(result.outcome).toBe('SUCCEEDED');
    if (result.outcome !== 'SUCCEEDED') throw new Error('expected deterministic tenant export');
    expect(result.export.manifest.objects.map(({ kind }) => kind)).toEqual([
      'AUDIT_EVENT',
      'PROFILE_REVISION',
    ]);
    expect(result.export.manifest.files).toHaveLength(2);
    expect(result.export.manifest.disclosures.noGuarantee).toMatch(/not a guarantee/iu);
    expect(result.export.checksum).toBe(sha256(canonicalJson(result.export.manifest)));
    expect(result.export.id).toBe(STORED_EXPORT_ID);
    expect(result.export).toMatchObject({
      archiveStatus: 'PENDING',
      archiveReady: false,
      objectRef: null,
    });
    expect(canonicalFiles).toHaveLength(2);
    expect(canonicalFiles.map(({ path }) => path)).toEqual(
      result.export.manifest.files.map(({ path }) => path),
    );
    expect(canonicalFiles.every(({ content }) => content.startsWith('{'))).toBe(true);
    const canonicalEnvelopes = canonicalFiles.map(({ content, contentHash }) => ({
      envelope: JSON.parse(content) as {
        schemaVersion: string;
        tenantId: string;
        workspaceId: string | null;
        kind: string;
        objectId: string;
        payload: unknown;
      },
      content,
      contentHash,
    }));
    expect(canonicalEnvelopes.map(({ envelope }) => envelope.workspaceId)).toEqual([
      null,
      WORKSPACE_ID,
    ]);
    for (const { envelope, content, contentHash } of canonicalEnvelopes) {
      expect(envelope).toMatchObject({
        schemaVersion: 'tenant-export-object.v1',
        tenantId: TENANT_ID,
      });
      expect(contentHash).toBe(sha256(content));
    }
    expect(result.export.createdAt).toBe(NOW.toISOString());
  });

  test('exports an empty Tenant as a valid pending archive bundle', async () => {
    let savedCanonicalFiles: Array<{ path: string; content: string }> | null = null;
    const store = {
      loadTenantExportObjects: () =>
        Promise.resolve({ outcome: 'SUCCEEDED' as const, objects: [] }),
      saveTenantExport: (input: {
        createdAt: Date;
        canonicalFiles: Array<{ path: string; content: string }>;
      }) => {
        savedCanonicalFiles = input.canonicalFiles;
        return Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          exportId: STORED_EXPORT_ID,
          created: true,
          archiveStatus: 'PENDING' as const,
          archiveReady: false as const,
          objectRef: null,
          createdAt: input.createdAt.toISOString(),
        });
      },
    } as unknown as PrivacyAuditStore;
    const service = new PrivacyAuditService(
      store,
      tenancy(ownerContext()),
      sequenceIds(EXPORT_ID, AUDIT_ID),
      { now: () => new Date(NOW) },
    );

    const result = await service.exportTenant({
      actorSubject: 'owner-subject',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      from: '2026-07-01T00:00:00.000Z',
      to: new Date(NOW.getTime() - 1).toISOString(),
    });

    expect(result).toMatchObject({
      outcome: 'SUCCEEDED',
      export: {
        id: STORED_EXPORT_ID,
        manifest: { objects: [], files: [] },
        archiveStatus: 'PENDING',
        archiveReady: false,
        objectRef: null,
      },
    });
    expect(savedCanonicalFiles).toEqual([]);
  });

  test('rejects a future or equal export cutoff before reading Tenant objects', async () => {
    let loadCount = 0;
    const store = {
      loadTenantExportObjects: () => {
        loadCount += 1;
        return Promise.resolve({ outcome: 'SUCCEEDED' as const, objects: [] });
      },
    } as unknown as PrivacyAuditStore;
    const service = new PrivacyAuditService(store, tenancy(ownerContext()), sequenceIds(), {
      now: () => new Date(NOW),
    });

    for (const to of [NOW, new Date(NOW.getTime() + 1)]) {
      await expect(
        service.exportTenant({
          actorSubject: 'owner-subject',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          from: '2026-07-01T00:00:00.000Z',
          to: to.toISOString(),
        }),
      ).resolves.toEqual({ outcome: 'INVALID_TIME_RANGE' });
    }
    expect(loadCount).toBe(0);
  });

  test('returns a frozen deletion receipt with exact immediate lifecycle deadlines', async () => {
    const store = {
      requestTenantDeletion: (input: { requestId: string; requestedAt: Date }) =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          created: true,
          receipt: {
            id: input.requestId,
            scope: 'TENANT' as const,
            state: 'FROZEN' as const,
            requestedAt: input.requestedAt.toISOString(),
            secretForceDeleteBy: new Date(input.requestedAt.getTime() + DAY_MS).toISOString(),
            activeDeleteBy: new Date(input.requestedAt.getTime() + 30 * DAY_MS).toISOString(),
            backupDeleteBy: new Date(input.requestedAt.getTime() + 90 * DAY_MS).toISOString(),
          },
        }),
    } as unknown as PrivacyAuditStore;
    const service = new PrivacyAuditService(
      store,
      tenancy(ownerContext()),
      sequenceIds(DELETION_ID, AUDIT_ID),
      { now: () => new Date(NOW) },
    );

    const result = await service.requestTenantDeletion({
      actorSubject: 'owner-subject',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      reason: 'Owner-requested deletion.',
    });

    expect(result).toEqual({
      outcome: 'SUCCEEDED',
      receipt: {
        id: DELETION_ID,
        scope: 'TENANT',
        state: 'FROZEN',
        requestedAt: NOW.toISOString(),
        secretForceDeleteBy: new Date(NOW.getTime() + DAY_MS).toISOString(),
        activeDeleteBy: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
        backupDeleteBy: new Date(NOW.getTime() + 90 * DAY_MS).toISOString(),
      },
    });
  });

  test('applies a tenant-visible legal hold only to its exact object version', async () => {
    const holds: Array<Record<string, unknown>> = [];
    const objectKey = `tenants/${TENANT_ID}/audit/event.json`;
    const store = {
      createLegalHold: (input: {
        holdId: string;
        name: string;
        reason: string;
        objectKey: string;
        objectVersionId: string;
        createdAt: Date;
        context: TenantContext;
      }) => {
        const hold = {
          id: input.holdId,
          tenantId: input.context.tenantId,
          name: input.name,
          reason: input.reason,
          createdBy: input.context.actorUserId,
          visibleToTenant: true as const,
          target: { objectKey: input.objectKey, objectVersionId: input.objectVersionId },
          createdAt: input.createdAt.toISOString(),
          releasedAt: null,
        };
        holds.push(hold);
        return Promise.resolve({ outcome: 'SUCCEEDED' as const, hold, created: true });
      },
      listLegalHolds: () => Promise.resolve(structuredClone(holds)),
    } as unknown as PrivacyAuditStore;
    const service = new PrivacyAuditService(
      store,
      tenancy(ownerContext()),
      sequenceIds(HOLD_ID, AUDIT_ID),
      { now: () => new Date(NOW) },
    );

    const created = await service.createLegalHold({
      actorSubject: 'owner-subject',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Named preservation request',
      reason: 'Preserve this exact evidence version.',
      objectKey,
      objectVersionId: OBJECT_VERSION_ID,
    });
    expect(created.outcome).toBe('SUCCEEDED');
    await expect(
      service.evaluateRetention({
        actorSubject: 'owner-subject',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        objectClass: 'APPLICATION_LOG',
        objectKey,
        objectVersionId: OBJECT_VERSION_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ decision: 'LEGAL_HOLD', legalHold: { id: HOLD_ID } });
    await expect(
      service.evaluateRetention({
        actorSubject: 'owner-subject',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        objectClass: 'APPLICATION_LOG',
        objectKey,
        objectVersionId: SIBLING_VERSION_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ decision: 'EXPIRE', legalHold: null });
  });

  test('rejects a legal-hold reason above the shared 1000-character contract boundary', async () => {
    let storeCalls = 0;
    const store = {
      createLegalHold: () => {
        storeCalls += 1;
        return Promise.reject(new Error('invalid hold must not reach the store'));
      },
    } as unknown as PrivacyAuditStore;
    const service = new PrivacyAuditService(
      store,
      tenancy(ownerContext()),
      sequenceIds(HOLD_ID, AUDIT_ID),
      { now: () => new Date(NOW) },
    );

    await expect(
      service.createLegalHold({
        actorSubject: 'owner-subject',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        name: 'Contract boundary hold',
        reason: 'r'.repeat(1_001),
        objectKey: `tenants/${TENANT_ID}/audit/evidence.json`,
        objectVersionId: OBJECT_VERSION_ID,
      }),
    ).resolves.toEqual({ outcome: 'INVALID_HOLD' });
    expect(storeCalls).toBe(0);
  });

  test('fails closed when no trusted platform break-glass authorizer is installed', async () => {
    let grantCalls = 0;
    const store = {
      grantBreakGlass: () => {
        grantCalls += 1;
        throw new Error('the store must not be reached');
      },
    } as unknown as PrivacyAuditStore;
    const service = new PrivacyAuditService(store, tenancy(ownerContext()), sequenceIds(), {
      now: () => new Date(NOW),
    });
    const spoofedRequest = {
      actorSubject: 'owner-subject',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operatorId: OPERATOR_ID,
      operatorName: 'Body-controlled platform identity',
      reason: 'Incident INC-1701.',
      expiresAt: new Date(NOW.getTime() + 15 * 60 * 1_000).toISOString(),
      requestedAction: 'READ_SENSITIVE_EVIDENCE',
      resourceType: 'AUDIT_EVIDENCE',
      resourceId: OBJECT_VERSION_ID,
    };

    await expect(service.grantBreakGlass(spoofedRequest)).resolves.toEqual({
      outcome: 'FORBIDDEN',
    });
    expect(grantCalls).toBe(0);
  });

  test('commits a denied Audit decision when an untrusted actor attempts to grant break-glass', async () => {
    const deniedInputs: Array<Record<string, unknown>> = [];
    const store = {
      evaluateBreakGlassAccess: (input: Record<string, unknown>) => {
        deniedInputs.push({ ...input });
        return Promise.resolve({
          decision: 'DENY' as const,
          state: 'INVALID_GRANT' as const,
          grantId: input.grantId as string,
          operatorName: null,
          reason: null,
          auditEventId: input.auditEventId as string,
        });
      },
    } as unknown as PrivacyAuditStore;
    const service = new PrivacyAuditService(
      store,
      tenancy(ownerContext()),
      sequenceIds(GRANT_ID, AUDIT_ID),
      { now: () => new Date(NOW) },
    );

    await expect(
      service.grantBreakGlass({
        actorSubject: 'untrusted-platform-subject',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        reason: 'Attempted unauthorized support access.',
        expiresAt: new Date(NOW.getTime() + 15 * 60 * 1_000).toISOString(),
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: OBJECT_VERSION_ID,
      }),
    ).resolves.toEqual({ outcome: 'FORBIDDEN' });
    expect(deniedInputs).toEqual([
      expect.objectContaining({
        actorSubject: 'untrusted-platform-subject',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        grantId: GRANT_ID,
        operatorId: null,
        operatorName: null,
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: OBJECT_VERSION_ID,
        auditEventId: AUDIT_ID,
      }),
    ]);
  });

  test('binds a trusted platform principal and audits every exact break-glass access decision', async () => {
    let grantInput: Record<string, unknown> | null = null;
    const accessInputs: Array<Record<string, unknown>> = [];
    const expiresAt = new Date(NOW.getTime() + 15 * 60 * 1_000);
    const store = {
      grantBreakGlass: (input: {
        tenantId: string;
        workspaceId: string;
        grantId: string;
        operatorId: string;
        operatorName: string;
        reason: string;
        expiresAt: Date;
        requestedAction: string;
        resourceType: string;
        resourceId: string;
        auditEventId: string;
      }) => {
        grantInput = { ...input };
        const grant = {
          id: input.grantId,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          operatorId: input.operatorId,
          operatorName: input.operatorName,
          reason: input.reason,
          auditEventId: input.auditEventId,
          requestedAction: input.requestedAction,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          grantedAt: NOW.toISOString(),
          expiresAt: input.expiresAt.toISOString(),
          revokedAt: null,
        };
        return Promise.resolve({ outcome: 'SUCCEEDED' as const, created: true, grant });
      },
      evaluateBreakGlassAccess: (input: Record<string, unknown>) => {
        accessInputs.push({ ...input });
        return Promise.resolve({
          decision: 'ALLOW' as const,
          state: 'ACTIVE' as const,
          grantId: GRANT_ID,
          operatorName: 'Trusted Platform Operator',
          reason: 'Incident INC-1701.',
          auditEventId: input.auditEventId as string,
        });
      },
    } as unknown as PrivacyAuditStore;
    const authorizations: Array<Record<string, unknown>> = [];
    const service = new PrivacyAuditService(
      store,
      tenancy(ownerContext()),
      sequenceIds(GRANT_ID, AUDIT_ID, ACCESS_AUDIT_ID),
      { now: () => new Date(NOW) },
      {
        authorize: (input) => {
          authorizations.push({ ...input });
          return Promise.resolve({
            operatorId: OPERATOR_ID,
            operatorName: 'Trusted Platform Operator',
          });
        },
      },
    );

    const spoofedRequest = {
      actorSubject: 'platform-subject',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operatorId: '00000000-0000-7000-8000-000000000099',
      operatorName: 'Body-controlled identity',
      reason: 'Incident INC-1701.',
      expiresAt: expiresAt.toISOString(),
      requestedAction: 'READ_SENSITIVE_EVIDENCE',
      resourceType: 'AUDIT_EVIDENCE',
      resourceId: OBJECT_VERSION_ID,
    };
    const created = await service.grantBreakGlass(spoofedRequest);
    expect(created.outcome).toBe('SUCCEEDED');
    expect(grantInput).toMatchObject({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operatorId: OPERATOR_ID,
      operatorName: 'Trusted Platform Operator',
      requestedAction: 'READ_SENSITIVE_EVIDENCE',
      resourceType: 'AUDIT_EVIDENCE',
      resourceId: OBJECT_VERSION_ID,
    });
    await expect(
      service.evaluateBreakGlassAccess({
        actorSubject: 'platform-subject',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        grantId: GRANT_ID,
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: OBJECT_VERSION_ID,
      }),
    ).resolves.toEqual({
      decision: 'ALLOW',
      state: 'ACTIVE',
      grantId: GRANT_ID,
      operatorName: 'Trusted Platform Operator',
      reason: 'Incident INC-1701.',
      auditEventId: ACCESS_AUDIT_ID,
    });
    expect(accessInputs).toEqual([
      expect.objectContaining({
        actorSubject: 'platform-subject',
        operatorId: OPERATOR_ID,
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: OBJECT_VERSION_ID,
        auditEventId: ACCESS_AUDIT_ID,
      }),
    ]);
    expect(authorizations.map(({ operation }) => operation)).toEqual(['GRANT', 'EVALUATE']);
  });

  test('denies access when the mandatory decision audit cannot commit', async () => {
    const service = new PrivacyAuditService(
      {
        evaluateBreakGlassAccess: () => Promise.reject(new Error('audit sink unavailable')),
      } as unknown as PrivacyAuditStore,
      tenancy(ownerContext()),
      sequenceIds(ACCESS_AUDIT_ID),
      { now: () => new Date(NOW) },
      {
        authorize: () =>
          Promise.resolve({
            operatorId: OPERATOR_ID,
            operatorName: 'Trusted Platform Operator',
          }),
      },
    );

    await expect(
      service.evaluateBreakGlassAccess({
        actorSubject: 'platform-subject',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        grantId: GRANT_ID,
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: OBJECT_VERSION_ID,
      }),
    ).resolves.toEqual({
      decision: 'DENY',
      state: 'INVALID_GRANT',
      grantId: null,
      operatorName: null,
      reason: null,
      auditEventId: null,
    });
  });

  test('maps an invalid audit chain to an explicit tamper result', async () => {
    const store = {
      verifyAuditChain: () =>
        Promise.resolve({
          valid: false,
          eventCount: 3,
          lastSequence: 3,
          headHash: 'a'.repeat(64),
          reason: 'Audit chain digest mismatch.',
        }),
    } as unknown as PrivacyAuditStore;
    const service = new PrivacyAuditService(store, tenancy(ownerContext()), sequenceIds(), {
      now: () => new Date(NOW),
    });

    await expect(
      service.verifyAuditIntegrity({
        actorSubject: 'owner-subject',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toEqual({
      outcome: 'TAMPERED',
      valid: false,
      eventCount: 3,
      reason: 'Audit chain digest mismatch.',
    });
  });

  test('validates the tenant privacy overview and paginated audit events', async () => {
    const store = {
      getPrivacyOverview: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          overview: {
            tenantId: TENANT_ID,
            lifecycleState: 'ACTIVE' as const,
            retention: {
              activeTenantDataDays: 30 as const,
              backupCopyDays: 90 as const,
              secretForceDeleteHours: 24 as const,
              rawEvidenceDays: 180 as const,
              screenshotDays: 90 as const,
              applicationLogDays: 30 as const,
              auditEvidenceDays: 365 as const,
            },
            legalHolds: [],
            breakGlassGrants: [],
            latestAuditEventAt: null,
            latestDeletionReceipt: null,
          },
        }),
      listAuditEvents: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          timeline: {
            events: [
              {
                id: AUDIT_ID,
                tenantId: TENANT_ID,
                workspaceId: WORKSPACE_ID,
                sequence: 1,
                previousHash: null,
                eventHash: 'a'.repeat(64),
                actorKind: 'USER' as const,
                actorId: USER_ID,
                action: 'TENANT_CREATED',
                resourceType: 'TENANT',
                resourceId: TENANT_ID,
                outcome: 'SUCCEEDED',
                metadata: {},
                occurredAt: NOW.toISOString(),
              },
            ],
            nextCursor: null,
          },
        }),
    } as unknown as PrivacyAuditStore;
    const service = new PrivacyAuditService(store, tenancy(ownerContext()), sequenceIds(), {
      now: () => new Date(NOW),
    });

    await expect(
      service.getPrivacyOverview({
        actorSubject: 'owner-subject',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED', overview: { tenantId: TENANT_ID } });
    await expect(
      service.listAuditEvents({
        actorSubject: 'owner-subject',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-31T23:59:59.999Z',
        cursor: null,
        limit: 50,
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      timeline: { events: [{ id: AUDIT_ID }], nextCursor: null },
    });
  });

  test('accepts a self-verifiable atomic store digest using its authoritative seal clock', async () => {
    const rangeHeadHash = 'b'.repeat(64);
    const sealedAt = new Date('2026-07-22T08:00:00.000Z');
    const lockedUntil = new Date(sealedAt.getTime() + 365 * DAY_MS);
    const from = new Date('2026-07-01T00:00:00.000Z');
    const to = new Date('2026-07-22T07:59:59.999Z');
    const sealedInputs: unknown[] = [];
    const store = {
      verifyAuditRange: () => Promise.reject(new Error('seal must verify atomically in the store')),
      sealAuditDigest: (input: {
        context: TenantContext;
        digestId: string;
        from: Date;
        to: Date;
        auditEventId: string;
      }) => {
        sealedInputs.push(input);
        const digestPayload = {
          id: input.digestId,
          tenantId: input.context.tenantId,
          schemaVersion: 'audit-digest.v1' as const,
          timeRange: { from: input.from.toISOString(), to: input.to.toISOString() },
          eventCount: 2,
          lastSequence: 7,
          headHash: rangeHeadHash,
          lockedUntil: lockedUntil.toISOString(),
          sealedAt: sealedAt.toISOString(),
        };
        return Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          created: true,
          digest: {
            ...digestPayload,
            digestHash: sha256(canonicalJson(digestPayload)),
            objectRef: `s3+memory://audit-evidence/tenants/${TENANT_ID}/digests/${input.digestId}`,
            objectKey: `tenants/${TENANT_ID}/digests/${input.digestId}.json`,
            objectVersionId: OBJECT_VERSION_ID,
          },
        });
      },
    } as unknown as PrivacyAuditStore;
    const service = new PrivacyAuditService(
      store,
      tenancy(ownerContext()),
      sequenceIds(DIGEST_ID, AUDIT_ID),
      { now: () => new Date('2020-01-01T00:00:00.000Z') },
    );

    await expect(
      service.sealAuditDigest({
        actorSubject: 'owner-subject',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        from: from.toISOString(),
        to: to.toISOString(),
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      digest: {
        id: DIGEST_ID,
        eventCount: 2,
        lastSequence: 7,
        headHash: rangeHeadHash,
        lockedUntil: lockedUntil.toISOString(),
      },
    });
    expect(sealedInputs).toEqual([
      {
        context: ownerContext(),
        digestId: DIGEST_ID,
        from,
        to,
        auditEventId: AUDIT_ID,
      },
    ]);
  });
});

function ownerContext(): TenantContext {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    actorUserId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    role: 'OWNER',
  };
}

function tenancy(
  context: TenantContext,
): Pick<
  TenancyStore,
  'resolveTenantContext' | 'resolvePrivacyGovernanceContext' | 'appendDeniedAudit'
> {
  return {
    resolveTenantContext: () => Promise.resolve(context),
    resolvePrivacyGovernanceContext: () => Promise.resolve(context),
    appendDeniedAudit: () => Promise.resolve(),
  };
}

function sequenceIds(...values: string[]): { next(): string } {
  let offset = 0;
  return {
    next() {
      const value = values[offset];
      offset += 1;
      if (value === undefined) throw new Error('TEST_ID_SEQUENCE_EXHAUSTED');
      return value;
    },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
