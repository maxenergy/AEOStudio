type JsonRequestOptions = {
  body?: unknown;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  requestId?: string;
};

type SmokeCall = {
  actor: 'operator' | 'reviewer';
  body?: unknown;
  method: string;
  path: string;
  requestId?: string;
};

type FixtureSmokeBody = {
  data?: Record<string, unknown>;
} | null;

type StagingSyntheticFixtureOptions = {
  dashboardNotCheckedCount?: number;
  manualImportExpectedSlotCount?: number;
  manualImportProvidedSlotCount?: number;
};

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const hash = (character: string) => character.repeat(64);

export const stagingSyntheticIds = Object.freeze({
  prerequisiteProfileId: id(1),
  prerequisiteBaselineId: id(2),
  syntheticAdapterVersionId: id(3),
  profileRevisionId: id(10),
  offeringId: id(11),
  offeringRevisionId: id(12),
  evidenceSourceId: id(13),
  evidenceSnapshotId: id(14),
  claimId: id(15),
  claimRevisionId: id(16),
  claimReviewId: id(17),
  promptSetId: id(18),
  promptRevisionId: id(19),
  scenarioId: id(20),
  promptApprovalId: id(21),
  contentPlanId: id(22),
  contentPlanJobId: id(23),
  briefId: id(24),
  briefReviewId: id(25),
  artifactId: id(26),
  artifactRevisionId: id(27),
  artifactJobId: id(28),
  artifactReviewId: id(29),
  baselineImportId: id(30),
  baselineJobId: id(31),
  baselineRunId: id(32),
  remeasurementImportId: id(33),
  remeasurementJobId: id(34),
  remeasurementRunId: id(35),
  channelPackageId: id(36),
  channelAuthorizationId: id(37),
  publicationId: id(38),
  publicationJobId: id(39),
  publicationAttemptId: id(40),
  experimentId: id(41),
});

export function stagingSyntheticSmokeConfig() {
  return {
    cognitoOrigin: 'https://auth.staging.example.test',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    manualMeasurementAdapterVersion: 'manual-import-v1',
    manualMeasurementProviderKey: 'openai',
    manualMeasurementSurfaceKey: 'chatgpt-search',
    manualMeasurementTermsVersion: 'manual-import-terms-v1',
    password: 'synthetic-password-value',
    prerequisiteBaselineId: stagingSyntheticIds.prerequisiteBaselineId,
    prerequisiteProfileId: stagingSyntheticIds.prerequisiteProfileId,
    reviewerPassword: 'synthetic-reviewer-password-value',
    reviewerTotpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    reviewerUsername: 'synthetic-reviewer@example.test',
    stagingOrigin: 'https://staging.example.test',
    startedAt: new Date('2026-07-23T12:00:00.000Z'),
    syntheticAdapterVersionId: stagingSyntheticIds.syntheticAdapterVersionId,
    syntheticChannelKey: 'staging-synthetic-receiver',
    syntheticPublicationTarget: 'https://receiver.staging.example.test/v1/packages',
    tenantId: id(4),
    totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    username: 'synthetic-operator@example.test',
    webImageDigest: `sha256:${'b'.repeat(64)}`,
    workspaceId: id(5),
  };
}

export function createStagingSyntheticHappyPathFixture(
  config: ReturnType<typeof stagingSyntheticSmokeConfig>,
  fixtureOptions: StagingSyntheticFixtureOptions = {},
) {
  const calls: SmokeCall[] = [];
  const closed: Array<'operator' | 'reviewer'> = [];
  let manualImportCount = 0;
  const promptIds = Array.from({ length: 20 }, (_, index) => id(100 + index));
  const metricIds = {
    baseline: Array.from({ length: 4 }, (_, index) => id(200 + index)),
    remeasurement: Array.from({ length: 4 }, (_, index) => id(210 + index)),
  };
  const metricKeys = ['MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE'];
  const scopePath = `/api/v1/tenants/${config.tenantId}/workspaces/${config.workspaceId}`;
  const artifactHash = hash('d');
  const packageChecksum = hash('e');
  const promptHash = hash('b');
  const scenarioHash = hash('c');
  const claimHash = hash('a');
  const interventionAt = '2026-07-23T12:00:10.000Z';

  const runtimeIdentity = (service: 'api' | 'web') => {
    const digest = service === 'api' ? config.imageDigest : config.webImageDigest;
    const task = service === 'api' ? 'a' : 'd';
    const container = service === 'api' ? 'b' : 'e';
    return {
      schemaVersion: 'aeostudio.runtime-build-identity.v1',
      source: 'ecs-container-metadata-v4',
      service,
      taskArn: 'arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/' + task.repeat(32),
      taskDefinitionArn: `arn:aws:ecs:ap-southeast-1:123456789012:task-definition/aeostudio-staging-${service}:17`,
      containerArn:
        'arn:aws:ecs:ap-southeast-1:123456789012:container/aeostudio-staging/' +
        `${task.repeat(32)}/${container.repeat(32)}`,
      image: `123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-${service}@${digest}`,
      imageDigest: digest,
      imageId: digest,
      capturedAt: '2026-07-23T12:00:05.000Z',
    };
  };

  const response = (body: FixtureSmokeBody, status = 200) =>
    Promise.resolve({ body, durationMs: 1, status });

  const request =
    (actor: 'operator' | 'reviewer') =>
    (path: string, options: JsonRequestOptions = {}) => {
      const method = options.method ?? 'GET';
      calls.push({
        actor,
        method,
        path,
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      });

      if (path === '/api/v1/auth/session') {
        return response({
          data: {
            email: actor === 'operator' ? config.username : config.reviewerUsername,
          },
        });
      }
      if (path === '/api/v1/runtime/build-identity') {
        return response({ data: { identity: runtimeIdentity('api') } });
      }
      if (path === '/runtime/build-identity') {
        return response({ data: { identity: runtimeIdentity('web') } });
      }
      if (path === `${scopePath}/profiles/${config.prerequisiteProfileId}/revisions`) {
        return response(
          {
            data: {
              profile: {
                id: stagingSyntheticIds.profileRevisionId,
                profileId: config.prerequisiteProfileId,
                revision: 7,
              },
            },
          },
          201,
        );
      }
      if (path === `${scopePath}/profiles/${config.prerequisiteProfileId}/offerings`) {
        return response(
          {
            data: {
              offering: {
                id: stagingSyntheticIds.offeringRevisionId,
                offeringId: stagingSyntheticIds.offeringId,
                revision: 1,
              },
            },
          },
          201,
        );
      }
      if (path === `${scopePath}/evidence-sources`) {
        return response({ data: { source: { id: stagingSyntheticIds.evidenceSourceId } } }, 201);
      }
      if (
        path === `${scopePath}/evidence-sources/${stagingSyntheticIds.evidenceSourceId}/snapshots`
      ) {
        return response(
          {
            data: {
              snapshot: {
                id: stagingSyntheticIds.evidenceSnapshotId,
                contentHash: (options.body as { contentHash?: string }).contentHash,
              },
            },
          },
          201,
        );
      }
      if (path === `${scopePath}/claims`) {
        return response(
          {
            data: {
              claim: { id: stagingSyntheticIds.claimId },
              revision: {
                id: stagingSyntheticIds.claimRevisionId,
                contentHash: claimHash,
                status: 'DRAFT',
              },
            },
          },
          201,
        );
      }
      if (
        path ===
        `${scopePath}/claims/${stagingSyntheticIds.claimId}/revisions/${stagingSyntheticIds.claimRevisionId}/submit`
      ) {
        return response(
          { data: { revision: { id: stagingSyntheticIds.claimRevisionId, status: 'IN_REVIEW' } } },
          201,
        );
      }
      if (
        path ===
        `${scopePath}/claims/${stagingSyntheticIds.claimId}/revisions/${stagingSyntheticIds.claimRevisionId}/reviews`
      ) {
        return response({
          data: {
            revision: {
              id: stagingSyntheticIds.claimRevisionId,
              contentHash: claimHash,
              status: 'APPROVED',
            },
            review: { id: stagingSyntheticIds.claimReviewId },
          },
        });
      }
      if (path === `${scopePath}/prompt-sets/proposals`) {
        return response(
          {
            data: {
              promptSet: { id: stagingSyntheticIds.promptSetId },
              revision: {
                id: stagingSyntheticIds.promptRevisionId,
                revision: 1,
                contentHash: promptHash,
                status: 'DRAFT',
                prompts: promptIds.map((promptId, index) => ({
                  id: promptId,
                  text: `Synthetic question ${index + 1}`,
                })),
                scopes: [{ market: 'SG', locale: 'en-SG', region: 'Singapore' }],
              },
              scenario: {
                id: stagingSyntheticIds.scenarioId,
                contentHash: scenarioHash,
                repetitions: 3,
              },
            },
          },
          201,
        );
      }
      if (
        path ===
        `${scopePath}/prompt-sets/${stagingSyntheticIds.promptSetId}/revisions/${stagingSyntheticIds.promptRevisionId}/approve`
      ) {
        return response({
          data: {
            revision: {
              id: stagingSyntheticIds.promptRevisionId,
              contentHash: promptHash,
              status: 'APPROVED',
            },
            scenario: {
              id: stagingSyntheticIds.scenarioId,
              contentHash: scenarioHash,
            },
            approval: { id: stagingSyntheticIds.promptApprovalId },
            approvalCurrent: true,
          },
        });
      }
      if (path === `${scopePath}/content-plans` && method === 'POST') {
        return response(
          {
            data: {
              plan: { id: stagingSyntheticIds.contentPlanId, status: 'PENDING' },
              job: { id: stagingSyntheticIds.contentPlanJobId, status: 'QUEUED' },
            },
          },
          202,
        );
      }
      if (path === `${scopePath}/content-plans/${stagingSyntheticIds.contentPlanId}`) {
        return response({
          data: {
            plan: { id: stagingSyntheticIds.contentPlanId, status: 'READY' },
            briefs: [
              {
                id: stagingSyntheticIds.briefId,
                contentHash: hash('7'),
                status: 'REVIEW_REQUIRED',
              },
            ],
          },
        });
      }
      if (
        path ===
        `${scopePath}/content-plans/${stagingSyntheticIds.contentPlanId}/briefs/${stagingSyntheticIds.briefId}/review`
      ) {
        return response({
          data: {
            brief: { id: stagingSyntheticIds.briefId, status: 'APPROVED' },
            review: { id: stagingSyntheticIds.briefReviewId },
          },
        });
      }
      if (path === `${scopePath}/artifacts` && method === 'POST') {
        return response(
          {
            data: {
              artifact: { id: stagingSyntheticIds.artifactId, status: 'PENDING' },
              job: { id: stagingSyntheticIds.artifactJobId, status: 'QUEUED' },
            },
          },
          202,
        );
      }
      if (path === `${scopePath}/artifacts/${stagingSyntheticIds.artifactId}`) {
        return response({
          data: {
            artifact: { id: stagingSyntheticIds.artifactId, status: 'DRAFT' },
            revision: {
              id: stagingSyntheticIds.artifactRevisionId,
              revision: 1,
              contentHash: artifactHash,
              status: 'DRAFT',
            },
          },
        });
      }
      if (path === `${scopePath}/artifacts/${stagingSyntheticIds.artifactId}/revisions/1/submit`) {
        return response({
          data: {
            revision: {
              id: stagingSyntheticIds.artifactRevisionId,
              revision: 1,
              contentHash: artifactHash,
              status: 'IN_REVIEW',
            },
          },
        });
      }
      if (path === `${scopePath}/artifacts/${stagingSyntheticIds.artifactId}/revisions/1/review`) {
        return response({
          data: {
            revision: {
              id: stagingSyntheticIds.artifactRevisionId,
              revision: 1,
              contentHash: artifactHash,
              status: 'APPROVED',
            },
            review: {
              id: stagingSyntheticIds.artifactReviewId,
              createdAt: interventionAt,
            },
          },
        });
      }
      if (
        path ===
        `${scopePath}/measurement-provider-policies/${config.manualMeasurementProviderKey}/${config.manualMeasurementSurfaceKey}`
      ) {
        return response({
          data: {
            state: {
              eligible: true,
              requiredAdapterVersion: config.manualMeasurementAdapterVersion,
              requiredTermsVersion: config.manualMeasurementTermsVersion,
            },
          },
        });
      }
      if (path === `${scopePath}/measurement-manual-imports`) {
        manualImportCount += 1;
        return response(
          {
            data: {
              manualImport: {
                id:
                  manualImportCount === 1
                    ? stagingSyntheticIds.baselineImportId
                    : stagingSyntheticIds.remeasurementImportId,
                contentHash: manualImportCount === 1 ? hash('1') : hash('2'),
                expectedSlotCount: fixtureOptions.manualImportExpectedSlotCount ?? 60,
                providedSlotCount: fixtureOptions.manualImportProvidedSlotCount ?? 1,
                status: 'SUBMITTED',
              },
            },
          },
          201,
        );
      }
      if (
        path ===
          `${scopePath}/measurement-manual-imports/${stagingSyntheticIds.baselineImportId}/review` ||
        path ===
          `${scopePath}/measurement-manual-imports/${stagingSyntheticIds.remeasurementImportId}/review`
      ) {
        const baseline = path.includes(stagingSyntheticIds.baselineImportId);
        return response({
          data: {
            manualImport: {
              id: baseline
                ? stagingSyntheticIds.baselineImportId
                : stagingSyntheticIds.remeasurementImportId,
              contentHash: baseline ? hash('1') : hash('2'),
              status: 'APPROVED',
            },
          },
        });
      }
      if (path === `${scopePath}/measurement-runs` && method === 'POST') {
        const kind = (options.body as { kind?: string } | undefined)?.kind;
        const baseline = kind === 'BASELINE';
        return response(
          {
            data: {
              measurementRun: {
                id: baseline
                  ? stagingSyntheticIds.baselineRunId
                  : stagingSyntheticIds.remeasurementRunId,
                status: 'QUEUED',
              },
              job: {
                id: baseline
                  ? stagingSyntheticIds.baselineJobId
                  : stagingSyntheticIds.remeasurementJobId,
                status: 'QUEUED',
              },
            },
          },
          202,
        );
      }
      if (
        path === `${scopePath}/measurement-runs/${stagingSyntheticIds.baselineRunId}` ||
        path === `${scopePath}/measurement-runs/${stagingSyntheticIds.remeasurementRunId}`
      ) {
        const baseline = path.endsWith(stagingSyntheticIds.baselineRunId);
        return response({
          data: {
            measurementRun: {
              id: baseline
                ? stagingSyntheticIds.baselineRunId
                : stagingSyntheticIds.remeasurementRunId,
              kind: baseline ? 'BASELINE' : 'REMEASUREMENT',
              status: 'COMPLETED',
              expectedPromptRunCount: 60,
              completedPromptRunCount: 60,
              completedAt: baseline ? '2026-07-23T12:00:09.000Z' : '2026-07-23T12:00:20.000Z',
            },
          },
        });
      }
      if (
        path === `${scopePath}/measurement-runs/${stagingSyntheticIds.baselineRunId}/dashboard` ||
        path === `${scopePath}/measurement-runs/${stagingSyntheticIds.remeasurementRunId}/dashboard`
      ) {
        const baseline = path.includes(stagingSyntheticIds.baselineRunId);
        const measurementRunId = baseline
          ? stagingSyntheticIds.baselineRunId
          : stagingSyntheticIds.remeasurementRunId;
        const notCheckedCount = fixtureOptions.dashboardNotCheckedCount ?? 59;
        const promptRunIds = Array.from({ length: 60 }, (_, index) =>
          id((baseline ? 300 : 400) + index),
        );
        return response({
          data: {
            resultCounts: {
              PASS: 1,
              FAIL: 0,
              ERROR: 0,
              NOT_CHECKED: notCheckedCount,
              INCONCLUSIVE: 0,
              NOT_APPLICABLE: 0,
            },
            snapshot: {
              measurementRunId,
              metrics: (baseline ? metricIds.baseline : metricIds.remeasurement).map(
                (metricId, index) => ({
                  id: metricId,
                  metricKey: metricKeys[index],
                  numerator: 1,
                  eligibleDenominator: 1,
                  excludedCounts: {
                    ERROR: 0,
                    NOT_CHECKED: notCheckedCount,
                    INCONCLUSIVE: 0,
                    NOT_APPLICABLE: 0,
                  },
                  promptRunIds,
                }),
              ),
            },
          },
        });
      }
      if (path === `${scopePath}/channel-packages` && method === 'POST') {
        return response(
          {
            data: {
              package: {
                id: stagingSyntheticIds.channelPackageId,
                packageChecksum,
              },
            },
          },
          201,
        );
      }
      if (path === `${scopePath}/publications/eligibility`) {
        return response({
          data: {
            eligibility: {
              mode: 'PUBLISH_READY',
              packageId: stagingSyntheticIds.channelPackageId,
              packageChecksum,
              adapterVersionId: config.syntheticAdapterVersionId,
              channelAuthorizationId: stagingSyntheticIds.channelAuthorizationId,
            },
          },
        });
      }
      if (path === `${scopePath}/publications` && method === 'POST') {
        return response(
          {
            data: {
              publication: {
                id: stagingSyntheticIds.publicationId,
                status: 'QUEUED',
              },
              job: {
                id: stagingSyntheticIds.publicationJobId,
                status: 'QUEUED',
              },
            },
          },
          202,
        );
      }
      if (path === `${scopePath}/publications/${stagingSyntheticIds.publicationId}`) {
        return response({
          data: {
            publication: {
              id: stagingSyntheticIds.publicationId,
              status: 'REMOTE_APPLIED',
              remoteState: {
                status: 'DELIVERED',
                number: null,
                isProductionLive: false,
                rollbackHandle: null,
              },
            },
            attempts: [
              {
                id: stagingSyntheticIds.publicationAttemptId,
                outcome: 'APPLIED',
              },
            ],
          },
        });
      }
      if (path === `${scopePath}/experiments` && method === 'POST') {
        return response(
          {
            data: {
              experiment: {
                id: stagingSyntheticIds.experimentId,
                schemaVersion: 'experiment.v1',
                baselineRunId: stagingSyntheticIds.baselineRunId,
                remeasurementRunId: stagingSyntheticIds.remeasurementRunId,
                intervention: {
                  kind: 'APPROVED_ARTIFACT',
                  artifactId: stagingSyntheticIds.artifactId,
                  artifactRevisionId: stagingSyntheticIds.artifactRevisionId,
                  artifactReviewId: stagingSyntheticIds.artifactReviewId,
                  artifactContentHash: artifactHash,
                  observedAt: interventionAt,
                },
                comparisons: [{ metricKey: 'MENTION_RATE' }],
              },
            },
          },
          201,
        );
      }
      if (path === `${scopePath}/experiments/${stagingSyntheticIds.experimentId}`) {
        return response({
          data: {
            experiment: {
              id: stagingSyntheticIds.experimentId,
              schemaVersion: 'experiment.v1',
              baselineRunId: stagingSyntheticIds.baselineRunId,
              remeasurementRunId: stagingSyntheticIds.remeasurementRunId,
              intervention: {
                kind: 'APPROVED_ARTIFACT',
                artifactId: stagingSyntheticIds.artifactId,
                artifactRevisionId: stagingSyntheticIds.artifactRevisionId,
                artifactReviewId: stagingSyntheticIds.artifactReviewId,
                artifactContentHash: artifactHash,
                observedAt: interventionAt,
              },
              comparisons: [{ metricKey: 'MENTION_RATE' }],
            },
          },
        });
      }
      if (path.startsWith(`${scopePath}/jobs/`)) {
        return response({ data: { job: { status: 'SUCCEEDED', progress: 100 } } });
      }
      throw new Error(`UNEXPECTED_SMOKE_REQUEST:${actor}:${method}:${path}`);
    };

  return {
    calls,
    closed,
    completeLogin: (input: { username: string }) => {
      const actor = input.username === config.username ? 'operator' : 'reviewer';
      const requestJson = request(actor);
      return Promise.resolve({
        flow: {
          callbackPath: '/api/v1/auth/callback',
          mfa: 'software-token-totp',
          pkce: 'S256',
          protocol: 'authorization-code',
        } as const,
        getJson: (path: string, options?: Omit<JsonRequestOptions, 'method' | 'body'>) =>
          requestJson(path, { ...options, method: 'GET' }),
        requestJson,
        close: () => {
          closed.push(actor);
          return Promise.resolve();
        },
      });
    },
    getPublicJson: (_origin: string, path: string) => {
      return response(
        path === '/health' ? { data: { status: 'alive' } } : { data: { status: 'ready' } },
      );
    },
  };
}
