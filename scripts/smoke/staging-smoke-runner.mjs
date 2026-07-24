import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { URL } from 'node:url';

import { completeSyntheticCognitoLogin } from './cognito-login.mjs';

export async function runStagingSmoke(config, dependencies = {}) {
  const imageDigest = config.imageDigest;
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest)) {
    throw new Error('AEO_IMAGE_DIGEST_INVALID');
  }
  const webImageDigest = config.webImageDigest;
  if (!/^sha256:[a-f0-9]{64}$/u.test(webImageDigest)) {
    throw new Error('AEO_WEB_IMAGE_DIGEST_INVALID');
  }
  const startedAt =
    config.startedAt instanceof Date ? config.startedAt : new Date(config.startedAt);
  if (!Number.isFinite(startedAt.getTime())) throw new Error('SMOKE_STARTED_AT_INVALID');
  validateSyntheticConfig(config);

  const getPublicJson = dependencies.getPublicJson ?? fetchPublicJson;
  const completeLogin = dependencies.completeLogin ?? completeSyntheticCognitoLogin;
  const nextRequestId = dependencies.nextRequestId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const sleep = dependencies.sleep ?? wait;
  const health = await getPublicJson(config.stagingOrigin, '/health');
  assertEqual(health.body?.data?.status, 'alive', 'HEALTH_NOT_ALIVE');
  const readiness = await getPublicJson(config.stagingOrigin, '/ready');
  assertEqual(readiness.body?.data?.status, 'ready', 'DEPENDENCY_NOT_READY');

  const sessions = [];
  try {
    const operator = await completeLogin(loginInput(config));
    sessions.push(operator);
    const reviewer = await completeLogin(reviewerLoginInput(config));
    sessions.push(reviewer);
    const steps = [];
    const request = async (actor, session, method, path, body) => {
      const requestId = nextRequestId();
      assertRequestId(requestId, 'SMOKE_REQUEST_ID_INVALID');
      return session.requestJson(path, {
        method,
        requestId,
        ...(body === undefined ? {} : { body }),
      });
    };
    const record = (name, actor, response, state) => {
      steps.push({
        name,
        actor,
        status: response.status,
        durationMs: response.durationMs,
        ...(state === undefined ? {} : { state }),
      });
    };

    const operatorSession = await request('operator', operator, 'GET', '/api/v1/auth/session');
    assertIdentity(operatorSession, config.username, 'SYNTHETIC_LOGIN_IDENTITY_MISMATCH');
    const reviewerSession = await request('reviewer', reviewer, 'GET', '/api/v1/auth/session');
    assertIdentity(
      reviewerSession,
      config.reviewerUsername,
      'SYNTHETIC_REVIEWER_IDENTITY_MISMATCH',
    );

    const traceProbeRequestId = nextRequestId();
    assertRequestId(traceProbeRequestId, 'SMOKE_TRACE_PROBE_REQUEST_ID_INVALID');
    const runtime = await operator.requestJson('/api/v1/runtime/build-identity', {
      method: 'GET',
      requestId: traceProbeRequestId,
    });
    const runtimeBuildIdentity = validateRuntimeBuildIdentity(
      runtime.body?.data?.identity,
      imageDigest,
      'api',
    );
    const webRuntime = await request('operator', operator, 'GET', '/runtime/build-identity');
    const webRuntimeBuildIdentity = validateRuntimeBuildIdentity(
      webRuntime.body?.data?.identity,
      webImageDigest,
      'web',
    );

    const runId = nextRequestId();
    assertRequestId(runId, 'SMOKE_RUN_ID_INVALID');
    const scopePath =
      `/api/v1/tenants/${encodeURIComponent(config.tenantId)}` +
      `/workspaces/${encodeURIComponent(config.workspaceId)}`;
    const profileResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/profiles/${encodeURIComponent(config.prerequisiteProfileId)}/revisions`,
      {
        displayName: `Synthetic staging profile ${runId.slice(0, 8)}`,
        description:
          'Industry-neutral synthetic staging profile used only for an authenticated smoke run.',
        digitalAssets: [],
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    );
    const profile = profileResponse.body?.data?.profile;
    const profileRevisionId = requiredUuid(profile?.id, 'SMOKE_PROFILE_REVISION_INVALID');
    const profileId = requiredUuid(profile?.profileId, 'SMOKE_PROFILE_ID_INVALID');
    assertEqual(profileId, config.prerequisiteProfileId, 'SMOKE_PROFILE_PREREQUISITE_MISMATCH');
    const profileRevision = requiredPositiveInteger(
      profile?.revision,
      'SMOKE_PROFILE_REVISION_NUMBER_INVALID',
    );
    record('profileRevisionCreated', 'operator', profileResponse, 'CREATED');

    const offeringResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/profiles/${encodeURIComponent(profileId)}/offerings`,
      {
        kind: 'synthetic-smoke-offering',
        name: `Synthetic staging offering ${runId.slice(0, 8)}`,
        locale: 'en-SG',
        market: 'SG',
        taxonomy: ['synthetic-validation'],
        principle: 'A neutral recorded fixture validates the platform workflow.',
        specifications: [{ name: 'fixture_revision', value: runId }],
        features: ['Deterministic workflow validation'],
        usage: ['Run only inside the approved staging Workspace'],
        applicationScenarios: ['Authenticated staging acceptance testing'],
        compatibility: ['AEOStudio synthetic smoke fixture'],
        evidenceHints: ['Recorded synthetic evidence snapshot'],
        attributes: [],
      },
    );
    const offering = offeringResponse.body?.data?.offering;
    const offeringId = requiredUuid(offering?.offeringId, 'SMOKE_OFFERING_ID_INVALID');
    const offeringRevisionId = requiredUuid(offering?.id, 'SMOKE_OFFERING_REVISION_ID_INVALID');
    const offeringRevision = requiredPositiveInteger(
      offering?.revision,
      'SMOKE_OFFERING_REVISION_INVALID',
    );
    record('offeringCreated', 'operator', offeringResponse, 'CREATED');

    const evidenceSourceResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/evidence-sources`,
      {
        sourceType: 'UPLOAD',
        title: `Synthetic smoke evidence ${runId.slice(0, 8)}`,
        uri: null,
        license: 'CC0-1.0',
        publicity: 'PRIVATE',
      },
    );
    const evidenceSourceId = requiredUuid(
      evidenceSourceResponse.body?.data?.source?.id,
      'SMOKE_EVIDENCE_SOURCE_INVALID',
    );
    const evidenceHash = createHash('sha256')
      .update(`aeostudio-staging-smoke:${runId}`)
      .digest('hex');
    const evidenceSnapshotResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/evidence-sources/${encodeURIComponent(evidenceSourceId)}/snapshots`,
      {
        contentHash: evidenceHash,
        objectRef: `synthetic://staging-smoke/${runId}/evidence.txt`,
        contentType: 'text/plain',
        sizeBytes: 128,
      },
    );
    const evidenceSnapshotId = requiredUuid(
      evidenceSnapshotResponse.body?.data?.snapshot?.id,
      'SMOKE_EVIDENCE_SNAPSHOT_INVALID',
    );
    assertEqual(
      evidenceSnapshotResponse.body?.data?.snapshot?.contentHash,
      evidenceHash,
      'SMOKE_EVIDENCE_HASH_MISMATCH',
    );
    record('evidenceSnapshotCreated', 'operator', evidenceSnapshotResponse, 'CREATED');

    const claimResponse = await request('operator', operator, 'POST', `${scopePath}/claims`, {
      statement: 'The staging synthetic workflow completed its recorded fixture validation.',
      numericValue: 1,
      unit: 'recorded-check',
      scope: 'Authenticated staging synthetic smoke run only.',
      conditions: ['No external provider result is represented by this fixture.'],
      expiresAt: new Date(now().getTime() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
      evidence: [
        {
          snapshotId: evidenceSnapshotId,
          sourceHash: evidenceHash,
          snippet: 'Recorded synthetic workflow validation: complete.',
        },
      ],
    });
    const claimId = requiredUuid(claimResponse.body?.data?.claim?.id, 'SMOKE_CLAIM_ID_INVALID');
    const claimRevisionId = requiredUuid(
      claimResponse.body?.data?.revision?.id,
      'SMOKE_CLAIM_REVISION_ID_INVALID',
    );
    const claimContentHash = requiredHash(
      claimResponse.body?.data?.revision?.contentHash,
      'SMOKE_CLAIM_HASH_INVALID',
    );
    assertEqual(claimResponse.body?.data?.revision?.status, 'DRAFT', 'SMOKE_CLAIM_NOT_DRAFT');
    const claimSubmitResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/claims/${encodeURIComponent(claimId)}` +
        `/revisions/${encodeURIComponent(claimRevisionId)}/submit`,
      {},
    );
    assertEqual(
      claimSubmitResponse.body?.data?.revision?.status,
      'IN_REVIEW',
      'SMOKE_CLAIM_NOT_IN_REVIEW',
    );
    const claimReviewResponse = await request(
      'reviewer',
      reviewer,
      'POST',
      `${scopePath}/claims/${encodeURIComponent(claimId)}` +
        `/revisions/${encodeURIComponent(claimRevisionId)}/reviews`,
      {
        decision: 'APPROVE',
        note: 'Synthetic evidence, exact scope, and non-production disclosure verified.',
      },
    );
    assertEqual(
      claimReviewResponse.body?.data?.revision?.status,
      'APPROVED',
      'SMOKE_CLAIM_NOT_APPROVED',
    );
    assertEqual(
      claimReviewResponse.body?.data?.revision?.contentHash,
      claimContentHash,
      'SMOKE_CLAIM_APPROVAL_HASH_MISMATCH',
    );
    const claimReviewId = requiredUuid(
      claimReviewResponse.body?.data?.review?.id,
      'SMOKE_CLAIM_REVIEW_INVALID',
    );
    record('claimApproved', 'reviewer', claimReviewResponse, 'APPROVED');

    const promptResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/prompt-sets/proposals`,
      {
        title: `Synthetic staging questions ${runId.slice(0, 8)}`,
        subject: 'Industry-neutral synthetic staging offering',
        sourceContext: {
          profile: { id: profileId, revision: profileRevision },
          offering: { id: offeringId, revision: offeringRevision },
          claimRevisionIds: [claimRevisionId],
        },
        scopes: [{ market: 'SG', locale: 'en-SG', region: 'Singapore' }],
        scenario: {
          providerKey: config.manualMeasurementProviderKey,
          surfaceKey: config.manualMeasurementSurfaceKey,
          model: 'staging-synthetic-recorded-answer',
          modelVersion: 'smoke-v1',
          account: 'staging-synthetic-fixture',
          acquisitionMethod: 'MANUAL_IMPORT',
          freshSession: true,
          searchEnabled: false,
          parameters: { synthetic: true, externalNetwork: false },
          repetitions: 3,
        },
      },
    );
    const promptSetId = requiredUuid(
      promptResponse.body?.data?.promptSet?.id,
      'SMOKE_PROMPT_SET_INVALID',
    );
    const promptRevisionId = requiredUuid(
      promptResponse.body?.data?.revision?.id,
      'SMOKE_PROMPT_REVISION_INVALID',
    );
    const promptHash = requiredHash(
      promptResponse.body?.data?.revision?.contentHash,
      'SMOKE_PROMPT_HASH_INVALID',
    );
    const scenarioId = requiredUuid(
      promptResponse.body?.data?.scenario?.id,
      'SMOKE_SCENARIO_INVALID',
    );
    const scenarioHash = requiredHash(
      promptResponse.body?.data?.scenario?.contentHash,
      'SMOKE_SCENARIO_HASH_INVALID',
    );
    const scenarioRepetitions = requiredPositiveInteger(
      promptResponse.body?.data?.scenario?.repetitions,
      'SMOKE_SCENARIO_REPETITIONS_INVALID',
    );
    const prompts = promptResponse.body?.data?.revision?.prompts;
    const scopes = promptResponse.body?.data?.revision?.scopes;
    if (!Array.isArray(prompts) || prompts.length < 20) {
      throw new Error('SMOKE_PROMPT_COUNT_INVALID');
    }
    if (!Array.isArray(scopes) || scopes.length < 1) {
      throw new Error('SMOKE_PROMPT_SCOPE_INVALID');
    }
    const expectedMeasurementSlotCount = prompts.length * scopes.length * scenarioRepetitions;
    if (!Number.isSafeInteger(expectedMeasurementSlotCount) || expectedMeasurementSlotCount < 60) {
      throw new Error('SMOKE_MEASUREMENT_EXPECTED_SLOT_COUNT_TOO_SMALL');
    }
    const firstPromptId = requiredUuid(prompts[0]?.id, 'SMOKE_PROMPT_ID_INVALID');
    const firstScope = scopes[0];
    const promptApprovalResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/prompt-sets/${encodeURIComponent(promptSetId)}` +
        `/revisions/${encodeURIComponent(promptRevisionId)}/approve`,
      {
        expectedPromptHash: promptHash,
        expectedScenarioHash: scenarioHash,
      },
    );
    assertEqual(
      promptApprovalResponse.body?.data?.revision?.status,
      'APPROVED',
      'SMOKE_PROMPT_NOT_APPROVED',
    );
    assertEqual(
      promptApprovalResponse.body?.data?.approvalCurrent,
      true,
      'SMOKE_PROMPT_APPROVAL_NOT_CURRENT',
    );
    const promptApprovalId = requiredUuid(
      promptApprovalResponse.body?.data?.approval?.id,
      'SMOKE_PROMPT_APPROVAL_INVALID',
    );
    record('promptSetApproved', 'operator', promptApprovalResponse, 'APPROVED');

    const contentPlanResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/content-plans`,
      {
        profile: { id: profileId, revision: profileRevision },
        offering: { id: offeringId, revision: offeringRevision },
        promptSetId,
        promptRevisionId,
        primaryClaimRevisionIds: [claimRevisionId],
        comparisonClaimRevisionIds: [],
        baselineId: config.prerequisiteBaselineId,
        methodPolicyVersion: 'content-plan-v1',
        idempotencyKey: nextIdempotencyKey(nextRequestId),
        estimatedUnits: 20,
      },
    );
    const contentPlanId = requiredUuid(
      contentPlanResponse.body?.data?.plan?.id,
      'SMOKE_CONTENT_PLAN_INVALID',
    );
    const contentPlanJobId = requiredUuid(
      contentPlanResponse.body?.data?.job?.id,
      'SMOKE_CONTENT_PLAN_JOB_INVALID',
    );
    const contentPlanAcceptedAt = monotonicNow();
    const contentPlanJob = await pollJob({
      actor: 'operator',
      session: operator,
      scopePath,
      jobId: contentPlanJobId,
      request,
      sleep,
      monotonicNow,
      maxWaitMs: 15 * 60 * 1_000,
    });
    const contentPlanRead = await request(
      'operator',
      operator,
      'GET',
      `${scopePath}/content-plans/${encodeURIComponent(contentPlanId)}`,
    );
    assertEqual(contentPlanRead.body?.data?.plan?.status, 'READY', 'SMOKE_CONTENT_PLAN_NOT_READY');
    const contentPlanAcceptedToReadyMs = elapsedMs(
      contentPlanAcceptedAt,
      monotonicNow(),
      'SMOKE_CONTENT_PLAN_TIMING_INVALID',
    );
    assertWithinBudget(
      contentPlanAcceptedToReadyMs,
      15 * 60 * 1_000,
      'SMOKE_CONTENT_PLAN_SLO_EXCEEDED',
    );
    const briefs = contentPlanRead.body?.data?.briefs;
    if (!Array.isArray(briefs) || briefs.length < 1) throw new Error('SMOKE_BRIEF_MISSING');
    const briefId = requiredUuid(briefs[0]?.id, 'SMOKE_BRIEF_ID_INVALID');
    const briefHash = requiredHash(briefs[0]?.contentHash, 'SMOKE_BRIEF_HASH_INVALID');
    const briefReviewResponse = await request(
      'reviewer',
      reviewer,
      'POST',
      `${scopePath}/content-plans/${encodeURIComponent(contentPlanId)}` +
        `/briefs/${encodeURIComponent(briefId)}/review`,
      {
        decision: 'APPROVE',
        expectedContentHash: briefHash,
        note: 'Synthetic Brief lineage and evidence bindings verified.',
      },
    );
    assertEqual(
      briefReviewResponse.body?.data?.brief?.status,
      'APPROVED',
      'SMOKE_BRIEF_NOT_APPROVED',
    );
    const briefReviewId = requiredUuid(
      briefReviewResponse.body?.data?.review?.id,
      'SMOKE_BRIEF_REVIEW_INVALID',
    );
    record('contentPlanReady', 'operator', contentPlanRead, 'READY');

    const artifactStartResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/artifacts`,
      {
        briefId,
        locale: 'en-SG',
        market: 'SG',
        methodPolicyVersion: 'artifact-fixture-v1',
        idempotencyKey: nextIdempotencyKey(nextRequestId),
        estimatedUnits: 30,
      },
    );
    const artifactId = requiredUuid(
      artifactStartResponse.body?.data?.artifact?.id,
      'SMOKE_ARTIFACT_INVALID',
    );
    const artifactJobId = requiredUuid(
      artifactStartResponse.body?.data?.job?.id,
      'SMOKE_ARTIFACT_JOB_INVALID',
    );
    await pollJob({
      actor: 'operator',
      session: operator,
      scopePath,
      jobId: artifactJobId,
      request,
      sleep,
      monotonicNow,
      maxWaitMs: 15 * 60 * 1_000,
    });
    const artifactRead = await request(
      'operator',
      operator,
      'GET',
      `${scopePath}/artifacts/${encodeURIComponent(artifactId)}`,
    );
    const artifactRevisionId = requiredUuid(
      artifactRead.body?.data?.revision?.id,
      'SMOKE_ARTIFACT_REVISION_INVALID',
    );
    const artifactRevision = requiredPositiveInteger(
      artifactRead.body?.data?.revision?.revision,
      'SMOKE_ARTIFACT_REVISION_NUMBER_INVALID',
    );
    const artifactHash = requiredHash(
      artifactRead.body?.data?.revision?.contentHash,
      'SMOKE_ARTIFACT_HASH_INVALID',
    );
    assertEqual(artifactRead.body?.data?.revision?.status, 'DRAFT', 'SMOKE_ARTIFACT_NOT_DRAFT');
    const artifactSubmitResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/artifacts/${encodeURIComponent(artifactId)}` +
        `/revisions/${String(artifactRevision)}/submit`,
      { expectedContentHash: artifactHash },
    );
    assertEqual(
      artifactSubmitResponse.body?.data?.revision?.status,
      'IN_REVIEW',
      'SMOKE_ARTIFACT_NOT_IN_REVIEW',
    );

    const policyState = await request(
      'operator',
      operator,
      'GET',
      `${scopePath}/measurement-provider-policies/` +
        `${encodeURIComponent(config.manualMeasurementProviderKey)}/` +
        `${encodeURIComponent(config.manualMeasurementSurfaceKey)}`,
    );
    assertEqual(
      policyState.body?.data?.state?.eligible,
      true,
      'SMOKE_MANUAL_MEASUREMENT_POLICY_NOT_APPROVED',
    );
    assertEqual(
      policyState.body?.data?.state?.requiredAdapterVersion,
      config.manualMeasurementAdapterVersion,
      'SMOKE_MANUAL_MEASUREMENT_ADAPTER_MISMATCH',
    );
    assertEqual(
      policyState.body?.data?.state?.requiredTermsVersion,
      config.manualMeasurementTermsVersion,
      'SMOKE_MANUAL_MEASUREMENT_TERMS_MISMATCH',
    );
    record('manualMeasurementPolicyChecked', 'operator', policyState, 'PREREQUISITE');

    const baselineObservedAt = new Date(now().getTime() - 5 * 60 * 1_000).toISOString();
    const baseline = await createReviewedMeasurement({
      actorSession: operator,
      reviewerSession: reviewer,
      kind: 'BASELINE',
      observedAt: baselineObservedAt,
      scopePath,
      promptSetId,
      promptRevisionId,
      promptHash,
      scenarioId,
      scenarioHash,
      expectedSlotCount: expectedMeasurementSlotCount,
      expectedCohortCount: scopes.length,
      promptId: firstPromptId,
      scope: firstScope,
      request,
      sleep,
      nextRequestId,
      monotonicNow,
    });
    assertWithinBudget(
      baseline.acceptedToCompletedMs,
      2 * 60 * 60 * 1_000,
      'SMOKE_BASELINE_MEASUREMENT_SLO_EXCEEDED',
    );
    record('baselineMetricSnapshotCreated', 'operator', baseline.dashboardResponse, 'COMPLETED');

    const artifactReviewResponse = await request(
      'reviewer',
      reviewer,
      'POST',
      `${scopePath}/artifacts/${encodeURIComponent(artifactId)}` +
        `/revisions/${String(artifactRevision)}/review`,
      {
        decision: 'APPROVE',
        expectedContentHash: artifactHash,
        note: 'Synthetic Artifact lineage, Claim evidence, and payload integrity verified.',
      },
    );
    assertEqual(
      artifactReviewResponse.body?.data?.revision?.status,
      'APPROVED',
      'SMOKE_ARTIFACT_NOT_APPROVED',
    );
    const artifactReviewId = requiredUuid(
      artifactReviewResponse.body?.data?.review?.id,
      'SMOKE_ARTIFACT_REVIEW_INVALID',
    );
    const interventionAt = requiredTimestamp(
      artifactReviewResponse.body?.data?.review?.createdAt,
      'SMOKE_ARTIFACT_REVIEW_TIME_INVALID',
    );
    record('artifactApproved', 'reviewer', artifactReviewResponse, 'APPROVED');

    const channelPackageResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/channel-packages`,
      {
        artifactId,
        artifactRevisionId,
        revision: artifactRevision,
        expectedContentHash: artifactHash,
        channelKey: config.syntheticChannelKey,
      },
    );
    const channelPackageId = requiredUuid(
      channelPackageResponse.body?.data?.package?.id,
      'SMOKE_CHANNEL_PACKAGE_INVALID',
    );
    const packageChecksum = requiredHash(
      channelPackageResponse.body?.data?.package?.packageChecksum,
      'SMOKE_CHANNEL_PACKAGE_HASH_INVALID',
    );
    const eligibilityResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/publications/eligibility`,
      {
        channelPackageId,
        adapterVersionId: config.syntheticAdapterVersionId,
        target: config.syntheticPublicationTarget,
        expectedPackageChecksum: packageChecksum,
      },
    );
    assertEqual(
      eligibilityResponse.body?.data?.eligibility?.mode,
      'PUBLISH_READY',
      'SMOKE_PUBLICATION_NOT_ELIGIBLE',
    );
    assertEqual(
      eligibilityResponse.body?.data?.eligibility?.adapterVersionId,
      config.syntheticAdapterVersionId,
      'SMOKE_PUBLICATION_ADAPTER_MISMATCH',
    );
    const channelAuthorizationId = requiredUuid(
      eligibilityResponse.body?.data?.eligibility?.channelAuthorizationId,
      'SMOKE_CHANNEL_AUTHORIZATION_INVALID',
    );
    const publicationResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/publications`,
      {
        channelPackageId,
        adapterVersionId: config.syntheticAdapterVersionId,
        target: config.syntheticPublicationTarget,
        expectedPackageChecksum: packageChecksum,
        idempotencyKey: nextIdempotencyKey(nextRequestId),
      },
    );
    const publicationId = requiredUuid(
      publicationResponse.body?.data?.publication?.id,
      'SMOKE_PUBLICATION_INVALID',
    );
    const publicationJobId = requiredUuid(
      publicationResponse.body?.data?.job?.id,
      'SMOKE_PUBLICATION_JOB_INVALID',
    );
    await pollJob({
      actor: 'operator',
      session: operator,
      scopePath,
      jobId: publicationJobId,
      request,
      sleep,
      monotonicNow,
      maxWaitMs: 15 * 60 * 1_000,
    });
    const publicationRead = await request(
      'operator',
      operator,
      'GET',
      `${scopePath}/publications/${encodeURIComponent(publicationId)}`,
    );
    assertEqual(
      publicationRead.body?.data?.publication?.status,
      'REMOTE_APPLIED',
      'SMOKE_SYNTHETIC_PUBLICATION_NOT_APPLIED',
    );
    assertEqual(
      publicationRead.body?.data?.publication?.remoteState?.isProductionLive,
      false,
      'SMOKE_SYNTHETIC_PUBLICATION_MUST_NOT_BE_LIVE',
    );
    const publicationAttempts = publicationRead.body?.data?.attempts;
    if (!Array.isArray(publicationAttempts) || publicationAttempts.length < 1) {
      throw new Error('SMOKE_PUBLICATION_ATTEMPT_MISSING');
    }
    const publicationAttemptId = requiredUuid(
      publicationAttempts[0]?.id,
      'SMOKE_PUBLICATION_ATTEMPT_INVALID',
    );
    record('syntheticPublicationApplied', 'operator', publicationRead, 'REMOTE_APPLIED');

    const remeasurementObservedAt = new Date(
      Math.max(now().getTime(), new Date(interventionAt).getTime() + 1),
    ).toISOString();
    const remeasurement = await createReviewedMeasurement({
      actorSession: operator,
      reviewerSession: reviewer,
      kind: 'REMEASUREMENT',
      observedAt: remeasurementObservedAt,
      scopePath,
      promptSetId,
      promptRevisionId,
      promptHash,
      scenarioId,
      scenarioHash,
      expectedSlotCount: expectedMeasurementSlotCount,
      expectedCohortCount: scopes.length,
      promptId: firstPromptId,
      scope: firstScope,
      request,
      sleep,
      nextRequestId,
      monotonicNow,
    });
    record(
      'remeasurementMetricSnapshotCreated',
      'operator',
      remeasurement.dashboardResponse,
      'COMPLETED',
    );

    const experimentResponse = await request(
      'operator',
      operator,
      'POST',
      `${scopePath}/experiments`,
      {
        baselineRunId: baseline.runId,
        remeasurementRunId: remeasurement.runId,
        intervention: {
          kind: 'APPROVED_ARTIFACT',
          artifactId,
          artifactReviewId,
          artifactRevisionId,
          artifactContentHash: artifactHash,
          observedAt: interventionAt,
        },
        idempotencyKey: nextIdempotencyKey(nextRequestId),
      },
    );
    const createdExperiment = experimentResponse.body?.data?.experiment;
    const experimentId = requiredUuid(createdExperiment?.id, 'SMOKE_EXPERIMENT_ID_INVALID');
    const experimentRead = await request(
      'operator',
      operator,
      'GET',
      `${scopePath}/experiments/${encodeURIComponent(experimentId)}`,
    );
    const readExperiment = experimentRead.body?.data?.experiment;
    assertSealedExperiment(createdExperiment, readExperiment, {
      baselineRunId: baseline.runId,
      remeasurementRunId: remeasurement.runId,
      artifactReviewId,
    });
    record('experimentCreatedAndReread', 'operator', experimentRead, 'SEALED');
    const completedAt = now();

    return {
      schemaVersion: 'aeostudio-staging-smoke.v1',
      environment: 'staging',
      region: 'ap-southeast-1',
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      endpoint: { origin: new URL(config.stagingOrigin).origin },
      imageDigest: runtimeBuildIdentity.imageDigest,
      runtimeBuildIdentity,
      webRuntimeBuildIdentity,
      traceProbe: {
        operation: 'runtimeBuildIdentity',
        requestId: traceProbeRequestId.toLowerCase(),
      },
      checks: {
        health: { status: health.status, durationMs: health.durationMs },
        readiness: { status: readiness.status, durationMs: readiness.durationMs },
        syntheticLogin: {
          operator: {
            status: operatorSession.status,
            durationMs: operatorSession.durationMs,
            ...operator.flow,
          },
          reviewer: {
            status: reviewerSession.status,
            durationMs: reviewerSession.durationMs,
            ...reviewer.flow,
          },
        },
        runtimeBuildIdentity: {
          status: runtime.status,
          durationMs: runtime.durationMs,
        },
        webRuntimeBuildIdentity: {
          status: webRuntime.status,
          durationMs: webRuntime.durationMs,
        },
        syntheticHappyPath: {
          status: experimentRead.status,
          durationMs: steps.reduce((total, step) => total + step.durationMs, 0),
        },
      },
      syntheticFlow: {
        runId,
        prerequisites: {
          profileId: config.prerequisiteProfileId,
          siteBaselineId: config.prerequisiteBaselineId,
          syntheticAdapterVersionId: config.syntheticAdapterVersionId,
          syntheticChannelKey: config.syntheticChannelKey,
          channelAuthorizationId,
          manualMeasurement: {
            providerKey: config.manualMeasurementProviderKey,
            surfaceKey: config.manualMeasurementSurfaceKey,
            adapterVersion: config.manualMeasurementAdapterVersion,
            termsVersion: config.manualMeasurementTermsVersion,
            providerPolicy: 'PRE_PROVISIONED_APPROVED',
          },
        },
        created: {
          profileRevision: {
            id: profileRevisionId,
            profileId,
            revision: profileRevision,
          },
          offering: {
            id: offeringId,
            revisionId: offeringRevisionId,
            revision: offeringRevision,
          },
          evidence: {
            sourceId: evidenceSourceId,
            snapshotId: evidenceSnapshotId,
            contentHash: evidenceHash,
          },
          claim: {
            id: claimId,
            revisionId: claimRevisionId,
            reviewId: claimReviewId,
            status: 'APPROVED',
          },
          promptSet: {
            id: promptSetId,
            revisionId: promptRevisionId,
            scenarioId,
            approvalId: promptApprovalId,
            status: 'APPROVED',
          },
          contentPlan: {
            id: contentPlanId,
            jobId: contentPlanJobId,
            jobPollAttempts: contentPlanJob.attempts,
            status: 'READY',
            briefId,
            briefReviewId,
          },
          artifact: {
            id: artifactId,
            revisionId: artifactRevisionId,
            reviewId: artifactReviewId,
            status: 'APPROVED',
          },
          baseline: summarizeMeasurement(baseline),
          channelPackage: {
            id: channelPackageId,
            checksum: packageChecksum,
          },
          publication: {
            deliverySemantics: 'NON_LIVE_CONTROLLED_SYNTHETIC_RECEIVER',
            id: publicationId,
            jobId: publicationJobId,
            attemptId: publicationAttemptId,
            status: 'REMOTE_APPLIED',
            isProductionLive: false,
          },
          remeasurement: summarizeMeasurement(remeasurement),
          experiment: {
            id: experimentId,
            interventionKind: 'APPROVED_ARTIFACT',
            publishedArtifactClaimed: false,
            sealState: 'SEALED',
            baselineRunId: baseline.runId,
            remeasurementRunId: remeasurement.runId,
          },
        },
        timingGates: {
          contentPlan: {
            scope: 'PLATFORM_EXECUTION',
            acceptedToReadyMs: contentPlanAcceptedToReadyMs,
            limitMs: 15 * 60 * 1_000,
            manualOrExternalWaitMs: 0,
            outcome: 'PASS',
          },
          baselineMeasurement: {
            scope: 'PLATFORM_EXECUTION',
            acceptedToCompletedMs: baseline.acceptedToCompletedMs,
            limitMs: 2 * 60 * 60 * 1_000,
            manualEvidenceReviewWaitMs: baseline.manualEvidenceReviewWaitMs,
            manualEvidenceReviewExcludedFromLimit: true,
            outcome: 'PASS',
          },
          remeasurement: {
            scope: 'PLATFORM_EXECUTION',
            acceptedToCompletedMs: remeasurement.acceptedToCompletedMs,
            manualEvidenceReviewWaitMs: remeasurement.manualEvidenceReviewWaitMs,
            manualEvidenceReviewExcludedFromLimit: true,
          },
        },
        steps,
      },
    };
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
  }
}

function validateSyntheticConfig(config) {
  for (const [name, value] of [
    ['AEO_SMOKE_TENANT_ID', config.tenantId],
    ['AEO_SMOKE_WORKSPACE_ID', config.workspaceId],
    ['AEO_SMOKE_PREREQUISITE_PROFILE_ID', config.prerequisiteProfileId],
    ['AEO_SMOKE_PREREQUISITE_BASELINE_ID', config.prerequisiteBaselineId],
    ['AEO_SMOKE_SYNTHETIC_ADAPTER_VERSION_ID', config.syntheticAdapterVersionId],
  ]) {
    requiredUuid(value, `${name}_INVALID`);
  }
  for (const [name, value] of [
    ['AEO_SMOKE_REVIEWER_COGNITO_USERNAME', config.reviewerUsername],
    ['AEO_SMOKE_REVIEWER_COGNITO_PASSWORD', config.reviewerPassword],
    ['AEO_SMOKE_REVIEWER_COGNITO_TOTP_SECRET', config.reviewerTotpSecret],
    ['AEO_SMOKE_SYNTHETIC_CHANNEL_KEY', config.syntheticChannelKey],
    ['AEO_SMOKE_SYNTHETIC_PUBLICATION_TARGET', config.syntheticPublicationTarget],
    ['AEO_SMOKE_MANUAL_PROVIDER_KEY', config.manualMeasurementProviderKey],
    ['AEO_SMOKE_MANUAL_SURFACE_KEY', config.manualMeasurementSurfaceKey],
    ['AEO_SMOKE_MANUAL_ADAPTER_VERSION', config.manualMeasurementAdapterVersion],
    ['AEO_SMOKE_MANUAL_TERMS_VERSION', config.manualMeasurementTermsVersion],
  ]) {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
      throw new Error(`${name}_INVALID`);
    }
  }
  if (
    config.username.toLocaleLowerCase('en-US') ===
    config.reviewerUsername.toLocaleLowerCase('en-US')
  ) {
    throw new Error('SMOKE_REVIEWER_MUST_BE_DISTINCT');
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,159}$/u.test(config.syntheticChannelKey)) {
    throw new Error('AEO_SMOKE_SYNTHETIC_CHANNEL_KEY_INVALID');
  }
  if (
    config.syntheticPublicationTarget.length > 2_048 ||
    hasControlCharacter(config.syntheticPublicationTarget)
  ) {
    throw new Error('AEO_SMOKE_SYNTHETIC_PUBLICATION_TARGET_INVALID');
  }
}

function loginInput(config) {
  return {
    stagingOrigin: config.stagingOrigin,
    cognitoOrigin: config.cognitoOrigin,
    username: config.username,
    password: config.password,
    totpSecret: config.totpSecret,
  };
}

function reviewerLoginInput(config) {
  return {
    stagingOrigin: config.stagingOrigin,
    cognitoOrigin: config.cognitoOrigin,
    username: config.reviewerUsername,
    password: config.reviewerPassword,
    totpSecret: config.reviewerTotpSecret,
  };
}

function assertIdentity(response, expectedEmail, code) {
  const authenticatedEmail = response.body?.data?.email;
  if (
    typeof authenticatedEmail !== 'string' ||
    authenticatedEmail.toLocaleLowerCase('en-US') !== expectedEmail.toLocaleLowerCase('en-US')
  ) {
    throw new Error(code);
  }
}

function assertRequestId(value, code) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error(code);
  }
}

function nextIdempotencyKey(nextRequestId) {
  const value = nextRequestId();
  assertRequestId(value, 'SMOKE_IDEMPOTENCY_KEY_INVALID');
  return value;
}

function requiredUuid(value, code) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function requiredHash(value, code) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

function requiredPositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function requiredNonnegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function requiredTimestamp(value, code) {
  if (!exactTimestamp(value)) throw new Error(code);
  return value;
}

async function pollJob({
  actor,
  session,
  scopePath,
  jobId,
  request,
  sleep,
  monotonicNow,
  maxWaitMs,
}) {
  const pollIntervalMs = 2_000;
  const startedAt = monotonicNow();
  const maxAttempts = Math.ceil(maxWaitMs / pollIntervalMs) + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await request(
      actor,
      session,
      'GET',
      `${scopePath}/jobs/${encodeURIComponent(jobId)}`,
    );
    const status = response.body?.data?.job?.status;
    if (status === 'SUCCEEDED') return { attempts: attempt, response };
    if (['BUDGET_BLOCKED', 'FAILED_TERMINAL', 'CANCELLED'].includes(status)) {
      throw new Error(`SMOKE_JOB_FAILED:${String(status)}`);
    }
    const waitedMs = elapsedMs(startedAt, monotonicNow(), 'SMOKE_JOB_TIMING_INVALID');
    if (waitedMs > maxWaitMs || attempt === maxAttempts) {
      throw new Error('SMOKE_JOB_TIMEOUT');
    }
    await sleep(pollIntervalMs);
  }
  throw new Error('SMOKE_JOB_TIMEOUT');
}

async function createReviewedMeasurement(input) {
  const manualImportResponse = await input.request(
    'operator',
    input.actorSession,
    'POST',
    `${input.scopePath}/measurement-manual-imports`,
    {
      schemaVersion: 'measurement-manual-import.v1',
      promptSetId: input.promptSetId,
      promptRevisionId: input.promptRevisionId,
      scenarioId: input.scenarioId,
      expectedPromptHash: input.promptHash,
      expectedScenarioHash: input.scenarioHash,
      idempotencyKey: nextIdempotencyKey(input.nextRequestId),
      entries: [
        {
          promptId: input.promptId,
          scope: input.scope,
          repetition: 1,
          observedAt: input.observedAt,
          result: {
            status: 'PASS',
            observation: {
              mention: true,
              citation: true,
              accuracy: 'MATCH',
              coverage: true,
            },
            cost: { amount: '0.000000', currency: 'USD' },
            rawEvidence: {
              responseText: `${input.kind} synthetic recorded answer; no live provider request was made.`,
              citations: [
                {
                  url: 'https://synthetic.invalid/recorded-evidence',
                  title: 'Synthetic recorded evidence',
                  snippet: 'Controlled staging evidence for a non-production smoke run.',
                },
              ],
              error: null,
            },
          },
        },
      ],
    },
  );
  const manualImportSubmittedAt = input.monotonicNow();
  const manualImportId = requiredUuid(
    manualImportResponse.body?.data?.manualImport?.id,
    'SMOKE_MANUAL_IMPORT_INVALID',
  );
  const manualImportHash = requiredHash(
    manualImportResponse.body?.data?.manualImport?.contentHash,
    'SMOKE_MANUAL_IMPORT_HASH_INVALID',
  );
  const expectedSlotCount = requiredPositiveInteger(
    manualImportResponse.body?.data?.manualImport?.expectedSlotCount,
    'SMOKE_MANUAL_IMPORT_EXPECTED_SLOT_COUNT_INVALID',
  );
  const providedSlotCount = requiredNonnegativeInteger(
    manualImportResponse.body?.data?.manualImport?.providedSlotCount,
    'SMOKE_MANUAL_IMPORT_PROVIDED_SLOT_COUNT_INVALID',
  );
  assertEqual(
    expectedSlotCount,
    input.expectedSlotCount,
    'SMOKE_MANUAL_IMPORT_EXPECTED_SLOT_COUNT_MISMATCH',
  );
  assertEqual(providedSlotCount, 1, 'SMOKE_MANUAL_IMPORT_PROVIDED_SLOT_COUNT_MISMATCH');
  assertEqual(
    manualImportResponse.body?.data?.manualImport?.status,
    'SUBMITTED',
    'SMOKE_MANUAL_IMPORT_NOT_SUBMITTED',
  );
  const reviewResponse = await input.request(
    'reviewer',
    input.reviewerSession,
    'POST',
    `${input.scopePath}/measurement-manual-imports/${encodeURIComponent(manualImportId)}/review`,
    {
      expectedContentHash: manualImportHash,
      decision: 'APPROVE',
      note: 'Controlled synthetic capture and non-production disclosure verified.',
    },
  );
  const manualEvidenceReviewWaitMs = elapsedMs(
    manualImportSubmittedAt,
    input.monotonicNow(),
    'SMOKE_MANUAL_REVIEW_TIMING_INVALID',
  );
  assertEqual(
    reviewResponse.body?.data?.manualImport?.status,
    'APPROVED',
    'SMOKE_MANUAL_IMPORT_NOT_APPROVED',
  );
  const runResponse = await input.request(
    'operator',
    input.actorSession,
    'POST',
    `${input.scopePath}/measurement-runs`,
    {
      promptSetId: input.promptSetId,
      promptRevisionId: input.promptRevisionId,
      scenarioId: input.scenarioId,
      expectedPromptHash: input.promptHash,
      expectedScenarioHash: input.scenarioHash,
      manualImportId,
      expectedManualImportHash: manualImportHash,
      kind: input.kind,
      idempotencyKey: nextIdempotencyKey(input.nextRequestId),
    },
  );
  const acceptedAt = input.monotonicNow();
  const runId = requiredUuid(
    runResponse.body?.data?.measurementRun?.id,
    'SMOKE_MEASUREMENT_RUN_INVALID',
  );
  const jobId = requiredUuid(runResponse.body?.data?.job?.id, 'SMOKE_MEASUREMENT_JOB_INVALID');
  const job = await pollJob({
    actor: 'operator',
    session: input.actorSession,
    scopePath: input.scopePath,
    jobId,
    request: input.request,
    sleep: input.sleep,
    monotonicNow: input.monotonicNow,
    maxWaitMs: 2 * 60 * 60 * 1_000,
  });
  const runRead = await input.request(
    'operator',
    input.actorSession,
    'GET',
    `${input.scopePath}/measurement-runs/${encodeURIComponent(runId)}`,
  );
  assertEqual(
    runRead.body?.data?.measurementRun?.kind,
    input.kind,
    'SMOKE_MEASUREMENT_KIND_MISMATCH',
  );
  assertEqual(
    runRead.body?.data?.measurementRun?.status,
    'COMPLETED',
    'SMOKE_MEASUREMENT_NOT_COMPLETED',
  );
  assertEqual(
    runRead.body?.data?.measurementRun?.expectedPromptRunCount,
    input.expectedSlotCount,
    'SMOKE_MEASUREMENT_EXPECTED_RUN_COUNT_MISMATCH',
  );
  assertEqual(
    runRead.body?.data?.measurementRun?.completedPromptRunCount,
    input.expectedSlotCount,
    'SMOKE_MEASUREMENT_COMPLETED_RUN_COUNT_MISMATCH',
  );
  const completedAt = input.monotonicNow();
  const acceptedToCompletedMs = elapsedMs(
    acceptedAt,
    completedAt,
    'SMOKE_MEASUREMENT_TIMING_INVALID',
  );
  const dashboardResponse = await input.request(
    'operator',
    input.actorSession,
    'GET',
    `${input.scopePath}/measurement-runs/${encodeURIComponent(runId)}/dashboard`,
  );
  assertEqual(
    dashboardResponse.body?.data?.snapshot?.measurementRunId,
    runId,
    'SMOKE_METRIC_SNAPSHOT_RUN_MISMATCH',
  );
  const coverage = validateSyntheticMeasurementDashboard({
    data: dashboardResponse.body?.data,
    expectedCohortCount: input.expectedCohortCount,
    expectedSlotCount,
    providedSlotCount,
  });
  return {
    runId,
    jobId,
    jobPollAttempts: job.attempts,
    status: 'COMPLETED',
    manualImportId,
    metricIds: coverage.metricIds,
    coverage: coverage.evidence,
    acceptedToCompletedMs,
    manualEvidenceReviewWaitMs,
    dashboardResponse,
  };
}

function summarizeMeasurement(measurement) {
  return {
    runId: measurement.runId,
    jobId: measurement.jobId,
    jobPollAttempts: measurement.jobPollAttempts,
    manualImportId: measurement.manualImportId,
    metricIds: measurement.metricIds,
    coverage: measurement.coverage,
    status: measurement.status,
  };
}

function validateSyntheticMeasurementDashboard(input) {
  const missingSlotCount = input.expectedSlotCount - input.providedSlotCount;
  if (missingSlotCount < 0) throw new Error('SMOKE_MANUAL_IMPORT_SLOT_COUNTS_INVALID');
  const expectedResultCounts = {
    PASS: input.providedSlotCount,
    FAIL: 0,
    ERROR: 0,
    NOT_CHECKED: missingSlotCount,
    INCONCLUSIVE: 0,
    NOT_APPLICABLE: 0,
  };
  const resultCounts = input.data?.resultCounts;
  for (const [key, expected] of Object.entries(expectedResultCounts)) {
    const actual = requiredNonnegativeInteger(
      resultCounts?.[key],
      'SMOKE_MEASUREMENT_RESULT_COUNTS_INVALID',
    );
    if (actual !== expected) throw new Error('SMOKE_MEASUREMENT_RESULT_COUNTS_INVALID');
  }

  const metrics = input.data?.snapshot?.metrics;
  if (!Array.isArray(metrics) || metrics.length < 4) {
    throw new Error('SMOKE_METRIC_SNAPSHOT_INCOMPLETE');
  }
  const expectedMetricKeys = ['MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE'];
  const aggregates = new Map(
    expectedMetricKeys.map((metricKey) => [
      metricKey,
      {
        cohortCount: 0,
        eligibleDenominator: 0,
        excludedCounts: {
          ERROR: 0,
          NOT_CHECKED: 0,
          INCONCLUSIVE: 0,
          NOT_APPLICABLE: 0,
        },
        numerator: 0,
        sampleSize: 0,
      },
    ]),
  );
  const metricIds = [];
  for (const metric of metrics) {
    metricIds.push(requiredUuid(metric?.id, 'SMOKE_METRIC_ID_INVALID'));
    const aggregate = aggregates.get(metric?.metricKey);
    if (aggregate === undefined) throw new Error('SMOKE_METRIC_KEY_INVALID');
    const numerator = requiredNonnegativeInteger(
      metric?.numerator,
      'SMOKE_METRIC_NUMERATOR_INVALID',
    );
    const eligibleDenominator = requiredNonnegativeInteger(
      metric?.eligibleDenominator,
      'SMOKE_METRIC_DENOMINATOR_INVALID',
    );
    const excludedCounts = {};
    for (const key of ['ERROR', 'NOT_CHECKED', 'INCONCLUSIVE', 'NOT_APPLICABLE']) {
      excludedCounts[key] = requiredNonnegativeInteger(
        metric?.excludedCounts?.[key],
        'SMOKE_METRIC_EXCLUDED_COUNTS_INVALID',
      );
    }
    const sampleSize =
      eligibleDenominator +
      excludedCounts.ERROR +
      excludedCounts.NOT_CHECKED +
      excludedCounts.INCONCLUSIVE +
      excludedCounts.NOT_APPLICABLE;
    const promptRunIds = metric?.promptRunIds;
    if (
      !Array.isArray(promptRunIds) ||
      promptRunIds.length !== sampleSize ||
      new Set(promptRunIds).size !== promptRunIds.length
    ) {
      throw new Error('SMOKE_METRIC_SAMPLE_SIZE_INVALID');
    }
    for (const promptRunId of promptRunIds) {
      requiredUuid(promptRunId, 'SMOKE_METRIC_PROMPT_RUN_ID_INVALID');
    }
    aggregate.cohortCount += 1;
    aggregate.numerator += numerator;
    aggregate.eligibleDenominator += eligibleDenominator;
    aggregate.sampleSize += sampleSize;
    for (const key of Object.keys(aggregate.excludedCounts)) {
      aggregate.excludedCounts[key] += excludedCounts[key];
    }
  }

  const metricSamples = [];
  for (const metricKey of expectedMetricKeys) {
    const aggregate = aggregates.get(metricKey);
    if (
      aggregate.cohortCount !== input.expectedCohortCount ||
      aggregate.numerator !== input.providedSlotCount ||
      aggregate.eligibleDenominator !== input.providedSlotCount ||
      aggregate.sampleSize !== input.expectedSlotCount ||
      aggregate.excludedCounts.ERROR !== 0 ||
      aggregate.excludedCounts.NOT_CHECKED !== missingSlotCount ||
      aggregate.excludedCounts.INCONCLUSIVE !== 0 ||
      aggregate.excludedCounts.NOT_APPLICABLE !== 0
    ) {
      throw new Error('SMOKE_METRIC_SAMPLE_SEMANTICS_INVALID');
    }
    metricSamples.push({ metricKey, ...aggregate });
  }

  return {
    evidence: {
      expectedSlotCount: input.expectedSlotCount,
      providedSlotCount: input.providedSlotCount,
      missingSlotCount,
      missingSlotDisposition: 'NOT_CHECKED',
      resultCounts: expectedResultCounts,
      metricSamples,
    },
    metricIds,
  };
}

function assertSealedExperiment(created, read, expected) {
  for (const candidate of [created, read]) {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      candidate.schemaVersion !== 'experiment.v1' ||
      candidate.baselineRunId !== expected.baselineRunId ||
      candidate.remeasurementRunId !== expected.remeasurementRunId ||
      candidate.intervention?.kind !== 'APPROVED_ARTIFACT' ||
      candidate.intervention?.artifactReviewId !== expected.artifactReviewId ||
      !Array.isArray(candidate.comparisons) ||
      candidate.comparisons.length < 1
    ) {
      throw new Error('SMOKE_EXPERIMENT_NOT_SEALED');
    }
  }
  if (
    created.id !== read.id ||
    JSON.stringify(created.intervention) !== JSON.stringify(read.intervention)
  ) {
    throw new Error('SMOKE_EXPERIMENT_REREAD_MISMATCH');
  }
}

function elapsedMs(start, end, code) {
  const elapsed = Math.round((end - start) * 100) / 100;
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error(code);
  return elapsed;
}

function assertWithinBudget(actual, limit, code) {
  if (actual > limit) throw new Error(`${code}:${String(actual)}`);
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function wait(durationMs) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, durationMs);
  });
}

function validateRuntimeBuildIdentity(value, expectedDigest, expectedService) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RUNTIME_BUILD_IDENTITY_INVALID');
  }
  const task =
    typeof value.taskArn === 'string'
      ? /^arn:aws:ecs:(?<region>[a-z]{2}-[a-z]+-[1-9][0-9]*):(?<account>[0-9]{12}):task\/(?<cluster>[A-Za-z0-9_-]{1,255})\/(?<task>[0-9a-f]{32})$/u.exec(
          value.taskArn,
        )
      : null;
  const container =
    typeof value.containerArn === 'string'
      ? /^arn:aws:ecs:(?<region>[a-z]{2}-[a-z]+-[1-9][0-9]*):(?<account>[0-9]{12}):container\/(?<cluster>[A-Za-z0-9_-]{1,255})\/(?<task>[0-9a-f]{32})\/[0-9a-f]{32}$/u.exec(
          value.containerArn,
        )
      : null;
  const taskDefinition =
    typeof value.taskDefinitionArn === 'string'
      ? /^arn:aws:ecs:(?<region>[a-z]{2}-[a-z]+-[1-9][0-9]*):(?<account>[0-9]{12}):task-definition\/[A-Za-z0-9_-]{1,255}:[1-9][0-9]{0,9}$/u.exec(
          value.taskDefinitionArn,
        )
      : null;
  const image =
    typeof value.image === 'string'
      ? /^(?<account>[0-9]{12})\.dkr\.ecr\.(?<region>[a-z]{2}-[a-z]+-[1-9][0-9]*)\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]{0,255}@(?<digest>sha256:[0-9a-f]{64})$/u.exec(
          value.image,
        )
      : null;
  if (
    value.schemaVersion !== 'aeostudio.runtime-build-identity.v1' ||
    value.source !== 'ecs-container-metadata-v4' ||
    value.service !== expectedService ||
    task?.groups?.region !== 'ap-southeast-1' ||
    container?.groups?.region !== task.groups.region ||
    container?.groups?.account !== task.groups.account ||
    container?.groups?.cluster !== task.groups.cluster ||
    container?.groups?.task !== task.groups.task ||
    taskDefinition?.groups?.region !== task.groups.region ||
    taskDefinition?.groups?.account !== task.groups.account ||
    image?.groups?.region !== task.groups.region ||
    image?.groups?.account !== task.groups.account ||
    image?.groups?.digest !== expectedDigest ||
    value.imageDigest !== expectedDigest ||
    value.imageId !== expectedDigest ||
    !exactTimestamp(value.capturedAt)
  ) {
    throw new Error('RUNTIME_BUILD_IDENTITY_MISMATCH');
  }
  return value;
}

function exactTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

async function fetchPublicJson(origin, path) {
  const before = performance.now();
  const response = await globalThis.fetch(new URL(path, origin), {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  const durationMs = Math.round((performance.now() - before) * 100) / 100;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`SMOKE_HTTP_${String(response.status)}:${path}`);
  return { status: response.status, durationMs, body };
}

function assertEqual(actual, expected, code) {
  if (actual !== expected) throw new Error(`${code}:${String(actual)}`);
}
