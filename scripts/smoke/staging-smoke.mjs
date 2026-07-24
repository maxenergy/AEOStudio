import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

import { completeSyntheticCognitoLogin } from './cognito-login.mjs';
import { runStagingSmoke } from './staging-smoke-runner.mjs';

const startedAt = new Date();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function stagingOrigin() {
  const origin = new URL(required('AEO_STAGING_BASE_URL'));
  if (origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '') {
    throw new Error('STAGING_SMOKE_REQUIRES_HTTPS');
  }
  origin.pathname = '/';
  origin.search = '';
  origin.hash = '';
  return origin;
}

const origin = stagingOrigin();
const evidence = await runStagingSmoke(
  {
    cognitoOrigin: required('AEO_SMOKE_COGNITO_ORIGIN'),
    imageDigest: required('AEO_IMAGE_DIGEST'),
    manualMeasurementAdapterVersion: required('AEO_SMOKE_MANUAL_ADAPTER_VERSION'),
    manualMeasurementProviderKey: required('AEO_SMOKE_MANUAL_PROVIDER_KEY'),
    manualMeasurementSurfaceKey: required('AEO_SMOKE_MANUAL_SURFACE_KEY'),
    manualMeasurementTermsVersion: required('AEO_SMOKE_MANUAL_TERMS_VERSION'),
    password: required('AEO_SMOKE_COGNITO_PASSWORD'),
    prerequisiteBaselineId: required('AEO_SMOKE_PREREQUISITE_BASELINE_ID'),
    prerequisiteProfileId: required('AEO_SMOKE_PREREQUISITE_PROFILE_ID'),
    reviewerPassword: required('AEO_SMOKE_REVIEWER_COGNITO_PASSWORD'),
    reviewerTotpSecret: required('AEO_SMOKE_REVIEWER_COGNITO_TOTP_SECRET'),
    reviewerUsername: required('AEO_SMOKE_REVIEWER_COGNITO_USERNAME'),
    stagingOrigin: origin,
    startedAt,
    syntheticAdapterVersionId: required('AEO_SMOKE_SYNTHETIC_ADAPTER_VERSION_ID'),
    syntheticChannelKey: required('AEO_SMOKE_SYNTHETIC_CHANNEL_KEY'),
    syntheticPublicationTarget: required('AEO_SMOKE_SYNTHETIC_PUBLICATION_TARGET'),
    tenantId: required('AEO_SMOKE_TENANT_ID'),
    totpSecret: required('AEO_SMOKE_COGNITO_TOTP_SECRET'),
    username: required('AEO_SMOKE_COGNITO_USERNAME'),
    webImageDigest: required('AEO_WEB_IMAGE_DIGEST'),
    workspaceId: required('AEO_SMOKE_WORKSPACE_ID'),
  },
  { completeLogin: completeSyntheticCognitoLogin },
);

const evidencePath = resolve(process.env.AEO_SMOKE_EVIDENCE_PATH ?? 'output/staging-smoke.json');
await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({ outcome: 'PASSED', evidencePath, imageDigest: evidence.imageDigest })}\n`,
);
