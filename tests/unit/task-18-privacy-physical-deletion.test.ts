import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import { PrivacyLifecycleWorker } from '../../apps/worker/src/privacy-lifecycle-worker.js';

const NOW = new Date('2026-07-22T10:00:00.000Z');

describe('Task 18 privacy lifecycle physical object deletion', () => {
  test.each([
    ['TENANT_EXPORT', 'ON', 'holdExportVersion'],
    ['TENANT_EXPORT', 'OFF', 'releaseExportVersionHold'],
    ['AUDIT_DIGEST', 'ON', 'holdAuditVersion'],
    ['AUDIT_DIGEST', 'OFF', 'releaseAuditVersionHold'],
  ] as const)(
    'reconciles durable %s legal-hold intent %s before deletion work',
    async (objectClass, desiredStatus, effectName) => {
      const tenantId = randomUUID();
      const leaseToken = randomUUID();
      const objectKey = `tenants/${tenantId}/legal-hold/exact.json`;
      const objectVersionId = 'exact-version';
      const store = lifecycleStore({
        claimPendingLegalHoldReconciliations: () =>
          Promise.resolve([
            {
              tenantId,
              objectClass,
              objectKey,
              objectVersionId,
              desiredStatus,
              revision: 7,
              leaseToken,
              leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
            },
          ]),
      });
      const objects = objectStorage();

      await expect(createWorker(store, objects).runOnce()).resolves.toMatchObject({
        claimedLegalHoldReconciliations: 1,
        reconciledLegalHoldObjectVersions: 1,
        failed: 0,
      });
      expect(objects[effectName]).toHaveBeenCalledWith({
        tenantId,
        objectKey,
        objectVersionId,
        holdId: 'legal-hold-reconciliation:7',
      });
      expect(store.completeLegalHoldReconciliation).toHaveBeenCalledWith({
        tenantId,
        objectKey,
        objectVersionId,
        desiredStatus,
        revision: 7,
        leaseToken,
      });
    },
  );

  test('passes the exact legal-hold claim authority to the capability gateway without a legacy effect fallback', async () => {
    const tenantId = randomUUID();
    const leaseToken = randomUUID();
    const objectKey = `tenants/${tenantId}/exports/exact.json`;
    const objectVersionId = 'exact-version';
    const store = lifecycleStore({
      claimPendingLegalHoldReconciliations: () =>
        Promise.resolve([
          {
            tenantId,
            objectClass: 'TENANT_EXPORT' as const,
            objectKey,
            objectVersionId,
            desiredStatus: 'ON' as const,
            revision: 7,
            leaseToken,
            leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
          },
        ]),
    });
    const objects = objectStorage();
    const reconcileAuthorizedObjectLegalHold = vi.fn(() => Promise.resolve(true));
    const worker = new PrivacyLifecycleWorker(
      store,
      {
        requestForceDelete: () => Promise.resolve(),
        verifyUnreadable: () => Promise.resolve(true),
      },
      {
        clock: { now: () => new Date(NOW) },
        ids: { next: randomUUID },
        objects,
        lifecycleGateway: {
          reconcileAuthorizedObjectLegalHold,
        },
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimedLegalHoldReconciliations: 1,
      reconciledLegalHoldObjectVersions: 1,
      failed: 0,
    });
    expect(reconcileAuthorizedObjectLegalHold).toHaveBeenCalledWith({
      source: {
        tenantId,
        objectKey,
        objectVersionId,
        leaseToken,
      },
      expected: {
        scopeKind: 'TENANT',
        workspaceId: null,
        objectClass: 'TENANT_EXPORTS',
        desiredStatus: 'ON',
        revision: 7,
      },
    });
    expect(objects.holdExportVersion).not.toHaveBeenCalled();
    expect(objects.releaseExportVersionHold).not.toHaveBeenCalled();
    expect(store.completeLegalHoldReconciliation).toHaveBeenCalledWith({
      tenantId,
      objectKey,
      objectVersionId,
      desiredStatus: 'ON',
      revision: 7,
      leaseToken,
    });
  });

  test('does not acknowledge a failed remote legal-hold effect and releases its lease for retry', async () => {
    const tenantId = randomUUID();
    const leaseToken = randomUUID();
    const objectKey = `tenants/${tenantId}/legal-hold/retry.json`;
    const objectVersionId = 'retry-version';
    const store = lifecycleStore({
      claimPendingLegalHoldReconciliations: () =>
        Promise.resolve([
          {
            tenantId,
            objectClass: 'TENANT_EXPORT',
            objectKey,
            objectVersionId,
            desiredStatus: 'ON',
            revision: 1,
            leaseToken,
            leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
          },
        ]),
    });
    const objects = objectStorage({ holdExportVersion: () => Promise.resolve(false) });

    await expect(createWorker(store, objects).runOnce()).resolves.toMatchObject({
      reconciledLegalHoldObjectVersions: 0,
      failed: 1,
    });
    expect(store.completeLegalHoldReconciliation).not.toHaveBeenCalled();
    expect(store.releaseLegalHoldReconciliationLease).toHaveBeenCalledWith({
      tenantId,
      objectKey,
      objectVersionId,
      leaseToken,
    });
  });

  test('checkpoints complete export and audit version inventories before deletion finalization', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const exportVersion = {
      objectKey: `tenants/${tenantId}/exports/orphan.json`,
      objectVersionId: 'export-orphan-v1',
    };
    const auditVersion = {
      objectKey: `tenants/${tenantId}/audit-digests/orphan.json`,
      objectVersionId: 'audit-orphan-v1',
    };
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      getDeletionObjectInventoryTarget: () =>
        Promise.resolve({ outcome: 'REQUIRED' as const, target: { requestId, tenantId } }),
      finalizeDeletion: vi.fn(() => Promise.resolve(succeededFinalization(requestId))),
    });
    const objects = objectStorage({
      listPrivacyObjectVersions: vi.fn((input: { bucket: 'TENANT_EXPORTS' | 'AUDIT_EVIDENCE' }) =>
        Promise.resolve({
          versions: [input.bucket === 'TENANT_EXPORTS' ? exportVersion : auditVersion],
          nextCursor: null,
        }),
      ),
    });

    await expect(createWorker(store, objects).runOnce()).resolves.toMatchObject({
      claimedDeletions: 1,
      finalizedDeletions: 1,
      failed: 0,
    });
    expect(objects.listPrivacyObjectVersions).toHaveBeenCalledTimes(2);
    expect(store.recordDeletionObjectInventory).toHaveBeenCalledWith({
      requestId,
      leaseToken,
      exportVersions: [exportVersion],
      auditVersions: [auditVersion],
    });
    expect(store.finalizeDeletion).toHaveBeenCalledOnce();
  });

  test('commits one bounded workload inventory page per lease before finalization', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const getPage = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'REQUIRED' as const,
        target: {
          requestId,
          tenantId,
          scopeKind: 'WORKSPACE' as const,
          workspaceId,
          bucket: 'WORKLOAD_OBJECTS' as const,
          cursor: null,
        },
      })
      .mockResolvedValueOnce({
        outcome: 'REQUIRED' as const,
        target: {
          requestId,
          tenantId,
          scopeKind: 'WORKSPACE' as const,
          workspaceId,
          bucket: 'WORKLOAD_OBJECTS' as const,
          cursor: 'page-2',
        },
      });
    const recordPage = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'PROGRESS' as const })
      .mockResolvedValueOnce({ outcome: 'COMPLETE' as const });
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      getDeletionObjectInventoryPageTarget: getPage,
      recordDeletionObjectInventoryPage: recordPage,
      finalizeDeletion: vi.fn(() => Promise.resolve(succeededFinalization(requestId))),
    });
    const version = {
      objectKey: `tenants/${tenantId}/workspaces/${workspaceId}/unknown/object.bin`,
      objectVersionId: 'workload-v1',
      workspaceId,
    };
    const list = vi
      .fn()
      .mockResolvedValueOnce({ versions: [version], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ versions: [], nextCursor: null });
    const objects = objectStorage({ listPrivacyObjectVersions: list });
    const worker = createWorker(store, objects);

    await expect(worker.runOnce()).resolves.toMatchObject({ finalizedDeletions: 0, failed: 0 });
    await expect(worker.runOnce()).resolves.toMatchObject({ finalizedDeletions: 1, failed: 0 });
    expect(list).toHaveBeenNthCalledWith(1, {
      tenantId,
      workspaceId,
      bucket: 'WORKLOAD_OBJECTS',
      cursor: null,
      limit: 100,
    });
    expect(recordPage).toHaveBeenNthCalledWith(1, {
      requestId,
      leaseToken,
      bucket: 'WORKLOAD_OBJECTS',
      cursor: null,
      nextCursor: 'page-2',
      versions: [version],
    });
    expect(store.releaseDeletionLease).toHaveBeenCalledOnce();
  });

  test('passes the exact deletion request lease and database-selected scope to capability inventory', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const version = {
      objectKey: `tenants/${tenantId}/workspaces/${workspaceId}/unknown/object.bin`,
      objectVersionId: 'workload-v1',
      workspaceId,
    };
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      getDeletionObjectInventoryPageTarget: () =>
        Promise.resolve({
          outcome: 'REQUIRED' as const,
          target: {
            requestId,
            tenantId,
            scopeKind: 'WORKSPACE' as const,
            workspaceId,
            bucket: 'WORKLOAD_OBJECTS' as const,
            cursor: null,
          },
        }),
      recordDeletionObjectInventoryPage: vi.fn(() =>
        Promise.resolve({ outcome: 'COMPLETE' as const }),
      ),
      finalizeDeletion: vi.fn(() => Promise.resolve(succeededFinalization(requestId))),
    });
    const objects = objectStorage();
    const listAuthorizedObjectVersions = vi.fn(() =>
      Promise.resolve({ versions: [version], nextCursor: null }),
    );
    const worker = new PrivacyLifecycleWorker(
      store,
      {
        requestForceDelete: () => Promise.resolve(),
        verifyUnreadable: () => Promise.resolve(true),
      },
      {
        clock: { now: () => new Date(NOW) },
        ids: { next: randomUUID },
        objects,
        lifecycleGateway: { listAuthorizedObjectVersions },
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimedDeletions: 1,
      finalizedDeletions: 1,
      failed: 0,
    });
    expect(listAuthorizedObjectVersions).toHaveBeenCalledWith({
      source: { requestId, leaseToken },
      expected: {
        tenantId,
        scopeKind: 'WORKSPACE',
        workspaceId,
        objectClass: 'WORKLOAD_OBJECTS',
      },
    });
    expect(objects.listPrivacyObjectVersions).not.toHaveBeenCalled();
    expect(store.recordDeletionObjectInventoryPage).toHaveBeenCalledWith({
      requestId,
      leaseToken,
      bucket: 'WORKLOAD_OBJECTS',
      cursor: null,
      nextCursor: null,
      versions: [version],
    });
  });

  test('deletes an unknown workload orphan by exact Workspace key and VersionId', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const objectKey = `tenants/${tenantId}/workspaces/${workspaceId}/unknown/object.bin`;
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'ACTIVE_TENANT_DATA' as const,
              objectKey,
              objectVersionId: 'unknown-v1',
              legalHold: false,
            },
          ],
          hasMore: false,
        }),
      finalizeDeletion: vi.fn(() => Promise.resolve(succeededFinalization(requestId))),
    });
    const objects = objectStorage({
      deleteWorkloadVersion: vi.fn(() => Promise.resolve('DELETED' as const)),
    });

    await expect(createWorker(store, objects).runOnce()).resolves.toMatchObject({
      physicallyDeletedObjectVersions: 1,
      finalizedDeletions: 1,
      failed: 0,
    });
    expect(objects.deleteWorkloadVersion).toHaveBeenCalledWith({
      tenantId,
      workspaceId,
      objectKey,
      objectVersionId: 'unknown-v1',
      isDeleteMarker: false,
    });
    expect(objects.deleteExportVersion).not.toHaveBeenCalled();
  });

  test('deletes active exact S3 versions before finalizing the 30-day ACTIVE stage', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const exportVersion = {
      tenantId,
      objectClass: 'TENANT_EXPORT' as const,
      objectKey: `tenants/${tenantId}/exports/${randomUUID()}.json`,
      objectVersionId: 'export-version-1',
      legalHold: false,
    };
    const retainedAuditVersion = {
      tenantId,
      objectClass: 'AUDIT_DIGEST' as const,
      objectKey: `tenants/${tenantId}/audit/${randomUUID()}.json`,
      objectVersionId: 'audit-version-1',
      legalHold: false,
    };
    const effects: string[] = [];
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [exportVersion, retainedAuditVersion],
          hasMore: false,
        }),
      markDeletionObjectVersionDeleted: () => {
        effects.push('ack');
        return Promise.resolve(true);
      },
      finalizeDeletion: () => {
        effects.push('finalize');
        return Promise.resolve(succeededFinalization(requestId));
      },
    });
    const objects = objectStorage({
      deleteExportVersion: (input: { objectVersionId: string }) => {
        effects.push(`export:${input.objectVersionId}`);
        return Promise.resolve({ outcome: 'NOT_FOUND' as const });
      },
      deleteAuditVersion: () => Promise.reject(new Error('AUDIT_RETENTION_MUST_NOT_BE_BYPASSED')),
    });

    const worker = createWorker(store, objects);

    await expect(worker.runOnce()).resolves.toMatchObject({
      finalizedDeletions: 1,
      physicallyDeletedObjectVersions: 1,
      retainedAuditObjectVersions: 1,
      failed: 0,
    });
    expect(effects).toEqual(['export:export-version-1', 'ack', 'finalize']);
  });

  test('heads, checks legal hold, and deletes an exact version with the deletion claim capability', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const objectKey = `tenants/${tenantId}/exports/exact.bundle.json`;
    const objectVersionId = 'export-version-1';
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'TENANT_EXPORT' as const,
              objectKey,
              objectVersionId,
              legalHold: false,
              scopeKind: 'TENANT' as const,
              workspaceId: null,
              storageClass: 'TENANT_EXPORTS' as const,
              headEligible: true,
            },
          ],
          hasMore: false,
        }),
      finalizeDeletion: vi.fn(() => Promise.resolve(succeededFinalization(requestId))),
    });
    const objects = objectStorage();
    const headAuthorizedDeletionObject = vi.fn(() =>
      Promise.resolve({
        exists: true as const,
        checksum: 'a'.repeat(64),
        contentType: 'application/json',
        byteLength: 128,
      }),
    );
    const getAuthorizedDeletionObjectLegalHold = vi.fn(() => Promise.resolve('OFF' as const));
    const deleteAuthorizedObjectVersion = vi.fn(() => Promise.resolve('DELETED' as const));
    const worker = new PrivacyLifecycleWorker(
      store,
      {
        requestForceDelete: () => Promise.resolve(),
        verifyUnreadable: () => Promise.resolve(true),
      },
      {
        clock: { now: () => new Date(NOW) },
        ids: { next: randomUUID },
        objects,
        lifecycleGateway: {
          headAuthorizedDeletionObject,
          getAuthorizedDeletionObjectLegalHold,
          deleteAuthorizedObjectVersion,
        },
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      finalizedDeletions: 1,
      physicallyDeletedObjectVersions: 1,
      retainedLegalHoldObjectVersions: 0,
      failed: 0,
    });
    const expected = {
      source: { requestId, leaseToken },
      expected: {
        tenantId,
        scopeKind: 'TENANT' as const,
        workspaceId: null,
        objectClass: 'TENANT_EXPORTS' as const,
        objectKey,
        objectVersionId,
      },
    };
    expect(headAuthorizedDeletionObject).toHaveBeenCalledWith(expected);
    expect(getAuthorizedDeletionObjectLegalHold).toHaveBeenCalledWith(expected);
    expect(deleteAuthorizedObjectVersion).toHaveBeenCalledWith({
      ...expected,
      expected: { ...expected.expected, isDeleteMarker: false },
    });
    expect(objects.deleteExportVersion).not.toHaveBeenCalled();
    expect(store.markDeletionObjectVersionDeleted).toHaveBeenCalledWith({
      requestId,
      leaseToken,
      tenantId,
      objectKey,
      objectVersionId,
    });
  });

  test('uses the database-selected Tenant scope for a workload object instead of deriving authority from its key', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const workspaceIdInKey = randomUUID();
    const objectKey = `tenants/${tenantId}/workspaces/${workspaceIdInKey}/artifacts/tenant-delete.json`;
    const objectVersionId = 'tenant-scoped-workload-version';
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'ARTIFACT_PAYLOAD' as const,
              objectKey,
              objectVersionId,
              legalHold: false,
              scopeKind: 'TENANT' as const,
              workspaceId: null,
              storageClass: 'WORKLOAD_OBJECTS' as const,
              headEligible: true,
            },
          ],
          hasMore: false,
        }),
      finalizeDeletion: vi.fn(() => Promise.resolve(succeededFinalization(requestId))),
    });
    const headAuthorizedDeletionObject = vi.fn(() =>
      Promise.resolve({
        exists: true as const,
        checksum: 'a'.repeat(64),
        contentType: 'application/json',
        byteLength: 128,
      }),
    );
    const getAuthorizedDeletionObjectLegalHold = vi.fn(() => Promise.resolve('OFF' as const));
    const deleteAuthorizedObjectVersion = vi.fn(() => Promise.resolve('DELETED' as const));
    const worker = new PrivacyLifecycleWorker(
      store,
      {
        requestForceDelete: () => Promise.resolve(),
        verifyUnreadable: () => Promise.resolve(true),
      },
      {
        clock: { now: () => new Date(NOW) },
        ids: { next: randomUUID },
        lifecycleGateway: {
          headAuthorizedDeletionObject,
          getAuthorizedDeletionObjectLegalHold,
          deleteAuthorizedObjectVersion,
        },
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      finalizedDeletions: 1,
      physicallyDeletedObjectVersions: 1,
      failed: 0,
    });
    const expected = {
      source: { requestId, leaseToken },
      expected: {
        tenantId,
        scopeKind: 'TENANT' as const,
        workspaceId: null,
        objectClass: 'WORKLOAD_OBJECTS' as const,
        objectKey,
        objectVersionId,
      },
    };
    expect(headAuthorizedDeletionObject).toHaveBeenCalledWith(expected);
    expect(getAuthorizedDeletionObjectLegalHold).toHaveBeenCalledWith(expected);
    expect(deleteAuthorizedObjectVersion).toHaveBeenCalledWith({
      ...expected,
      expected: { ...expected.expected, isDeleteMarker: false },
    });
  });

  test('deletes a metadata-less inventory orphan directly so an already-missing version can converge', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const workspaceIdInKey = randomUUID();
    const objectKey = `tenants/${tenantId}/workspaces/${workspaceIdInKey}/unknown/inventory-orphan.bin`;
    const objectVersionId = 'inventory-orphan-version';
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'ACTIVE_TENANT_DATA' as const,
              objectKey,
              objectVersionId,
              legalHold: false,
              scopeKind: 'TENANT' as const,
              workspaceId: null,
              storageClass: 'WORKLOAD_OBJECTS' as const,
              headEligible: false,
            },
          ],
          hasMore: false,
        }),
      finalizeDeletion: vi.fn(() => Promise.resolve(succeededFinalization(requestId))),
    });
    const headAuthorizedDeletionObject = vi.fn(() =>
      Promise.reject(new Error('INVENTORY_ORPHAN_HEAD_MUST_NOT_RUN')),
    );
    const getAuthorizedDeletionObjectLegalHold = vi.fn(() =>
      Promise.reject(new Error('INVENTORY_ORPHAN_LEGAL_HOLD_MUST_NOT_RUN')),
    );
    const deleteAuthorizedObjectVersion = vi.fn(() => Promise.resolve('DELETED' as const));
    const worker = new PrivacyLifecycleWorker(
      store,
      {
        requestForceDelete: () => Promise.resolve(),
        verifyUnreadable: () => Promise.resolve(true),
      },
      {
        clock: { now: () => new Date(NOW) },
        ids: { next: randomUUID },
        lifecycleGateway: {
          headAuthorizedDeletionObject,
          getAuthorizedDeletionObjectLegalHold,
          deleteAuthorizedObjectVersion,
        },
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      finalizedDeletions: 1,
      physicallyDeletedObjectVersions: 1,
      retainedLegalHoldObjectVersions: 0,
      failed: 0,
    });
    const expected = {
      source: { requestId, leaseToken },
      expected: {
        tenantId,
        scopeKind: 'TENANT' as const,
        workspaceId: null,
        objectClass: 'WORKLOAD_OBJECTS' as const,
        objectKey,
        objectVersionId,
      },
    };
    expect(headAuthorizedDeletionObject).not.toHaveBeenCalled();
    expect(getAuthorizedDeletionObjectLegalHold).not.toHaveBeenCalled();
    expect(deleteAuthorizedObjectVersion).toHaveBeenCalledWith({
      ...expected,
      expected: { ...expected.expected, isDeleteMarker: false },
    });
  });

  test('does not acknowledge or fall back after a capability deletion outcome becomes unknown', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const objectKey = `tenants/${tenantId}/exports/ambiguous.bundle.json`;
    const objectVersionId = 'ambiguous-version';
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'TENANT_EXPORT' as const,
              objectKey,
              objectVersionId,
              legalHold: false,
              scopeKind: 'TENANT' as const,
              workspaceId: null,
              storageClass: 'TENANT_EXPORTS' as const,
              headEligible: true,
            },
          ],
          hasMore: false,
        }),
    });
    const objects = objectStorage();
    const deleteAuthorizedObjectVersion = vi.fn(() =>
      Promise.reject(new Error('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN')),
    );
    const worker = new PrivacyLifecycleWorker(
      store,
      {
        requestForceDelete: () => Promise.resolve(),
        verifyUnreadable: () => Promise.resolve(true),
      },
      {
        clock: { now: () => new Date(NOW) },
        ids: { next: randomUUID },
        objects,
        lifecycleGateway: {
          headAuthorizedDeletionObject: () =>
            Promise.resolve({
              exists: true,
              checksum: 'a'.repeat(64),
              contentType: 'application/json',
              byteLength: 128,
            }),
          getAuthorizedDeletionObjectLegalHold: () => Promise.resolve('OFF'),
          deleteAuthorizedObjectVersion,
        },
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      physicallyDeletedObjectVersions: 0,
      finalizedDeletions: 0,
      failed: 1,
    });
    expect(deleteAuthorizedObjectVersion).toHaveBeenCalledOnce();
    expect(objects.deleteExportVersion).not.toHaveBeenCalled();
    expect(store.markDeletionObjectVersionDeleted).not.toHaveBeenCalled();
    expect(store.finalizeDeletion).not.toHaveBeenCalled();
  });

  test('deletes an exact DeleteMarker capability without an impossible HEAD or legal-hold probe', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const objectKey = `tenants/${tenantId}/exports/deleted-export.bundle.json`;
    const objectVersionId = 'delete-marker-version';
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'TENANT_EXPORT' as const,
              objectKey,
              objectVersionId,
              legalHold: false,
              isDeleteMarker: true,
              scopeKind: 'TENANT' as const,
              workspaceId: null,
              storageClass: 'TENANT_EXPORTS' as const,
              headEligible: false,
            },
          ],
          hasMore: false,
        }),
      finalizeDeletion: vi.fn(() => Promise.resolve(succeededFinalization(requestId))),
    });
    const objects = objectStorage();
    const headAuthorizedDeletionObject = vi.fn(() =>
      Promise.reject(new Error('DELETE_MARKER_HEAD_MUST_NOT_RUN')),
    );
    const getAuthorizedDeletionObjectLegalHold = vi.fn(() =>
      Promise.reject(new Error('DELETE_MARKER_LEGAL_HOLD_MUST_NOT_RUN')),
    );
    const deleteAuthorizedObjectVersion = vi.fn(() => Promise.resolve('DELETED' as const));
    const worker = new PrivacyLifecycleWorker(
      store,
      {
        requestForceDelete: () => Promise.resolve(),
        verifyUnreadable: () => Promise.resolve(true),
      },
      {
        clock: { now: () => new Date(NOW) },
        ids: { next: randomUUID },
        objects,
        lifecycleGateway: {
          headAuthorizedDeletionObject,
          getAuthorizedDeletionObjectLegalHold,
          deleteAuthorizedObjectVersion,
        },
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      physicallyDeletedObjectVersions: 1,
      finalizedDeletions: 1,
      failed: 0,
    });
    expect(headAuthorizedDeletionObject).not.toHaveBeenCalled();
    expect(getAuthorizedDeletionObjectLegalHold).not.toHaveBeenCalled();
    expect(deleteAuthorizedObjectVersion).toHaveBeenCalledWith({
      source: { requestId, leaseToken },
      expected: {
        tenantId,
        scopeKind: 'TENANT',
        workspaceId: null,
        objectClass: 'TENANT_EXPORTS',
        objectKey,
        objectVersionId,
        isDeleteMarker: true,
      },
    });
    expect(objects.deleteExportVersion).not.toHaveBeenCalled();
  });

  test('routes workload and Tenant-export DeleteMarkers to exact-version marker deletion', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const workloadKey = `tenants/${tenantId}/workspaces/${workspaceId}/unknown/deleted-object.bin`;
    const exportKey = `tenants/${tenantId}/exports/deleted-export.bundle.json`;
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'ACTIVE_TENANT_DATA' as const,
              objectKey: workloadKey,
              objectVersionId: 'workload-marker-v1',
              legalHold: false,
              isDeleteMarker: true,
            },
            {
              tenantId,
              objectClass: 'TENANT_EXPORT' as const,
              objectKey: exportKey,
              objectVersionId: 'export-marker-v1',
              legalHold: false,
              isDeleteMarker: true,
            },
          ],
          hasMore: false,
        }),
    });
    const deleteWorkloadVersion = vi.fn(() => Promise.resolve('DELETED' as const));
    const deleteExportVersion = vi.fn(() => Promise.resolve({ outcome: 'DELETED' as const }));

    await expect(
      createWorker(store, objectStorage({ deleteWorkloadVersion, deleteExportVersion })).runOnce(),
    ).resolves.toMatchObject({
      physicallyDeletedObjectVersions: 2,
      finalizedDeletions: 1,
      failed: 0,
    });
    expect(deleteWorkloadVersion).toHaveBeenCalledWith({
      tenantId,
      workspaceId,
      objectKey: workloadKey,
      objectVersionId: 'workload-marker-v1',
      isDeleteMarker: true,
    });
    expect(deleteExportVersion).toHaveBeenCalledWith({
      tenantId,
      objectKey: exportKey,
      objectVersionId: 'export-marker-v1',
      at: NOW,
      isDeleteMarker: true,
    });
  });

  test.each(['LEGAL_HOLD', 'OBJECT_LOCKED'] as const)(
    'does not finalize when exact-version deletion returns %s',
    async (outcome) => {
      const requestId = randomUUID();
      const leaseToken = randomUUID();
      const tenantId = randomUUID();
      const store = lifecycleStore({
        claimDueDeletionRequests: () =>
          Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
        listDueDeletionObjectVersions: () =>
          Promise.resolve({
            outcome: 'SUCCEEDED' as const,
            objects: [
              {
                tenantId,
                objectClass: 'TENANT_EXPORT' as const,
                objectKey: `tenants/${tenantId}/exports/archive.json`,
                objectVersionId: 'locked-version',
                legalHold: false,
              },
            ],
            hasMore: false,
          }),
      });
      const objects = objectStorage({
        deleteExportVersion: () => Promise.resolve({ outcome }),
      });

      const result = await createWorker(store, objects).runOnce();

      expect(result).toMatchObject({ finalizedDeletions: 0, failed: 1 });
      expect(store.finalizeDeletion).not.toHaveBeenCalled();
    },
  );

  test('treats an already absent exact version as physically deleted and remains retry safe', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'CHANNEL_PACKAGE' as const,
              objectKey: `tenants/${tenantId}/packages/package.zip`,
              objectVersionId: 'already-absent-version',
              legalHold: false,
            },
          ],
          hasMore: false,
        }),
    });
    const objects = objectStorage({
      deleteExportVersion: () => Promise.resolve({ outcome: 'NOT_FOUND' as const }),
    });

    await expect(createWorker(store, objects).runOnce()).resolves.toMatchObject({
      physicallyDeletedObjectVersions: 1,
      finalizedDeletions: 1,
      failed: 0,
    });
  });

  test('preserves a database-held exact version without asking S3 to delete it', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'TENANT_EXPORT' as const,
              objectKey: `tenants/${tenantId}/exports/held.json`,
              objectVersionId: 'held-version',
              legalHold: true,
            },
          ],
          hasMore: false,
        }),
    });
    const objects = objectStorage();

    await expect(createWorker(store, objects).runOnce()).resolves.toMatchObject({
      finalizedDeletions: 1,
      physicallyDeletedObjectVersions: 0,
      retainedLegalHoldObjectVersions: 1,
      failed: 0,
    });
    expect(objects.deleteExportVersion).not.toHaveBeenCalled();
  });

  test('persists exact-version deletion progress and refuses finalization when the ack loses its lease', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'TENANT_EXPORT' as const,
              objectKey: `tenants/${tenantId}/exports/progress.json`,
              objectVersionId: 'progress-version',
              legalHold: false,
            },
          ],
          hasMore: false,
        }),
      markDeletionObjectVersionDeleted: () => Promise.resolve(false),
    });

    await expect(createWorker(store, objectStorage()).runOnce()).resolves.toMatchObject({
      finalizedDeletions: 0,
      physicallyDeletedObjectVersions: 0,
      leaseLost: 1,
    });
    expect(store.finalizeDeletion).not.toHaveBeenCalled();
  });

  test('persists one bounded page and releases the request lease before claiming the next page', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'ACTIVE')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'TENANT_EXPORT' as const,
              objectKey: `tenants/${tenantId}/exports/page-1.json`,
              objectVersionId: 'page-1-version',
              legalHold: false,
            },
          ],
          hasMore: true,
        }),
    });

    await expect(createWorker(store, objectStorage()).runOnce()).resolves.toMatchObject({
      finalizedDeletions: 0,
      physicallyDeletedObjectVersions: 1,
      leaseLost: 0,
      failed: 0,
    });
    expect(store.releaseDeletionLease).toHaveBeenCalledWith({ requestId, leaseToken });
    expect(store.finalizeDeletion).not.toHaveBeenCalled();
  });

  test('deletes a just-released held object immediately without advancing the 90-day backup plane', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const tenantId = randomUUID();
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'OBJECT')]),
      listDueDeletionObjectVersions: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          objects: [
            {
              tenantId,
              objectClass: 'TENANT_EXPORT' as const,
              objectKey: `tenants/${tenantId}/exports/released-hold.json`,
              objectVersionId: 'released-hold-version',
              legalHold: false,
            },
          ],
          hasMore: false,
        }),
    });

    await expect(createWorker(store, objectStorage()).runOnce()).resolves.toMatchObject({
      physicallyDeletedObjectVersions: 1,
      finalizedDeletions: 0,
      failed: 0,
    });
    expect(store.releaseDeletionLease).toHaveBeenCalledWith({ requestId, leaseToken });
    expect(store.finalizeDeletion).not.toHaveBeenCalled();
  });

  test('fails closed before the 90-day BACKUP tombstone when recovery points are not proven expired', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const sourceDeletedAt = '2026-05-23T10:00:00.000Z';
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'BACKUP')]),
      getBackupDeletionVerificationTarget: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          target: { requestId, sourceDeletedAt },
        }),
    });
    const backupVerifier = {
      verifyExpired: vi.fn(() => Promise.resolve({ outcome: 'RECOVERY_POINTS_RETAINED' as const })),
    };

    await expect(
      createWorker(store, objectStorage(), backupVerifier).runOnce(),
    ).resolves.toMatchObject({
      finalizedDeletions: 0,
      failed: 1,
    });
    expect(backupVerifier.verifyExpired).toHaveBeenCalledWith({ requestId, sourceDeletedAt });
    expect(store.finalizeDeletion).not.toHaveBeenCalled();
  });

  test('binds the timestamped cloud proof to the exact lease before BACKUP finalization', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const sourceDeletedAt = '2026-05-23T10:00:00.000Z';
    const verifiedAt = NOW.toISOString();
    const evidence = backupEvidence(requestId, sourceDeletedAt, verifiedAt);
    const effects: string[] = [];
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'BACKUP')]),
      getBackupDeletionVerificationTarget: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          target: { requestId, sourceDeletedAt },
        }),
      recordBackupDeletionVerification: vi.fn(() => {
        effects.push('proof');
        return Promise.resolve(true);
      }),
      finalizeDeletion: () => {
        effects.push('finalize');
        return Promise.resolve(succeededFinalization(requestId));
      },
    });
    const backupVerifier = {
      verifyExpired: vi.fn(() =>
        Promise.resolve({
          outcome: 'VERIFIED' as const,
          ...evidence,
          sourceDeletedAt,
          verifiedAt,
        }),
      ),
    };

    await expect(
      createWorker(store, objectStorage(), backupVerifier).runOnce(),
    ).resolves.toMatchObject({
      finalizedDeletions: 1,
      failed: 0,
    });
    expect(backupVerifier.verifyExpired).toHaveBeenCalledWith({ requestId, sourceDeletedAt });
    expect(store.recordBackupDeletionVerification).toHaveBeenCalledWith({
      requestId,
      leaseToken,
      ...evidence,
      sourceDeletedAt: new Date(sourceDeletedAt),
      verifiedAt: new Date(verifiedAt),
    });
    expect(effects).toEqual(['proof', 'finalize']);
  });

  test('rejects a tampered canonical backup observation before it reaches PostgreSQL', async () => {
    const requestId = randomUUID();
    const leaseToken = randomUUID();
    const sourceDeletedAt = '2026-05-23T10:00:00.000Z';
    const verifiedAt = NOW.toISOString();
    const evidence = backupEvidence(requestId, sourceDeletedAt, verifiedAt);
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([deletionClaim(requestId, leaseToken, 'BACKUP')]),
      getBackupDeletionVerificationTarget: () =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          target: { requestId, sourceDeletedAt },
        }),
    });

    await expect(
      createWorker(store, objectStorage(), {
        verifyExpired: () =>
          Promise.resolve({
            outcome: 'VERIFIED' as const,
            ...evidence,
            evidenceCanonicalJson: `${evidence.evidenceCanonicalJson} `,
            sourceDeletedAt,
            verifiedAt,
          }),
      }).runOnce(),
    ).resolves.toMatchObject({ finalizedDeletions: 0, failed: 1 });
    expect(store.recordBackupDeletionVerification).not.toHaveBeenCalled();
    expect(store.finalizeDeletion).not.toHaveBeenCalled();
  });
});

function createWorker(
  store: ReturnType<typeof lifecycleStore>,
  objects: ReturnType<typeof objectStorage>,
  backupVerifier = {
    verifyExpired: (input: { requestId: string; sourceDeletedAt: string }) => {
      const verifiedAt = NOW.toISOString();
      return Promise.resolve({
        outcome: 'VERIFIED' as const,
        ...backupEvidence(input.requestId, input.sourceDeletedAt, verifiedAt),
        sourceDeletedAt: input.sourceDeletedAt,
        verifiedAt,
      });
    },
  },
) {
  return new PrivacyLifecycleWorker(
    store,
    {
      requestForceDelete: () => Promise.resolve(),
      verifyUnreadable: () => Promise.resolve(true),
    },
    {
      clock: { now: () => new Date(NOW) },
      ids: { next: randomUUID },
      objects,
      backupVerifier,
    },
  );
}

function deletionClaim(
  requestId: string,
  leaseToken: string,
  stage: 'ACTIVE' | 'OBJECT' | 'BACKUP' | 'TOMBSTONE',
) {
  return {
    requestId,
    stage,
    leaseToken,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
}

function succeededFinalization(requestId: string) {
  return {
    outcome: 'SUCCEEDED' as const,
    finalization: {
      requestId,
      state: 'BACKUP_DELETED' as const,
      effectiveAt: NOW.toISOString(),
      tombstoneId: randomUUID(),
    },
  };
}

function backupEvidence(requestId: string, sourceDeletedAt: string, verifiedAt: string) {
  const evidenceCanonicalJson = JSON.stringify({
    inventoryMethod: 'ListRecoveryPointsByResource',
    managedByAWSBackupOnly: false,
    requestId: requestId.toLowerCase(),
    schemaVersion: '2.0.0',
    sourceDeletedAt,
    verifiedAt,
  });
  return {
    evidenceCanonicalJson,
    evidenceHash: createHash('sha256').update(evidenceCanonicalJson).digest('hex'),
  };
}

function lifecycleStore(overrides: Record<string, unknown> = {}) {
  return {
    claimPendingPrivacyObjectWriteIntents: vi.fn(() => Promise.resolve([])),
    completePrivacyObjectWriteIntent: vi.fn(() => Promise.resolve(true)),
    releasePrivacyObjectWriteIntentLease: vi.fn(() => Promise.resolve(true)),
    claimDueDeletionRequests: vi.fn(() => Promise.resolve([])),
    claimDueSecretDeletions: vi.fn(() => Promise.resolve([])),
    markSecretDeletionRequested: vi.fn(() => Promise.resolve(true)),
    markSecretUnreadable: vi.fn(() => Promise.resolve(true)),
    listDueDeletionObjectVersions: vi.fn(() =>
      Promise.resolve({ outcome: 'SUCCEEDED' as const, objects: [], hasMore: false }),
    ),
    markDeletionObjectVersionDeleted: vi.fn(() => Promise.resolve(true)),
    releaseDeletionLease: vi.fn(() => Promise.resolve(true)),
    getBackupDeletionVerificationTarget: vi.fn(() =>
      Promise.resolve({
        outcome: 'SUCCEEDED' as const,
        target: {
          requestId: randomUUID(),
          sourceDeletedAt: '2026-05-23T10:00:00.000Z',
        },
      }),
    ),
    recordBackupDeletionVerification: vi.fn(() => Promise.resolve(true)),
    getDeletionObjectInventoryTarget: vi.fn(() =>
      Promise.resolve({ outcome: 'NOT_REQUIRED' as const }),
    ),
    recordDeletionObjectInventory: vi.fn(() => Promise.resolve(true)),
    claimPendingLegalHoldReconciliations: vi.fn(() => Promise.resolve([])),
    completeLegalHoldReconciliation: vi.fn(() => Promise.resolve(true)),
    releaseLegalHoldReconciliationLease: vi.fn(() => Promise.resolve(true)),
    finalizeDeletion: vi.fn(() => Promise.resolve(succeededFinalization(randomUUID()))),
    ...overrides,
  };
}

function objectStorage(overrides: Record<string, unknown> = {}) {
  return {
    putExportVersion: vi.fn(() => Promise.reject(new Error('UNEXPECTED_PRIVACY_WRITE'))),
    putLockedAuditVersion: vi.fn(() => Promise.reject(new Error('UNEXPECTED_PRIVACY_WRITE'))),
    deleteExportVersion: vi.fn(() => Promise.resolve({ outcome: 'NOT_FOUND' as const })),
    deleteAuditVersion: vi.fn(() => Promise.resolve({ outcome: 'NOT_FOUND' as const })),
    holdExportVersion: vi.fn(() => Promise.resolve(true)),
    releaseExportVersionHold: vi.fn(() => Promise.resolve(true)),
    holdAuditVersion: vi.fn(() => Promise.resolve(true)),
    releaseAuditVersionHold: vi.fn(() => Promise.resolve(true)),
    listPrivacyObjectVersions: vi.fn(() => Promise.resolve({ versions: [], nextCursor: null })),
    ...overrides,
  };
}
