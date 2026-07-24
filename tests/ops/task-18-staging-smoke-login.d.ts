declare module '*scripts/smoke/cognito-login.mjs' {
  import type { BrowserContext } from '@playwright/test';

  export interface CognitoLoginInput {
    cognitoOrigin: string;
    password: string;
    stagingOrigin: string;
    totpSecret: string;
    username: string;
  }

  export interface SmokeJsonResponse {
    body: {
      data?: Record<string, unknown> & {
        email?: string;
        experiment?: { status?: string };
        identity?: RuntimeBuildIdentity;
        status?: string;
      };
    } | null;
    durationMs: number;
    status: number;
  }

  export interface SmokeBrowser {
    close(): Promise<void> | void;
    newContext(options: {
      acceptDownloads: boolean;
      serviceWorkers: 'block';
    }): Promise<BrowserContext>;
  }

  export interface AuthenticatedSmokeSession {
    close(): Promise<void>;
    flow: Readonly<{
      callbackPath: '/api/v1/auth/callback';
      mfa: 'software-token-totp';
      pkce: 'S256';
      protocol: 'authorization-code';
    }>;
    getJson(path: string, options?: { requestId?: string }): Promise<SmokeJsonResponse>;
    requestJson(
      path: string,
      options?: {
        body?: unknown;
        method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        requestId?: string;
      },
    ): Promise<SmokeJsonResponse>;
  }

  export interface RuntimeBuildIdentity {
    capturedAt: string;
    containerArn: string;
    image: string;
    imageDigest: string;
    imageId: string;
    schemaVersion: 'aeostudio.runtime-build-identity.v1';
    service: 'api' | 'web' | 'worker';
    source: 'ecs-container-metadata-v4';
    taskArn: string;
    taskDefinitionArn: string;
  }

  export function generateTotp(input: { now?: Date; secret: string }): string;

  export function completeSyntheticCognitoLogin(
    input: CognitoLoginInput,
    dependencies?: {
      launchBrowser?: () => Promise<SmokeBrowser>;
      now?: () => Date;
      timeoutMs?: number;
    },
  ): Promise<AuthenticatedSmokeSession>;
}

declare module '*scripts/smoke/staging-smoke-runner.mjs' {
  import type {
    AuthenticatedSmokeSession,
    CognitoLoginInput,
    RuntimeBuildIdentity,
    SmokeJsonResponse,
  } from '*scripts/smoke/cognito-login.mjs';

  export interface StagingSmokeConfig extends CognitoLoginInput {
    imageDigest: string;
    manualMeasurementAdapterVersion: string;
    manualMeasurementProviderKey: string;
    manualMeasurementSurfaceKey: string;
    manualMeasurementTermsVersion: string;
    prerequisiteBaselineId: string;
    prerequisiteProfileId: string;
    reviewerPassword: string;
    reviewerTotpSecret: string;
    reviewerUsername: string;
    startedAt: Date;
    syntheticAdapterVersionId: string;
    syntheticChannelKey: string;
    syntheticPublicationTarget: string;
    tenantId: string;
    webImageDigest: string;
    workspaceId: string;
  }

  export interface SyntheticMeasurementEvidence {
    coverage: {
      expectedSlotCount: number;
      metricSamples: Array<{
        cohortCount: number;
        eligibleDenominator: number;
        excludedCounts: {
          ERROR: number;
          INCONCLUSIVE: number;
          NOT_APPLICABLE: number;
          NOT_CHECKED: number;
        };
        metricKey: 'MENTION_RATE' | 'CITATION_RATE' | 'ACCURACY_RATE' | 'COVERAGE_RATE';
        numerator: number;
        sampleSize: number;
      }>;
      missingSlotCount: number;
      missingSlotDisposition: 'NOT_CHECKED';
      providedSlotCount: number;
      resultCounts: {
        ERROR: number;
        FAIL: number;
        INCONCLUSIVE: number;
        NOT_APPLICABLE: number;
        NOT_CHECKED: number;
        PASS: number;
      };
    };
    jobId: string;
    jobPollAttempts: number;
    manualImportId: string;
    metricIds: string[];
    runId: string;
    status: 'COMPLETED';
  }

  export interface StagingSmokeEvidence {
    checks: {
      health: { durationMs: number; status: number };
      readiness: { durationMs: number; status: number };
      runtimeBuildIdentity: { durationMs: number; status: number };
      syntheticLogin: {
        operator: {
          callbackPath: '/api/v1/auth/callback';
          durationMs: number;
          mfa: 'software-token-totp';
          pkce: 'S256';
          protocol: 'authorization-code';
          status: number;
        };
        reviewer: {
          callbackPath: '/api/v1/auth/callback';
          durationMs: number;
          mfa: 'software-token-totp';
          pkce: 'S256';
          protocol: 'authorization-code';
          status: number;
        };
      };
      syntheticHappyPath: { durationMs: number; status: number };
      webRuntimeBuildIdentity: { durationMs: number; status: number };
    };
    completedAt: string;
    endpoint: { origin: string };
    environment: 'staging';
    imageDigest: string;
    region: 'ap-southeast-1';
    runtimeBuildIdentity: RuntimeBuildIdentity;
    schemaVersion: 'aeostudio-staging-smoke.v1';
    startedAt: string;
    syntheticFlow: {
      created: {
        artifact: {
          id: string;
          reviewId: string;
          revisionId: string;
          status: 'APPROVED';
        };
        baseline: SyntheticMeasurementEvidence;
        channelPackage: { checksum: string; id: string };
        claim: {
          id: string;
          reviewId: string;
          revisionId: string;
          status: 'APPROVED';
        };
        contentPlan: {
          briefId: string;
          briefReviewId: string;
          id: string;
          jobId: string;
          jobPollAttempts: number;
          status: 'READY';
        };
        evidence: { contentHash: string; snapshotId: string; sourceId: string };
        experiment: {
          baselineRunId: string;
          id: string;
          interventionKind: 'APPROVED_ARTIFACT';
          publishedArtifactClaimed: false;
          remeasurementRunId: string;
          sealState: 'SEALED';
        };
        offering: { id: string; revision: number; revisionId: string };
        profileRevision: { id: string; profileId: string; revision: number };
        promptSet: {
          approvalId: string;
          id: string;
          revisionId: string;
          scenarioId: string;
          status: 'APPROVED';
        };
        publication: {
          attemptId: string;
          deliverySemantics: 'NON_LIVE_CONTROLLED_SYNTHETIC_RECEIVER';
          id: string;
          isProductionLive: false;
          jobId: string;
          status: 'REMOTE_APPLIED';
        };
        remeasurement: SyntheticMeasurementEvidence;
      };
      prerequisites: {
        channelAuthorizationId: string;
        manualMeasurement: {
          adapterVersion: string;
          providerKey: string;
          providerPolicy: 'PRE_PROVISIONED_APPROVED';
          surfaceKey: string;
          termsVersion: string;
        };
        profileId: string;
        siteBaselineId: string;
        syntheticAdapterVersionId: string;
        syntheticChannelKey: string;
      };
      runId: string;
      steps: Array<{
        actor: 'operator' | 'reviewer';
        durationMs: number;
        name: string;
        state?: string;
        status: number;
      }>;
      timingGates: {
        baselineMeasurement: {
          acceptedToCompletedMs: number;
          limitMs: number;
          manualEvidenceReviewExcludedFromLimit: true;
          manualEvidenceReviewWaitMs: number;
          outcome: 'PASS';
          scope: 'PLATFORM_EXECUTION';
        };
        contentPlan: {
          acceptedToReadyMs: number;
          limitMs: number;
          manualOrExternalWaitMs: 0;
          outcome: 'PASS';
          scope: 'PLATFORM_EXECUTION';
        };
        remeasurement: {
          acceptedToCompletedMs: number;
          manualEvidenceReviewExcludedFromLimit: true;
          manualEvidenceReviewWaitMs: number;
          scope: 'PLATFORM_EXECUTION';
        };
      };
    };
    traceProbe: { operation: 'runtimeBuildIdentity'; requestId: string };
    webRuntimeBuildIdentity: RuntimeBuildIdentity;
  }

  export function runStagingSmoke(
    config: StagingSmokeConfig,
    dependencies?: {
      completeLogin?: (input: CognitoLoginInput) => Promise<AuthenticatedSmokeSession>;
      getPublicJson?: (origin: string, path: string) => Promise<SmokeJsonResponse>;
      monotonicNow?: () => number;
      nextRequestId?: () => string;
      now?: () => Date;
      sleep?: (durationMs: number) => Promise<void>;
    },
  ): Promise<StagingSmokeEvidence>;
}
