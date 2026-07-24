import { randomUUID } from 'node:crypto';

import { InMemorySecretLifecycleStore } from '@aeostudio/adapters/secrets';
import { FakePrivacyObjectStorage } from '@aeostudio/adapters/storage';
import { describe, expect, test } from 'vitest';

import { InMemoryAuthStore } from '../../apps/api/src/auth/auth-store.memory.js';
import { InMemoryArtifactStore } from '../../apps/api/src/artifacts/in-memory-artifact-store.js';
import { InMemoryChannelAuthorizationStore } from '../../apps/api/src/channels/in-memory-channel-authorization-store.js';
import { InMemoryPublicationStore } from '../../apps/api/src/channels/in-memory-publication-store.js';
import { InMemoryEvidenceClaimStore } from '../../apps/api/src/claims/in-memory-evidence-claim-store.js';
import { InMemoryJobBudgetStore } from '../../apps/api/src/jobs/in-memory-job-budget-store.js';
import { InMemoryProfileOfferingStore } from '../../apps/api/src/profile-offering/in-memory-profile-offering-store.js';
import { InMemoryAuditSink } from '../../apps/api/src/privacy/in-memory-audit-sink.js';
import { InMemoryPrivacyAuditStore } from '../../apps/api/src/privacy/in-memory-privacy-audit-store.js';
import { InMemorySiteCrawlStore } from '../../apps/api/src/sites/in-memory-site-crawl-store.js';
import { InMemoryTenancyStore } from '../../apps/api/src/tenants/in-memory-tenancy-store.js';

describe('Task 17 shared fake-runtime audit sink', () => {
  test('does not replay a historical pending login into a Tenant joined later', () => {
    const clock = { now: () => new Date('2026-07-22T06:00:00.000Z') };
    const audit = new InMemoryAuditSink(clock);
    const actorSubject = 'task-17-multi-tenant-owner';
    const firstTenantId = randomUUID();
    const secondTenantId = randomUUID();

    audit.appendForSubject({
      actorSubject,
      actorKind: 'USER',
      action: 'AUTH_SESSION_STARTED',
      resourceType: 'AUTH_SESSION',
      resourceId: null,
      outcome: 'SUCCEEDED',
    });
    audit.bindSubject({ actorSubject, tenantId: firstTenantId, actorUserId: randomUUID() });
    audit.bindSubject({ actorSubject, tenantId: secondTenantId, actorUserId: randomUUID() });

    expect(audit.listTenant(firstTenantId).map((event) => event.action)).toEqual([
      'AUTH_SESSION_STARTED',
    ]);
    expect(audit.listTenant(secondTenantId)).toEqual([]);

    audit.appendForSubject({
      actorSubject,
      actorKind: 'USER',
      action: 'AUTH_SESSION_STARTED',
      resourceType: 'AUTH_SESSION',
      resourceId: null,
      outcome: 'SUCCEEDED',
    });
    expect(audit.listTenant(firstTenantId)).toHaveLength(2);
    expect(audit.listTenant(secondTenantId)).toHaveLength(1);
  });

  test('rejects credential-shaped metadata keys and values before appending', () => {
    const audit = new InMemoryAuditSink();
    const base = {
      id: randomUUID(),
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      action: 'SAFE_ACTION',
      resourceType: 'SAFE_RESOURCE',
      resourceId: randomUUID(),
      outcome: 'SUCCEEDED',
    };

    expect(() => audit.append({ ...base, metadata: { accessToken: 'redacted' } })).toThrow(
      'SENSITIVE_AUDIT_METADATA_REJECTED',
    );
    expect(() =>
      audit.append({
        ...base,
        id: randomUUID(),
        metadata: { note: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      }),
    ).toThrow('SENSITIVE_AUDIT_METADATA_REJECTED');
    expect(audit.listTenant(base.tenantId)).toEqual([]);
  });

  test('login and budget mutations enter one tenant hash chain without session secrets', async () => {
    const now = new Date('2026-07-22T06:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const audit = new InMemoryAuditSink(clock);
    const auth = new InMemoryAuthStore(audit);
    const tenancy = new InMemoryTenancyStore(audit);
    const jobs = new InMemoryJobBudgetStore(undefined, audit, clock);
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    const tokenDigest = 'session-digest-must-never-enter-audit';

    await auth.saveSession({
      tokenDigest,
      subject: 'task-17-shared-audit-owner',
      email: 'owner-sensitive@example.test',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
      revokedAt: null,
    });
    await tenancy.bootstrapTenant({
      actorSubject: 'task-17-shared-audit-owner',
      actorEmail: 'owner-sensitive@example.test',
      tenantId,
      tenantName: 'Shared Audit Tenant',
      workspaceId,
      workspaceName: 'Shared Audit Workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    await auth.revokeSession(tokenDigest, now);
    await auth.revokeSession(tokenDigest, now);
    const batchRevokedTokenDigest = 'batch-revoked-session-digest-must-never-enter-audit';
    await auth.saveSession({
      tokenDigest: batchRevokedTokenDigest,
      subject: 'task-17-shared-audit-owner',
      email: 'owner-sensitive@example.test',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
      revokedAt: null,
    });
    const context = {
      tenantId,
      workspaceId,
      actorUserId,
      membershipId,
      role: 'OWNER' as const,
    };
    await jobs.setBudget({
      context,
      policyId: randomUUID(),
      limitUnits: 100,
      auditEventId: randomUUID(),
    });
    const invited = await tenancy.inviteMembership({
      context,
      invitedEmail: 'reviewer@example.test',
      role: 'REVIEWER',
      invitedUserId: randomUUID(),
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    await tenancy.changeMembershipRole({
      context,
      membershipId: invited.id,
      role: 'PUBLISHER',
      auditEventId: randomUUID(),
    });

    const privacy = new InMemoryPrivacyAuditStore({
      auth,
      tenancy,
      jobs,
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects: new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock }),
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
      audit,
    });
    await expect(
      privacy.requestTenantDeletion({
        actorSubject: 'task-17-shared-audit-owner',
        context,
        requestId: randomUUID(),
        reason: 'Bearer deletion-reason-must-not-enter-audit',
        requestHash: 'f'.repeat(64),
        requestedAt: now,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    const result = await privacy.listAuditEvents({
      context,
      from: new Date('2026-07-22T05:00:00.000Z'),
      to: new Date('2026-07-22T07:00:00.000Z'),
      cursor: null,
      limit: 100,
    });

    expect(result.outcome).toBe('SUCCEEDED');
    if (result.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_AUDIT_TIMELINE');
    expect(result.timeline.events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'AUTH_SESSION_STARTED',
        'TENANT_CREATED',
        'BUDGET_POLICY_SET',
        'AUTH_SESSION_REVOKED',
        'MEMBERSHIP_ROLE_CHANGED',
        'TENANT_DELETION_REQUESTED',
      ]),
    );
    expect(result.timeline.events.map((event) => event.sequence)).toEqual(
      result.timeline.events.map((_, index, events) => events.length - index),
    );
    expect(JSON.stringify(result.timeline)).not.toContain(tokenDigest);
    expect(JSON.stringify(result.timeline)).not.toContain(batchRevokedTokenDigest);
    expect(JSON.stringify(result.timeline)).not.toContain('owner-sensitive@example.test');
    expect(JSON.stringify(result.timeline)).not.toContain('deletion-reason-must-not-enter-audit');
    expect(
      result.timeline.events.filter((event) => event.action === 'AUTH_SESSION_REVOKED'),
    ).toHaveLength(2);
    await expect(privacy.verifyAuditChain({ context })).resolves.toMatchObject({
      valid: true,
      eventCount: result.timeline.events.length,
      lastSequence: result.timeline.events.length,
    });
  });

  test('Artifact approval enters the shared chain without copying review or Claim text', async () => {
    const now = new Date('2026-07-22T06:00:00.000Z');
    const audit = new InMemoryAuditSink({ now: () => new Date(now) });
    const artifacts = new InMemoryArtifactStore(audit);
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const creator = {
      tenantId,
      workspaceId,
      actorUserId: randomUUID(),
      membershipId: randomUUID(),
      role: 'OWNER' as const,
    };
    const reviewer = {
      ...creator,
      actorUserId: randomUUID(),
      membershipId: randomUUID(),
    };
    const artifactId = randomUUID();
    await artifacts.prepareArtifact({
      context: creator,
      artifactId,
      briefId: randomUUID(),
      locale: 'zh-CN',
      market: 'CN',
      methodPolicyVersion: 'task-17-v1',
      createdAt: now,
      auditEventId: randomUUID(),
    });
    const writer = await artifacts.loadWriterContext({
      context: creator,
      artifactId,
      effectiveAt: now,
    });
    if (writer === null) throw new Error('EXPECTED_ARTIFACT_WRITER');
    const claimBindings = writer.claims.map((claim) => ({
      claimId: claim.claimId,
      claimRevisionId: claim.revisionId,
      claimContentHash: claim.contentHash,
      claimStatement: claim.statement,
      evidence: claim.evidence,
    }));
    const contentHash = 'a'.repeat(64);
    await artifacts.completeGeneration({
      context: creator,
      artifactId,
      revisionId: randomUUID(),
      contentHash,
      payloadObjectRef: 'memory://artifact-payload/task-17',
      sourceArtifactIds: writer.brief.sourceArtifactIds,
      lineage: writer.brief.lineage,
      claimBindings,
      claimLinkIds: claimBindings.flatMap((claim) => claim.evidence.map(() => randomUUID())),
      schemaVersion: '1.0.0',
      createdByActor: { kind: 'AGENT', id: 'task-17-artifact-agent' },
      createdAt: now,
      auditEventId: randomUUID(),
    });
    await artifacts.submitRevision({
      context: creator,
      artifactId,
      revision: 1,
      expectedContentHash: contentHash,
      submittedAt: now,
      auditEventId: randomUUID(),
    });
    await expect(
      artifacts.reviewRevision({
        context: reviewer,
        artifactId,
        revision: 1,
        expectedContentHash: contentHash,
        decision: 'APPROVE',
        note: 'Bearer review-text-must-not-enter-audit',
        reviewId: randomUUID(),
        reviewedAt: now,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });

    const serialized = JSON.stringify(audit.listTenant(tenantId));
    expect(audit.listTenant(tenantId).map((event) => event.action)).toContain(
      'ARTIFACT_REVISION_APPROVED',
    );
    expect(serialized).not.toContain('review-text-must-not-enter-audit');
    expect(serialized).not.toContain(writer.claims[0]?.statement);
  });

  test('Claim approval enters the shared chain without copying statement, snippet, or note', async () => {
    const now = new Date('2026-07-22T06:00:00.000Z');
    const audit = new InMemoryAuditSink({ now: () => new Date(now) });
    const claims = new InMemoryEvidenceClaimStore(audit);
    const context = {
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      actorUserId: randomUUID(),
      membershipId: randomUUID(),
      role: 'OWNER' as const,
    };
    const sourceId = randomUUID();
    const snapshotId = randomUUID();
    const claimId = randomUUID();
    const revisionId = randomUUID();
    const contentHash = 'b'.repeat(64);
    const sourceHash = 'c'.repeat(64);
    await claims.createSource({
      context,
      sourceId,
      sourceType: 'PUBLIC',
      title: 'Sensitive source title',
      uri: 'https://sensitive.example.test/private',
      license: 'Permission received',
      publicity: 'PUBLIC',
      createdAt: now,
      auditEventId: randomUUID(),
    });
    await claims.createSnapshot({
      context,
      snapshotId,
      sourceId,
      contentHash: sourceHash,
      objectRef: 'memory://sensitive-evidence-body',
      contentType: 'text/plain',
      sizeBytes: 42,
      capturedAt: now,
      auditEventId: randomUUID(),
    });
    await claims.createClaim({
      context,
      claimId,
      revisionId,
      evidenceLinkIds: [randomUUID()],
      statement: 'Sensitive Claim statement',
      numericValue: null,
      unit: null,
      scope: 'Public product facts',
      conditions: [],
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
      evidence: [{ snapshotId, sourceHash, snippet: 'Sensitive source excerpt' }],
      contentHash,
      createdAt: now,
      auditEventId: randomUUID(),
    });
    await claims.submitClaim({
      context,
      claimId,
      revisionId,
      submittedAt: now,
      auditEventId: randomUUID(),
    });
    await expect(
      claims.reviewClaim({
        context: { ...context, actorUserId: randomUUID() },
        claimId,
        revisionId,
        expectedContentHash: contentHash,
        reviewId: randomUUID(),
        decision: 'APPROVE',
        note: 'Bearer sensitive-review-note',
        reviewedAt: now,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });

    const serialized = JSON.stringify(audit.listTenant(context.tenantId));
    expect(audit.listTenant(context.tenantId).map((event) => event.action)).toContain(
      'CLAIM_REVISION_APPROVED',
    );
    expect(serialized).not.toContain('Sensitive Claim statement');
    expect(serialized).not.toContain('Sensitive source excerpt');
    expect(serialized).not.toContain('sensitive-review-note');
    expect(serialized).not.toContain('sensitive.example.test');
  });

  test('credential, crawl setup, and content revisions use the same metadata-only chain', async () => {
    const now = new Date('2026-07-22T06:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const audit = new InMemoryAuditSink(clock);
    const context = {
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      actorUserId: randomUUID(),
      membershipId: randomUUID(),
      role: 'OWNER' as const,
    };
    const authorizations = new InMemoryChannelAuthorizationStore(undefined, audit);
    const secretArn = `arn:aws:secretsmanager:test:000000000000:secret:${randomUUID()}`;
    await authorizations.create({
      context,
      authorizationId: randomUUID(),
      adapterVersionId: randomUUID(),
      target: 'https://publish.example.test/?access_token=must-not-leak',
      grantedScopes: ['content:write'],
      acceptedTermsVersion: 'v1',
      secretArn,
      expiresAt: null,
      createdAt: now,
      auditEventId: randomUUID(),
    });

    const sites = new InMemorySiteCrawlStore(audit);
    await sites.createSite({
      context,
      siteId: randomUUID(),
      profileId: randomUUID(),
      origin: 'https://private-origin.example.test',
      hostname: 'private-origin.example.test',
      auditEventId: randomUUID(),
    });

    const profiles = new InMemoryProfileOfferingStore(clock, audit);
    const profileId = randomUUID();
    const content = {
      displayName: 'Sensitive tenant-defined brand',
      description: 'Sensitive profile body',
      digitalAssets: [{ label: 'Private site', url: 'https://private-profile.example.test' }],
      targetMarkets: [{ locale: 'zh-CN', market: 'TW' }],
    };
    const completeness = {
      completedFields: 4,
      totalFields: 4,
      percent: 100,
      missingFields: [] as string[],
    };
    await profiles.createProfile({
      context,
      profileId,
      revisionId: randomUUID(),
      contentHash: 'd'.repeat(64),
      content,
      completeness,
      auditEventId: randomUUID(),
    });
    await profiles.createProfileRevision({
      context,
      profileId,
      revisionId: randomUUID(),
      contentHash: 'e'.repeat(64),
      content: { ...content, description: 'Even more sensitive revision body' },
      completeness,
      auditEventId: randomUUID(),
    });

    const events = audit.listTenant(context.tenantId);
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'CHANNEL_AUTHORIZATION_CREATED',
        'SITE_CREATED',
        'PROFILE_REVISION_CREATED',
      ]),
    );
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    const serialized = JSON.stringify(events);
    for (const sensitive of [
      secretArn,
      'must-not-leak',
      'private-origin.example.test',
      'Sensitive profile body',
      'Even more sensitive revision body',
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(audit.verifyTenant(context.tenantId).valid).toBe(true);
  });

  test('a publication request and its budget reservation append to the shared chain', async () => {
    const now = new Date('2026-07-22T06:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const audit = new InMemoryAuditSink(clock);
    const context = {
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      actorUserId: randomUUID(),
      membershipId: randomUUID(),
      role: 'PUBLISHER' as const,
    };
    const jobs = new InMemoryJobBudgetStore(undefined, audit, clock);
    await jobs.setBudget({
      context,
      policyId: randomUUID(),
      limitUnits: 100,
      auditEventId: randomUUID(),
    });
    const packageId = randomUUID();
    const artifactId = randomUUID();
    const artifactRevisionId = randomUUID();
    const authorizationId = randomUUID();
    const publicationId = randomUUID();
    const channelPackage = {
      id: packageId,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      packageRevision: 1,
      packageChecksum: 'f'.repeat(64),
      channel: { definitionId: randomUUID(), channelKey: 'test-channel' },
      transformer: { key: 'test-transformer', version: '1.0.0' },
      artifact: {
        artifactId,
        artifactRevisionId,
        revision: 1,
        contentHash: 'a'.repeat(64),
        type: 'DEFINITION_PRODUCT' as const,
        locale: 'zh-CN',
        market: 'TW',
        methodPolicyVersion: 'task-17-v1',
      },
      manifest: { schemaVersion: '1.0.0', files: [], assetRefs: [], claimSourceMap: [] },
      packageSchemaVersion: '1.0.0',
      payloadObjectRef: 'memory://channel-package/private-body',
      createdByUserId: context.actorUserId,
      createdAt: now.toISOString(),
    };
    const approvedRevision = {
      id: artifactRevisionId,
      artifactId,
      revision: 1,
      contentHash: channelPackage.artifact.contentHash,
      status: 'APPROVED',
    };
    const publications = new InMemoryPublicationStore({
      jobs,
      packages: {
        createOrFind: () => Promise.reject(new Error()),
        findById: () => Promise.resolve(null),
      },
      artifacts: {
        findBundle: () =>
          Promise.resolve({
            artifact: {
              id: artifactId,
              tenantId: context.tenantId,
              workspaceId: context.workspaceId,
              revision: 1,
              status: 'APPROVED',
            },
            revision: approvedRevision,
            revisions: [approvedRevision],
            reviews: [
              {
                artifactId,
                artifactRevisionId,
                revision: 1,
                contentHash: channelPackage.artifact.contentHash,
                decision: 'APPROVE',
              },
            ],
            approvalState: 'ELIGIBLE',
            selectableApprovedRevisions: [
              { revision: 1, contentHash: channelPackage.artifact.contentHash },
            ],
          }),
      } as never,
      publicationPackages: { readPublicationPackage: () => Promise.resolve(null) },
      registry: { listEntries: () => Promise.resolve([]) },
      authorizations: {
        create: () => Promise.reject(new Error()),
        revoke: () => Promise.resolve(null),
        list: () => Promise.resolve([]),
        findForTarget: () => Promise.resolve(null),
        findSecretArn: () => Promise.resolve(null),
      },
      adapters: { resolve: () => null },
      publicationSecrets: {
        readPublicationSecret: () => Promise.reject(new Error()),
      },
      ids: { next: randomUUID },
      clock,
      tenancy: { resolveTenantContext: () => Promise.resolve(context) },
      audit,
    });
    await expect(
      publications.submit({
        context,
        actorSubject: 'task-17-publisher',
        publicationId,
        jobId: randomUUID(),
        reservationId: randomUUID(),
        budgetAlertId: randomUUID(),
        outboxMessageId: randomUUID(),
        auditEventId: randomUUID(),
        jobAuditEventId: randomUUID(),
        channelPackage,
        adapterVersionId: randomUUID(),
        channelAuthorization: {
          id: authorizationId,
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          adapterVersionId: randomUUID(),
          status: 'ACTIVE',
          grantedScopes: ['content:write'],
          acceptedTermsVersion: 'v1',
          target: 'https://publish.example.test/?access_token=must-not-leak',
          expiresAt: null,
          createdByUserId: context.actorUserId,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        requiredScopes: ['content:write'],
        target: 'https://publish.example.test/?access_token=must-not-leak',
        idempotencyKey: 'task-17-publication',
        requestHash: 'b'.repeat(64),
        estimatedUnits: 5,
        createdAt: now,
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      publication: { id: publicationId },
    });

    const events = audit.listTenant(context.tenantId);
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(['JOB_SUBMITTED', 'PUBLICATION_REQUESTED']),
    );
    expect(JSON.stringify(events)).not.toContain('must-not-leak');
    expect(JSON.stringify(events)).not.toContain('private-body');
  });
});
