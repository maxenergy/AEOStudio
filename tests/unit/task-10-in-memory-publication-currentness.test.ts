import { createHash } from 'node:crypto';

import { canonicalArtifactJson } from '@aeostudio/application/artifacts';
import type { ArtifactStore } from '@aeostudio/application/artifacts';
import type {
  ChannelAuthorizationSecretReferenceStore,
  ChannelAuthorizationStore,
  ChannelPackageStore,
  PublicationAdapter,
} from '@aeostudio/application/channels-publishing';
import type { TenantContext } from '@aeostudio/application/identity-access';
import type { ArtifactLedgerBundle, ArtifactRevisionRecord } from '@aeostudio/domain/artifacts';
import type {
  ChannelAuthorizationEligibility,
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';
import { describe, expect, test, vi } from 'vitest';

import {
  IN_MEMORY_ATOMIC_EFFECT_RUNNER,
  InMemoryPublicationStore,
} from '../../apps/api/src/channels/in-memory-publication-store.js';
import { InMemoryArtifactLineageValidator } from '../../apps/api/src/artifacts/in-memory-artifact-lineage-validator.js';
import {
  FAKE_ARTIFACT_LINEAGE,
  FAKE_ARTIFACT_PROMPT_IDS,
  fakeArtifactClaimBundle,
  fakeArtifactClaimEvidence,
  fakeArtifactPromptBundle,
} from '../../apps/api/src/artifacts/fake-artifact-lineage-fixture.js';
import { InMemoryEvidenceClaimStore } from '../../apps/api/src/claims/in-memory-evidence-claim-store.js';
import { InMemoryJobBudgetStore } from '../../apps/api/src/jobs/in-memory-job-budget-store.js';
import { InMemoryPromptResearchStore } from '../../apps/api/src/prompts/in-memory-prompt-research-store.js';

const NOW = new Date('2026-07-24T00:00:00.000Z');
const SECRET = 'publication-currentness-secret';
const TARGET = 'fixture://publication-currentness';
const context: TenantContext = {
  tenantId: '00000000-0000-7000-8000-000000001201',
  workspaceId: '00000000-0000-7000-8000-000000001202',
  actorUserId: '00000000-0000-7000-8000-000000001203',
  membershipId: '00000000-0000-7000-8000-000000001204',
  role: 'PUBLISHER',
};

type PublicationFixture = Awaited<ReturnType<typeof makeFixture>>;

describe('Task 10 in-memory publication Artifact currentness fences', () => {
  test('the default fake Claim lineage exposes exact approved review truth', () => {
    const claims = new InMemoryEvidenceClaimStore();

    expect(
      claims.findExactApprovedReviewNow({
        context,
        claimId: FAKE_ARTIFACT_LINEAGE.claimId,
        revisionId: FAKE_ARTIFACT_LINEAGE.claimRevisionId,
        contentHash: FAKE_ARTIFACT_LINEAGE.claimHash,
      }),
    ).toMatchObject({
      claimRevisionId: FAKE_ARTIFACT_LINEAGE.claimRevisionId,
      contentHash: FAKE_ARTIFACT_LINEAGE.claimHash,
      decision: 'APPROVE',
    });
    expect(
      claims.findExactApprovedReviewNow({
        context,
        claimId: FAKE_ARTIFACT_LINEAGE.claimId,
        revisionId: FAKE_ARTIFACT_LINEAGE.claimRevisionId,
        contentHash: '0'.repeat(64),
      }),
    ).toBeNull();
  });

  test('accepts a non-empty approved Prompt subset and rejects an Artifact with no Claim bindings', () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Lineage validator',
        'content.html': '<h1>Lineage validator</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const revision = makeRevision(makePackage(payload));
    const validator = new InMemoryArtifactLineageValidator({
      prompts: new InMemoryPromptResearchStore(),
      claims: new InMemoryEvidenceClaimStore(),
      clock: { now: () => new Date(NOW) },
    });

    expect(revision.lineage.prompt.promptIds.length).toBeLessThan(FAKE_ARTIFACT_PROMPT_IDS.length);
    expect(validator.isCurrent({ context, revision })).toBe(true);
    expect(
      validator.isCurrent({
        context,
        revision: { ...revision, claimBindings: [] },
      }),
    ).toBe(false);
  });

  test('rejects an approved Claim when its exact approval review truth is absent', () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Missing Claim review',
        'content.html': '<h1>Missing Claim review</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const revision = makeRevision(makePackage(payload));
    const claims = new InMemoryEvidenceClaimStore();
    vi.spyOn(claims, 'findExactApprovedReviewNow').mockReturnValue(null);
    const validator = new InMemoryArtifactLineageValidator({
      prompts: new InMemoryPromptResearchStore(),
      claims,
      clock: { now: () => new Date(NOW) },
    });

    expect(validator.isCurrent({ context, revision })).toBe(false);
  });

  test('the atomic runner fails closed when live validation throws', () => {
    const effect = vi.fn(() => Promise.resolve('not-called'));

    expect(
      IN_MEMORY_ATOMIC_EFFECT_RUNNER.run({
        validate() {
          throw new Error('LIVE_EFFECT_STATE_UNAVAILABLE');
        },
        effect,
      }),
    ).toEqual({ outcome: 'GATE_STALE' });
    expect(effect).not.toHaveBeenCalled();
  });

  test('rejects an approved historical package when a newer Artifact revision exists before submit', async () => {
    const fixture = await makeFixture({ currentRevision: 2 });

    await expect(fixture.store.submit(fixture.submitInput)).resolves.toEqual({
      outcome: 'APPROVAL_STALE',
    });
    expect(fixture.submitJob).not.toHaveBeenCalled();
  });

  test('rejects a lineage-stale package before submit while its exact approved revision and review stay unchanged', async () => {
    const fixture = await makeFixture({ currentRevision: 1 });
    fixture.setBundle({
      ...makeBundle(fixture.submitInput.channelPackage, 1),
      approvalState: 'APPROVAL_STALE',
      selectableApprovedRevisions: [],
    });

    await expect(fixture.store.submit(fixture.submitInput)).resolves.toEqual({
      outcome: 'APPROVAL_STALE',
    });
    expect(fixture.submitJob).not.toHaveBeenCalled();
  });

  test('rejects the current approved revision before submit when its exact approval review is absent', async () => {
    const fixture = await makeFixture({ currentRevision: 1 });
    fixture.setBundle({
      ...makeBundle(fixture.submitInput.channelPackage, 1),
      reviews: [],
    });

    await expect(fixture.store.submit(fixture.submitInput)).resolves.toEqual({
      outcome: 'APPROVAL_STALE',
    });
    expect(fixture.submitJob).not.toHaveBeenCalled();
  });

  test('does not publish when a newer Artifact revision wins after package load', async () => {
    const fixture = await makeFixture({ currentRevision: 1 });
    const validationEntered = deferred<void>();
    const releaseValidation = deferred<void>();
    fixture.validateAuthorization.mockImplementationOnce(async () => {
      validationEntered.resolve();
      await releaseValidation.promise;
      return { outcome: 'VALID' };
    });

    const submitted = await fixture.store.submit(fixture.submitInput);
    expect(submitted.outcome).toBe('SUCCEEDED');
    if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    const processing = fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await validationEntered.promise;

    fixture.setBundle(makeBundle(fixture.submitInput.channelPackage, 2));
    releaseValidation.resolve();

    await expect(processing).resolves.toMatchObject({
      status: 'FAILED_TERMINAL',
      errorCode: 'PUBLICATION_GATE_STALE',
    });
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  test('does not publish when only Artifact lineage becomes stale after package load', async () => {
    const fixture = await makeFixture({ currentRevision: 1 });
    const validationEntered = deferred<void>();
    const releaseValidation = deferred<void>();
    fixture.validateAuthorization.mockImplementationOnce(async () => {
      validationEntered.resolve();
      await releaseValidation.promise;
      return { outcome: 'VALID' };
    });

    const submitted = await fixture.store.submit(fixture.submitInput);
    expect(submitted.outcome).toBe('SUCCEEDED');
    if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    const processing = fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await validationEntered.promise;

    fixture.setBundle({
      ...makeBundle(fixture.submitInput.channelPackage, 1),
      approvalState: 'APPROVAL_STALE',
      selectableApprovedRevisions: [],
    });
    releaseValidation.resolve();

    await expect(processing).resolves.toMatchObject({
      status: 'FAILED_TERMINAL',
      errorCode: 'PUBLICATION_GATE_STALE',
    });
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  test('does not publish when the real Prompt store advances after secret I/O and before the effect', async () => {
    const prompts = new InMemoryPromptResearchStore();
    const approvedPrompt = await seedApprovedPrompt(prompts);
    const fixture = await makeFixture({ currentRevision: 1, prompts });
    fixture.readPublicationSecret.mockImplementationOnce(async () => {
      await prompts.createRevision({
        context,
        promptSetId: approvedPrompt.promptSet.id,
        expectedRevision: 1,
        revisionId: '00000000-0000-7000-8000-000000001299',
        scenarioId: '00000000-0000-7000-8000-000000001298',
        prompts: approvedPrompt.revision.prompts,
        scopes: approvedPrompt.revision.scopes,
        scenario: scenarioInput(approvedPrompt),
        promptContentHash: '9'.repeat(64),
        scenarioContentHash: '8'.repeat(64),
        createdAt: new Date(NOW),
        auditEventId: '00000000-0000-7000-8000-000000001297',
      });
      return SECRET;
    });

    const submitted = await fixture.store.submit(fixture.submitInput);
    expect(submitted.outcome).toBe('SUCCEEDED');
    if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });

    await expect(fixture.jobs.findJob({ context, jobId: submitted.job.id })).resolves.toMatchObject(
      {
        status: 'FAILED_TERMINAL',
        errorCode: 'PUBLICATION_GATE_STALE',
      },
    );
    await expect(
      prompts.findCurrent({ context, promptSetId: approvedPrompt.promptSet.id }),
    ).resolves.toMatchObject({ promptSet: { currentRevision: 2 } });
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  test('does not publish when the real Evidence source advances after secret I/O and before the effect', async () => {
    const claims = new InMemoryEvidenceClaimStore();
    const approvedClaim = await seedApprovedClaim(claims);
    const fixture = await makeFixture({ currentRevision: 1, claims });
    fixture.readPublicationSecret.mockImplementationOnce(async () => {
      await claims.createSnapshot({
        context,
        snapshotId: '00000000-0000-7000-8000-000000001294',
        sourceId: FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
        contentHash: '7'.repeat(64),
        objectRef: 'memory://publication-currentness/evidence-r2',
        contentType: 'text/plain',
        sizeBytes: 256,
        capturedAt: new Date(NOW),
        auditEventId: '00000000-0000-7000-8000-000000001293',
      });
      return SECRET;
    });

    const submitted = await fixture.store.submit(fixture.submitInput);
    expect(submitted.outcome).toBe('SUCCEEDED');
    if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });

    await expect(fixture.jobs.findJob({ context, jobId: submitted.job.id })).resolves.toMatchObject(
      {
        status: 'FAILED_TERMINAL',
        errorCode: 'PUBLICATION_GATE_STALE',
      },
    );
    const currentEvidence = await claims.findEvidenceDrillDown({
      context,
      claimId: approvedClaim.claim.id,
      revisionId: approvedClaim.revision.id,
    });
    expect(currentEvidence?.[0]?.source.currentSnapshotId).toBe(
      '00000000-0000-7000-8000-000000001294',
    );
    expect(currentEvidence?.[0]?.snapshot.id).toBe(FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId);
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  test('starts publish synchronously after the final gate read before a queued lineage mutation', async () => {
    const fixture = await makeFixture({ currentRevision: 1 });
    const order: string[] = [];
    let lineageIsCurrent = true;
    fixture.onBeforeAtomicArtifactCheck(() => {
      queueMicrotask(() => {
        lineageIsCurrent = false;
        fixture.setBundle(makeBundle(fixture.submitInput.channelPackage, 2));
        order.push('LINEAGE_STALE');
      });
    });
    fixture.publish.mockImplementationOnce(() => {
      order.push(lineageIsCurrent ? 'PUBLISH_BEFORE_STALE' : 'PUBLISH_AFTER_STALE');
      return Promise.resolve({
        outcome: 'APPLIED' as const,
        remoteRef: 'fixture://publication-currentness/linearized-effect',
      });
    });

    const submitted = await fixture.store.submit(fixture.submitInput);
    expect(submitted.outcome).toBe('SUCCEEDED');
    if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    const processing = fixture.jobs.findJob({ context, jobId: submitted.job.id });

    await expect(processing).resolves.toMatchObject({ status: 'SUCCEEDED', errorCode: null });
    expect(order).toEqual(['PUBLISH_BEFORE_STALE', 'LINEAGE_STALE']);
  });

  test.each([
    {
      name: 'the current authorization no longer grants every governed scope',
      mutate: (fixture: PublicationFixture) => {
        fixture.setAuthorization({
          ...makeAuthorization(),
          grantedScopes: [],
        });
      },
    },
    {
      name: 'provider validation no longer proves every governed scope',
      mutate: (fixture: PublicationFixture) => {
        const authorization = makeAuthorization();
        fixture.setAuthorization({
          ...authorization,
          validationSnapshot: {
            ...authorization.validationSnapshot!,
            actualScopes: [],
          },
        });
      },
    },
    {
      name: 'the current authorization accepted a different terms version',
      mutate: (fixture: PublicationFixture) => {
        fixture.setAuthorization({
          ...makeAuthorization(),
          acceptedTermsVersion: 'fixture-terms-stale',
        });
      },
    },
    {
      name: 'provider validation is bound to a different terms version',
      mutate: (fixture: PublicationFixture) => {
        const authorization = makeAuthorization();
        fixture.setAuthorization({
          ...authorization,
          validationSnapshot: {
            ...authorization.validationSnapshot!,
            acceptedTermsVersion: 'fixture-terms-stale',
          },
        });
      },
    },
    {
      name: 'the Registry removes the publish capability',
      mutate: (fixture: PublicationFixture) => {
        const entry = makeRegistryEntry(fixture.submitInput.channelPackage);
        entry.adapterVersions[0]!.capabilities = ['PREVIEW', 'RECONCILE'];
        fixture.setRegistryEntries([entry]);
      },
    },
    {
      name: 'the Registry terms are no longer allowed',
      mutate: (fixture: PublicationFixture) => {
        const entry = makeRegistryEntry(fixture.submitInput.channelPackage);
        entry.adapterVersions[0]!.termsStatus = 'DENIED';
        fixture.setRegistryEntries([entry]);
      },
    },
    {
      name: 'the Registry adapter version changes',
      mutate: (fixture: PublicationFixture) => {
        const entry = makeRegistryEntry(fixture.submitInput.channelPackage);
        entry.adapterVersions[0]!.adapterVersion = '2.0.0';
        fixture.setRegistryEntries([entry]);
      },
    },
    {
      name: 'the authorization secret reference changes',
      mutate: (fixture: PublicationFixture) => {
        fixture.setSecretReference('arn:fixture:publication-currentness-rotated');
      },
    },
    {
      name: 'the validated credential fingerprint changes',
      mutate: (fixture: PublicationFixture) => {
        fixture.setCredentialFingerprint('f'.repeat(64));
      },
    },
    {
      name: 'the current secret value no longer matches the validated fingerprint',
      mutate: (fixture: PublicationFixture) => {
        fixture.setSecretValue(`${SECRET}-rotated`);
      },
    },
  ])('does not publish when $name at the final effect boundary', async ({ mutate }) => {
    const fixture = await makeFixture({ currentRevision: 1 });
    const { processing, releaseValidation } = await pausePublishAtAuthorizationValidation(fixture);

    mutate(fixture);
    releaseValidation.resolve();

    await expect(processing).resolves.toMatchObject({
      status: 'FAILED_TERMINAL',
      errorCode: 'PUBLICATION_GATE_STALE',
    });
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  test('does not publish when target-aware scopes drift from the command-time snapshot', async () => {
    const fixture = await makeFixture({ currentRevision: 1 });
    const scopeUniverse = ['content:write', 'content:admin'];
    let dynamicRequiredScopes = ['content:write'];
    const descriptor = fixture.adapter.describe();
    Object.assign(fixture.adapter, {
      describe: () => ({ ...descriptor, requiredScopes: [...scopeUniverse] }),
      requiredScopesFor: () => [...dynamicRequiredScopes],
    });
    const registryEntry = makeRegistryEntry(fixture.submitInput.channelPackage);
    registryEntry.adapterVersions[0]!.requiredScopes = [...scopeUniverse];
    fixture.setRegistryEntries([registryEntry]);
    const authorization = makeAuthorization();
    fixture.setAuthorization({
      ...authorization,
      grantedScopes: [...scopeUniverse],
      validationSnapshot: {
        ...authorization.validationSnapshot!,
        actualScopes: [...scopeUniverse],
      },
    });
    const { processing, releaseValidation } = await pausePublishAtAuthorizationValidation(fixture);

    dynamicRequiredScopes = ['content:admin'];
    releaseValidation.resolve();

    await expect(processing).resolves.toMatchObject({
      status: 'FAILED_TERMINAL',
      errorCode: 'PUBLICATION_GATE_STALE',
    });
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  test('publishes when the command-time and live target-aware scope sets are both legitimately empty', async () => {
    const fixture = await makeFixture({ currentRevision: 1 });
    const descriptor = fixture.adapter.describe();
    Object.assign(fixture.adapter, {
      describe: () => ({ ...descriptor, requiredScopes: [] }),
      requiredScopesFor: () => [],
    });
    const registryEntry = makeRegistryEntry(fixture.submitInput.channelPackage);
    registryEntry.adapterVersions[0]!.requiredScopes = [];
    fixture.setRegistryEntries([registryEntry]);
    const authorization = makeAuthorization();
    fixture.setAuthorization({
      ...authorization,
      grantedScopes: [],
      validationSnapshot: {
        ...authorization.validationSnapshot!,
        actualScopes: [],
      },
    });
    fixture.submitInput.requiredScopes = [];

    const submitted = await fixture.store.submit(fixture.submitInput);
    expect(submitted.outcome).toBe('SUCCEEDED');
    if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });

    await expect(fixture.jobs.findJob({ context, jobId: submitted.job.id })).resolves.toMatchObject(
      {
        status: 'SUCCEEDED',
        errorCode: null,
      },
    );
    expect(fixture.publish).toHaveBeenCalledTimes(1);
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  test('continues reconciliation after the real Prompt lineage becomes stale without publishing again', async () => {
    const prompts = new InMemoryPromptResearchStore();
    const approvedPrompt = await seedApprovedPrompt(prompts);
    const fixture = await makeFixture({ currentRevision: 1, prompts });
    fixture.publish.mockResolvedValueOnce({
      outcome: 'UNKNOWN',
      errorCode: 'FIXTURE_AMBIGUOUS',
    });
    fixture.reconcile.mockResolvedValueOnce({
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'FIXTURE_RETRY',
    });

    const submitted = await fixture.store.submit(fixture.submitInput);
    expect(submitted.outcome).toBe('SUCCEEDED');
    if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await expect(fixture.jobs.findJob({ context, jobId: submitted.job.id })).resolves.toMatchObject(
      {
        status: 'RETRY_WAIT',
        errorCode: 'ADAPTER_RECONCILE_RETRYABLE_FAILURE',
      },
    );
    expect(fixture.publish).toHaveBeenCalledTimes(1);
    expect(fixture.reconcile).toHaveBeenCalledTimes(1);
    fixture.publish.mockClear();
    fixture.reconcile.mockClear();

    const validationEntered = deferred<void>();
    const releaseValidation = deferred<void>();
    fixture.validateAuthorization.mockImplementationOnce(async () => {
      validationEntered.resolve();
      await releaseValidation.promise;
      return { outcome: 'VALID' };
    });
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    const processing = fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await validationEntered.promise;

    await prompts.createRevision({
      context,
      promptSetId: approvedPrompt.promptSet.id,
      expectedRevision: 1,
      revisionId: '00000000-0000-7000-8000-000000001286',
      scenarioId: '00000000-0000-7000-8000-000000001285',
      prompts: approvedPrompt.revision.prompts,
      scopes: approvedPrompt.revision.scopes,
      scenario: scenarioInput(approvedPrompt),
      promptContentHash: '6'.repeat(64),
      scenarioContentHash: '5'.repeat(64),
      createdAt: new Date(NOW),
      auditEventId: '00000000-0000-7000-8000-000000001284',
    });
    releaseValidation.resolve();

    await expect(processing).resolves.toMatchObject({
      status: 'FAILED_TERMINAL',
      errorCode: 'ADAPTER_RECONCILE_DEFINITELY_NOT_APPLIED',
    });
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.reconcile).toHaveBeenCalledTimes(1);
  });

  test('reconciles an ambiguous publish after Artifact r2 becomes current without publishing again', async () => {
    const fixture = await makeFixture({ currentRevision: 1 });
    fixture.publish.mockImplementationOnce(() => {
      fixture.setBundle(makeBundle(fixture.submitInput.channelPackage, 2));
      return Promise.resolve({
        outcome: 'UNKNOWN' as const,
        errorCode: 'FIXTURE_AMBIGUOUS',
      });
    });

    const submitted = await fixture.store.submit(fixture.submitInput);
    expect(submitted.outcome).toBe('SUCCEEDED');
    if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    const processing = fixture.jobs.findJob({ context, jobId: submitted.job.id });

    await expect(processing).resolves.toMatchObject({
      status: 'FAILED_TERMINAL',
      errorCode: 'ADAPTER_RECONCILE_DEFINITELY_NOT_APPLIED',
    });
    expect(fixture.publish).toHaveBeenCalledTimes(1);
    expect(fixture.reconcile).toHaveBeenCalledTimes(1);
  });

  test('starts reconcile synchronously after the final gate read before a queued lineage mutation', async () => {
    const fixture = await makeFixture({ currentRevision: 1 });
    fixture.publish.mockResolvedValueOnce({
      outcome: 'UNKNOWN',
      errorCode: 'FIXTURE_AMBIGUOUS',
    });
    const order: string[] = [];
    let registryIsCurrent = true;
    let atomicRegistryReads = 0;
    fixture.onBeforeAtomicRegistryRead(() => {
      atomicRegistryReads += 1;
      if (atomicRegistryReads !== 2) return;
      queueMicrotask(() => {
        registryIsCurrent = false;
        fixture.setRegistryEntries([]);
        order.push('REGISTRY_STALE');
      });
    });
    fixture.reconcile.mockImplementationOnce(() => {
      order.push(registryIsCurrent ? 'RECONCILE_BEFORE_STALE' : 'RECONCILE_AFTER_STALE');
      return Promise.resolve({
        outcome: 'APPLIED' as const,
        remoteRef: 'fixture://publication-currentness/linearized-reconcile-effect',
      });
    });

    const submitted = await fixture.store.submit(fixture.submitInput);
    expect(submitted.outcome).toBe('SUCCEEDED');
    if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    await fixture.jobs.findJob({ context, jobId: submitted.job.id });
    const processing = fixture.jobs.findJob({ context, jobId: submitted.job.id });

    await expect(processing).resolves.toMatchObject({ status: 'SUCCEEDED', errorCode: null });
    expect(order).toEqual(['RECONCILE_BEFORE_STALE', 'REGISTRY_STALE']);
  });

  test.each([
    {
      name: 'authorization scopes change',
      mutate: (fixture: PublicationFixture) => {
        fixture.setAuthorization({
          ...makeAuthorization(),
          grantedScopes: [],
        });
      },
    },
    {
      name: 'authorization terms change',
      mutate: (fixture: PublicationFixture) => {
        fixture.setAuthorization({
          ...makeAuthorization(),
          acceptedTermsVersion: 'fixture-terms-stale',
        });
      },
    },
    {
      name: 'Registry reconcile capability is removed',
      mutate: (fixture: PublicationFixture) => {
        const entry = makeRegistryEntry(fixture.submitInput.channelPackage);
        entry.adapterVersions[0]!.capabilities = ['PREVIEW', 'PUBLISH'];
        fixture.setRegistryEntries([entry]);
      },
    },
    {
      name: 'Registry adapter version changes',
      mutate: (fixture: PublicationFixture) => {
        const entry = makeRegistryEntry(fixture.submitInput.channelPackage);
        entry.adapterVersions[0]!.adapterVersion = '2.0.0';
        fixture.setRegistryEntries([entry]);
      },
    },
    {
      name: 'secret reference changes',
      mutate: (fixture: PublicationFixture) => {
        fixture.setSecretReference('arn:fixture:publication-currentness-rotated');
      },
    },
    {
      name: 'secret value fingerprint changes',
      mutate: (fixture: PublicationFixture) => {
        fixture.setCredentialFingerprint('f'.repeat(64));
      },
    },
  ])('does not run recovery when $name at the final recovery boundary', async ({ mutate }) => {
    const fixture = await makeFixture({ currentRevision: 1 });
    const { processing, releaseValidation } = await pauseRetryingReconcileAtValidation(fixture);

    mutate(fixture);
    releaseValidation.resolve();

    await expect(processing).resolves.toMatchObject({
      status: 'FAILED_TERMINAL',
      errorCode: 'PUBLICATION_GATE_STALE',
    });
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });
});

async function pausePublishAtAuthorizationValidation(fixture: PublicationFixture) {
  const validationEntered = deferred<void>();
  const releaseValidation = deferred<void>();
  fixture.validateAuthorization.mockImplementationOnce(async () => {
    validationEntered.resolve();
    await releaseValidation.promise;
    return { outcome: 'VALID' };
  });

  const submitted = await fixture.store.submit(fixture.submitInput);
  expect(submitted.outcome).toBe('SUCCEEDED');
  if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
  await fixture.jobs.findJob({ context, jobId: submitted.job.id });
  await fixture.jobs.findJob({ context, jobId: submitted.job.id });
  const processing = fixture.jobs.findJob({ context, jobId: submitted.job.id });
  await validationEntered.promise;
  return { processing, releaseValidation };
}

async function pauseRetryingReconcileAtValidation(fixture: PublicationFixture) {
  fixture.publish.mockResolvedValueOnce({
    outcome: 'UNKNOWN',
    errorCode: 'FIXTURE_AMBIGUOUS',
  });
  fixture.reconcile.mockResolvedValueOnce({
    outcome: 'RETRYABLE_FAILURE',
    errorCode: 'FIXTURE_RETRY',
  });
  const submitted = await fixture.store.submit(fixture.submitInput);
  expect(submitted.outcome).toBe('SUCCEEDED');
  if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
  await fixture.jobs.findJob({ context, jobId: submitted.job.id });
  await fixture.jobs.findJob({ context, jobId: submitted.job.id });
  await expect(fixture.jobs.findJob({ context, jobId: submitted.job.id })).resolves.toMatchObject({
    status: 'RETRY_WAIT',
  });
  expect(fixture.publish).toHaveBeenCalledTimes(1);
  expect(fixture.reconcile).toHaveBeenCalledTimes(1);
  fixture.publish.mockClear();
  fixture.reconcile.mockClear();

  const validationEntered = deferred<void>();
  const releaseValidation = deferred<void>();
  fixture.validateAuthorization.mockImplementationOnce(async () => {
    validationEntered.resolve();
    await releaseValidation.promise;
    return { outcome: 'VALID' };
  });
  await fixture.jobs.findJob({ context, jobId: submitted.job.id });
  const processing = fixture.jobs.findJob({ context, jobId: submitted.job.id });
  await validationEntered.promise;
  return { processing, releaseValidation };
}

async function makeFixture(input: {
  currentRevision: 1 | 2;
  prompts?: InMemoryPromptResearchStore;
  claims?: InMemoryEvidenceClaimStore;
}) {
  const payload: ChannelPackagePayload = {
    files: {
      'content.md': '# Approved revision one',
      'content.html': '<h1>Approved revision one</h1>',
      'structured-data.json': '{"@context":"https://schema.org"}',
    },
  };
  const channelPackage = makePackage(payload);
  const authorization = makeAuthorization();
  const jobs = new InMemoryJobBudgetStore(undefined, undefined, { now: () => new Date(NOW) });
  await jobs.setBudget({
    context: { ...context, role: 'OWNER' },
    policyId: '00000000-0000-7000-8000-000000001205',
    limitUnits: 100,
    auditEventId: '00000000-0000-7000-8000-000000001206',
  });
  const submitJob = vi.spyOn(jobs, 'submitJob');
  let liveBundle = makeBundle(channelPackage, input.currentRevision);
  let liveRegistryEntries = [makeRegistryEntry(channelPackage)];
  let liveAuthorization = authorization;
  let liveSecretReference = 'arn:fixture:publication-currentness';
  let liveCredentialFingerprint = createHash('sha256').update(SECRET).digest('hex');
  let liveSecretValue = SECRET;
  let beforeAtomicArtifactCheck: (() => void) | undefined;
  let beforeAtomicRegistryRead: (() => void) | undefined;
  const lineageValidator = new InMemoryArtifactLineageValidator({
    prompts: input.prompts ?? new InMemoryPromptResearchStore(),
    claims: input.claims ?? new InMemoryEvidenceClaimStore(),
    clock: { now: () => new Date(NOW) },
  });
  const findBundle = vi.fn(() => Promise.resolve(structuredClone(liveBundle)));
  const listEntries = vi.fn(() => Promise.resolve(structuredClone(liveRegistryEntries)));
  const artifacts = { findBundle } as unknown as ArtifactStore;
  const adapterFixture = makeAdapter(channelPackage, payload);
  const { adapter } = adapterFixture;
  const findForTarget = vi.fn(() => Promise.resolve(structuredClone(liveAuthorization)));
  const findSecretArn = vi.fn(() => Promise.resolve(liveSecretReference));
  const findCredentialFingerprint = vi.fn(() => Promise.resolve(liveCredentialFingerprint));
  const authorizations = {
    findForTarget,
    findSecretArn,
    findCredentialFingerprint,
  } as unknown as ChannelAuthorizationStore &
    ChannelAuthorizationSecretReferenceStore & {
      findCredentialFingerprint(input: {
        context: TenantContext;
        authorizationId: string;
      }): Promise<string | null>;
    };
  const readPublicationSecret = vi.fn(() => Promise.resolve(liveSecretValue));
  const store = new InMemoryPublicationStore({
    jobs,
    packages: {
      findById: vi.fn().mockResolvedValue(channelPackage),
    } as unknown as ChannelPackageStore,
    artifacts,
    publicationPackages: {
      readPublicationPackage: vi.fn().mockResolvedValue(payload),
    },
    publicationSecrets: {
      readPublicationSecret,
    },
    registry: {
      listEntries,
    },
    authorizations,
    adapters: { resolve: vi.fn().mockReturnValue(adapter) },
    ids: { next: sequentialIds() },
    clock: { now: () => new Date(NOW) },
    tenancy: { resolveTenantContext: vi.fn().mockResolvedValue(context) },
    atomicEffectRunner: IN_MEMORY_ATOMIC_EFFECT_RUNNER,
    liveEffectState: {
      resolveTenantContext: () => structuredClone(context),
      isCurrentApprovedArtifact: (expected) => {
        beforeAtomicArtifactCheck?.();
        return bundleIsCurrentApproved(liveBundle, expected);
      },
      isCurrentApprovedLineage: ({ context: currentContext, ...expected }) =>
        bundleIsCurrentApproved(liveBundle, expected) &&
        liveBundle.revision !== null &&
        lineageValidator.isCurrent({
          context: currentContext,
          revision: liveBundle.revision,
        }),
      listRegistryEntries: () => {
        beforeAtomicRegistryRead?.();
        return structuredClone(liveRegistryEntries);
      },
      findAuthorization: (expected) =>
        liveAuthorization.id === expected.authorizationId &&
        liveAuthorization.adapterVersionId === expected.adapterVersionId &&
        liveAuthorization.target === expected.target
          ? {
              authorization: structuredClone(liveAuthorization),
              secretReference: liveSecretReference,
              credentialFingerprint: liveCredentialFingerprint,
            }
          : null,
      secretValueMatches: (expected) =>
        expected.secretReference === liveSecretReference &&
        expected.secretValue === liveSecretValue,
    },
  });

  return {
    ...adapterFixture,
    findBundle,
    findForTarget,
    findSecretArn,
    findCredentialFingerprint,
    readPublicationSecret,
    setBundle(value: ArtifactLedgerBundle) {
      liveBundle = structuredClone(value);
    },
    setRegistryEntries(value: ReturnType<typeof makeRegistryEntry>[]) {
      liveRegistryEntries = structuredClone(value);
    },
    setAuthorization(value: ChannelAuthorizationEligibility) {
      liveAuthorization = structuredClone(value);
    },
    setSecretReference(value: string) {
      liveSecretReference = value;
    },
    setCredentialFingerprint(value: string) {
      liveCredentialFingerprint = value;
    },
    setSecretValue(value: string) {
      liveSecretValue = value;
    },
    onBeforeAtomicArtifactCheck(callback: () => void) {
      beforeAtomicArtifactCheck = callback;
    },
    onBeforeAtomicRegistryRead(callback: () => void) {
      beforeAtomicRegistryRead = callback;
    },
    listEntries,
    jobs,
    store,
    submitJob,
    submitInput: {
      context,
      actorSubject: 'publication-currentness-subject',
      publicationId: '00000000-0000-7000-8000-000000001221',
      jobId: '00000000-0000-7000-8000-000000001222',
      reservationId: '00000000-0000-7000-8000-000000001223',
      budgetAlertId: '00000000-0000-7000-8000-000000001224',
      outboxMessageId: '00000000-0000-7000-8000-000000001225',
      auditEventId: '00000000-0000-7000-8000-000000001226',
      jobAuditEventId: '00000000-0000-7000-8000-000000001227',
      channelPackage,
      adapterVersionId: '00000000-0000-7000-8000-000000001228',
      channelAuthorization: authorization,
      requiredScopes: ['content:write'],
      target: TARGET,
      idempotencyKey: 'publication-currentness-submit',
      requestHash: 'b'.repeat(64),
      estimatedUnits: 5,
      createdAt: new Date(NOW),
    },
  };
}

function makePackage(payload: ChannelPackagePayload): ChannelPackageRecord {
  const channel = {
    definitionId: '00000000-0000-7000-8000-000000001211',
    channelKey: 'publication-currentness',
  };
  const transformer = { key: 'generic-web-package', version: '1.0.0' };
  const artifact = {
    artifactId: '00000000-0000-7000-8000-000000001212',
    artifactRevisionId: '00000000-0000-7000-8000-000000001213',
    revision: 1,
    contentHash: 'a'.repeat(64),
    type: 'DEFINITION_PRODUCT' as const,
    locale: 'en-SG',
    market: 'SG',
    methodPolicyVersion: 'fixture-v1',
  };
  const manifest = {
    schemaVersion: '1.0.0',
    files: Object.entries(payload.files).map(([path, content]) => ({
      path,
      mediaType:
        path === 'content.md'
          ? 'text/markdown'
          : path === 'content.html'
            ? 'text/html'
            : 'application/ld+json',
      sha256: sha256(content),
      byteLength: Buffer.byteLength(content),
    })),
    assetRefs: [],
    claimSourceMap: [],
  };
  const packageSchemaVersion = '1.0.0';
  return {
    id: '00000000-0000-7000-8000-000000001214',
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    packageRevision: 1,
    packageChecksum: sha256(
      canonicalArtifactJson({
        packageSchemaVersion,
        channel,
        transformer,
        artifact,
        manifest,
        payload,
      }),
    ),
    channel,
    transformer,
    packageSchemaVersion,
    artifact,
    manifest,
    payloadObjectRef: 'memory://publication-currentness-package',
    createdByUserId: context.actorUserId,
    createdAt: NOW.toISOString(),
  };
}

function makeBundle(
  channelPackage: ChannelPackageRecord,
  currentRevision: 1 | 2,
): ArtifactLedgerBundle {
  const revisionOne = makeRevision(channelPackage);
  const revisionTwo: ArtifactRevisionRecord = {
    ...revisionOne,
    id: '00000000-0000-7000-8000-000000001215',
    revision: 2,
    contentHash: 'c'.repeat(64),
    status: 'DRAFT',
    payloadObjectRef: 'memory://publication-currentness-r2',
  };
  return {
    artifact: {
      id: channelPackage.artifact.artifactId,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      briefId: revisionOne.briefId,
      type: channelPackage.artifact.type,
      revision: currentRevision,
      status: currentRevision === 1 ? 'APPROVED' : 'DRAFT',
      locale: channelPackage.artifact.locale,
      market: channelPackage.artifact.market,
      methodPolicyVersion: channelPackage.artifact.methodPolicyVersion,
      jobId: null,
      createdByUserId: context.actorUserId,
      createdAt: NOW.toISOString(),
    },
    revision: currentRevision === 1 ? revisionOne : revisionTwo,
    revisions: currentRevision === 1 ? [revisionOne] : [revisionOne, revisionTwo],
    reviews: [
      {
        id: '00000000-0000-7000-8000-000000001216',
        artifactId: channelPackage.artifact.artifactId,
        artifactRevisionId: channelPackage.artifact.artifactRevisionId,
        revision: 1,
        contentHash: channelPackage.artifact.contentHash,
        decision: 'APPROVE',
        reviewerUserId: '00000000-0000-7000-8000-000000001217',
        note: 'Approved revision one.',
        createdAt: NOW.toISOString(),
      },
    ],
    approvalState: currentRevision === 1 ? 'ELIGIBLE' : 'APPROVAL_STALE',
    selectableApprovedRevisions: [
      { revision: 1, contentHash: channelPackage.artifact.contentHash },
    ],
  };
}

function bundleIsCurrentApproved(
  bundle: ArtifactLedgerBundle,
  expected: {
    tenantId: string;
    workspaceId: string;
    artifactId: string;
    artifactRevisionId: string;
    revision: number;
    contentHash: string;
  },
): boolean {
  return (
    bundle.artifact.tenantId === expected.tenantId &&
    bundle.artifact.workspaceId === expected.workspaceId &&
    bundle.artifact.id === expected.artifactId &&
    bundle.artifact.revision === expected.revision &&
    bundle.artifact.status === 'APPROVED' &&
    bundle.revision?.id === expected.artifactRevisionId &&
    bundle.revision.artifactId === expected.artifactId &&
    bundle.revision.revision === expected.revision &&
    bundle.revision.contentHash === expected.contentHash &&
    bundle.revision.status === 'APPROVED' &&
    bundle.approvalState === 'ELIGIBLE' &&
    bundle.selectableApprovedRevisions.some(
      (candidate) =>
        candidate.revision === expected.revision && candidate.contentHash === expected.contentHash,
    ) &&
    bundle.reviews.some(
      (review) =>
        review.artifactId === expected.artifactId &&
        review.artifactRevisionId === expected.artifactRevisionId &&
        review.revision === expected.revision &&
        review.contentHash === expected.contentHash &&
        review.decision === 'APPROVE',
    )
  );
}

function makeRevision(channelPackage: ChannelPackageRecord): ArtifactRevisionRecord {
  return {
    id: channelPackage.artifact.artifactRevisionId,
    artifactId: channelPackage.artifact.artifactId,
    revision: 1,
    briefId: '00000000-0000-7000-8000-000000001218',
    type: channelPackage.artifact.type,
    schemaVersion: '1.0.0',
    contentHash: channelPackage.artifact.contentHash,
    status: 'APPROVED',
    locale: channelPackage.artifact.locale,
    market: channelPackage.artifact.market,
    sourceArtifactIds: [],
    lineage: {
      contentPlanId: '00000000-0000-7000-8000-000000001219',
      brief: { id: '00000000-0000-7000-8000-000000001218', contentHash: 'd'.repeat(64) },
      prompt: {
        promptSetId: FAKE_ARTIFACT_LINEAGE.promptSetId,
        promptRevisionId: FAKE_ARTIFACT_LINEAGE.promptRevisionId,
        contentHash: FAKE_ARTIFACT_LINEAGE.promptHash,
        promptIds: FAKE_ARTIFACT_PROMPT_IDS.slice(0, 3),
      },
      sourceReferences: [
        {
          kind: 'PROMPT_REVISION',
          id: FAKE_ARTIFACT_LINEAGE.promptRevisionId,
          aggregateId: FAKE_ARTIFACT_LINEAGE.promptSetId,
          revision: 1,
          contentHash: FAKE_ARTIFACT_LINEAGE.promptHash,
        },
      ],
    },
    claimBindings: [
      {
        claimId: FAKE_ARTIFACT_LINEAGE.claimId,
        claimRevisionId: FAKE_ARTIFACT_LINEAGE.claimRevisionId,
        claimContentHash: FAKE_ARTIFACT_LINEAGE.claimHash,
        claimStatement: 'The approved fixture claim is traceable to current evidence.',
        evidence: [
          {
            sourceId: FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
            snapshotId: FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
            sourceHash: FAKE_ARTIFACT_LINEAGE.evidenceHash,
          },
        ],
      },
    ],
    methodPolicyVersion: channelPackage.artifact.methodPolicyVersion,
    createdByActor: { kind: 'AGENT', id: '00000000-0000-7000-8000-000000001233' },
    createdAt: NOW.toISOString(),
    payloadObjectRef: 'memory://publication-currentness-r1',
  };
}

async function seedApprovedPrompt(store: InMemoryPromptResearchStore) {
  const prompt = fakeArtifactPromptBundle({
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    actorUserId: context.actorUserId,
  });
  await store.createProposal({
    context,
    promptSetId: prompt.promptSet.id,
    revisionId: prompt.revision.id,
    scenarioId: prompt.scenario.id,
    title: prompt.revision.title,
    subject: prompt.revision.subject,
    sourceContext: prompt.revision.sourceContext,
    prompts: prompt.revision.prompts,
    scopes: prompt.revision.scopes,
    scenario: scenarioInput(prompt),
    promptContentHash: prompt.revision.contentHash,
    scenarioContentHash: prompt.scenario.contentHash,
    createdAt: new Date(prompt.revision.createdAt),
    auditEventId: '00000000-0000-7000-8000-000000001295',
  });
  const approved = await store.approveRevision({
    context,
    promptSetId: prompt.promptSet.id,
    revisionId: prompt.revision.id,
    expectedPromptHash: prompt.revision.contentHash,
    expectedScenarioHash: prompt.scenario.contentHash,
    approvalId: prompt.approval!.id,
    approvedAt: new Date(prompt.approval!.approvedAt),
    auditEventId: '00000000-0000-7000-8000-000000001296',
  });
  expect(approved.outcome).toBe('SUCCEEDED');
  if (approved.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_APPROVED_PROMPT');
  return approved.bundle;
}

async function seedApprovedClaim(store: InMemoryEvidenceClaimStore) {
  const claim = fakeArtifactClaimBundle({
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    actorUserId: context.actorUserId,
  });
  const [evidence] = fakeArtifactClaimEvidence({
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
  });
  if (evidence === undefined) throw new Error('EXPECTED_FAKE_CLAIM_EVIDENCE');
  await store.createSource({
    context,
    sourceId: evidence.source.id,
    sourceType: evidence.source.sourceType,
    title: evidence.source.title,
    uri: evidence.source.uri,
    license: evidence.source.license,
    publicity: evidence.source.publicity,
    createdAt: new Date(evidence.source.createdAt),
    auditEventId: '00000000-0000-7000-8000-000000001290',
  });
  await store.createSnapshot({
    context,
    snapshotId: evidence.snapshot.id,
    sourceId: evidence.source.id,
    contentHash: evidence.snapshot.contentHash,
    objectRef: evidence.snapshot.objectRef,
    contentType: evidence.snapshot.contentType,
    sizeBytes: evidence.snapshot.sizeBytes,
    capturedAt: new Date(evidence.snapshot.capturedAt),
    auditEventId: '00000000-0000-7000-8000-000000001291',
  });
  await store.createClaim({
    context,
    claimId: claim.claim.id,
    revisionId: claim.revision.id,
    evidenceLinkIds: [evidence.link.id],
    statement: claim.revision.statement,
    numericValue: claim.revision.numericValue,
    unit: claim.revision.unit,
    scope: claim.revision.scope,
    conditions: claim.revision.conditions,
    expiresAt: claim.revision.expiresAt === null ? null : new Date(claim.revision.expiresAt),
    evidence: [
      {
        snapshotId: evidence.snapshot.id,
        sourceHash: evidence.link.sourceHash,
        snippet: evidence.link.snippet,
      },
    ],
    contentHash: claim.revision.contentHash,
    createdAt: new Date(claim.revision.createdAt),
    auditEventId: '00000000-0000-7000-8000-000000001292',
  });
  await store.submitClaim({
    context,
    claimId: claim.claim.id,
    revisionId: claim.revision.id,
    submittedAt: new Date(NOW),
    auditEventId: '00000000-0000-7000-8000-000000001289',
  });
  const approved = await store.reviewClaim({
    context,
    claimId: claim.claim.id,
    revisionId: claim.revision.id,
    expectedContentHash: claim.revision.contentHash,
    reviewId: '00000000-0000-7000-8000-000000001288',
    decision: 'APPROVE',
    note: 'Approved real evidence lineage for the effect fence test.',
    reviewedAt: new Date(NOW),
    auditEventId: '00000000-0000-7000-8000-000000001287',
  });
  expect(approved.outcome).toBe('SUCCEEDED');
  if (approved.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_APPROVED_CLAIM');
  return approved.bundle;
}

function scenarioInput(prompt: ReturnType<typeof fakeArtifactPromptBundle>) {
  return {
    providerKey: prompt.scenario.providerKey,
    surfaceKey: prompt.scenario.surfaceKey,
    model: prompt.scenario.model,
    modelVersion: prompt.scenario.modelVersion,
    account: prompt.scenario.account,
    acquisitionMethod: prompt.scenario.acquisitionMethod,
    freshSession: prompt.scenario.freshSession,
    searchEnabled: prompt.scenario.searchEnabled,
    parameters: prompt.scenario.parameters,
    repetitions: prompt.scenario.repetitions,
  };
}

function makeAuthorization(): ChannelAuthorizationEligibility {
  return {
    id: '00000000-0000-7000-8000-000000001234',
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    adapterVersionId: '00000000-0000-7000-8000-000000001228',
    status: 'ACTIVE',
    grantedScopes: ['content:write'],
    acceptedTermsVersion: 'fixture-terms-v1',
    target: TARGET,
    expiresAt: '2036-01-01T00:00:00.000Z',
    validationStatus: 'VERIFIED',
    validationSnapshot: {
      actualTarget: TARGET,
      actualScopes: ['content:write'],
      acceptedTermsVersion: 'fixture-terms-v1',
      validatedAt: NOW.toISOString(),
      validUntil: '2036-01-01T00:00:00.000Z',
    },
    validationFailureCode: null,
    createdByUserId: context.actorUserId,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function makeRegistryEntry(channelPackage: ChannelPackageRecord) {
  return {
    id: channelPackage.channel.definitionId,
    channelKey: channelPackage.channel.channelKey,
    displayName: 'Publication currentness',
    status: 'AVAILABLE' as const,
    unavailableReason: null,
    packageTransformerKey: channelPackage.transformer.key,
    packageSchemaVersion: channelPackage.packageSchemaVersion,
    adapterVersions: [
      {
        id: '00000000-0000-7000-8000-000000001228',
        adapterKey: 'publication-currentness',
        adapterVersion: '1.0.0',
        enabled: true,
        disabledReason: null,
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
        requiredScopes: ['content:write'],
        termsVersion: 'fixture-terms-v1',
        termsStatus: 'ALLOWED' as const,
        processingRegion: 'in-process-test',
        retentionPolicy: 'No retention.',
        trainingPolicy: 'No training.',
        subprocessors: [],
        ratePolicy: { mode: 'test' },
      },
    ],
  };
}

function makeAdapter(channelPackage: ChannelPackageRecord, payload: ChannelPackagePayload) {
  const validateAuthorization = vi
    .fn<PublicationAdapter['validateAuthorization']>()
    .mockResolvedValue({ outcome: 'VALID' });
  const publish = vi.fn<PublicationAdapter['publish']>().mockResolvedValue({
    outcome: 'APPLIED',
    remoteRef: 'fixture://publication-currentness/effect',
  });
  const reconcile = vi.fn<PublicationAdapter['reconcile']>().mockResolvedValue({
    outcome: 'DEFINITELY_NOT_APPLIED',
    errorCode: 'NOT_USED',
  });
  const adapter: PublicationAdapter = {
    adapterKey: 'publication-currentness',
    adapterVersion: '1.0.0',
    describe: () => ({
      adapterKey: 'publication-currentness',
      adapterVersion: '1.0.0',
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
      requiredScopes: ['content:write'],
      termsVersion: 'fixture-terms-v1',
      processingRegion: 'in-process-test',
      retentionPolicy: 'No retention.',
      trainingPolicy: 'No training.',
      subprocessors: [],
      ratePolicy: { mode: 'test' },
    }),
    validateAuthorization,
    preview: () => ({ packageChecksum: channelPackage.packageChecksum, files: payload.files }),
    publish,
    reconcile,
  };
  return { adapter, validateAuthorization, publish, reconcile };
}

function sequentialIds(): () => string {
  let next = 300;
  return () => `00000000-0000-7000-8000-${String(next++).padStart(12, '0')}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
