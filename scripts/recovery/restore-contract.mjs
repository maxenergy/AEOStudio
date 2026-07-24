const restorePointSafetyMilliseconds = 1_000;

function instant(value) {
  const parsed = new Date(value ?? Number.NaN);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

export function selectRdsRestoreWindow(instance) {
  const earliestRestorableTime = instant(instance?.EarliestRestorableTime);
  const latestRestorableTime = instant(instance?.LatestRestorableTime);
  if (earliestRestorableTime === undefined || latestRestorableTime === undefined) {
    throw new Error('RDS_RECOVERY_WINDOW_INVALID');
  }
  const selectedRestoreTime = new Date(
    latestRestorableTime.getTime() - restorePointSafetyMilliseconds,
  );
  if (selectedRestoreTime.getTime() < earliestRestorableTime.getTime()) {
    throw new Error('RDS_RECOVERY_WINDOW_TOO_NARROW');
  }
  return { earliestRestorableTime, latestRestorableTime, selectedRestoreTime };
}

export async function loadApprovedDatabaseCredentials({
  credentialSecretArn,
  region,
  readSecretValue,
}) {
  const arn = /^arn:aws:secretsmanager:([a-z0-9-]+):[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/u.exec(
    credentialSecretArn ?? '',
  );
  if (arn?.[1] !== region || typeof readSecretValue !== 'function') {
    throw new Error('RDS_CREDENTIAL_SECRET_ARN_INVALID');
  }
  const envelope = await readSecretValue(credentialSecretArn);
  let secret;
  try {
    secret = JSON.parse(envelope?.SecretString ?? '');
  } catch {
    throw new Error('RDS_CREDENTIAL_SECRET_INVALID');
  }
  if (
    typeof secret?.username !== 'string' ||
    secret.username.trim().length === 0 ||
    typeof secret?.password !== 'string' ||
    secret.password.length === 0
  ) {
    throw new Error('RDS_CREDENTIAL_SECRET_INVALID');
  }
  return { username: secret.username, password: secret.password };
}

function versionIdsForKey(listing, markerKey) {
  return new Set(
    [...(listing?.Versions ?? []), ...(listing?.DeleteMarkers ?? [])]
      .filter((version) => version?.Key === markerKey && typeof version?.VersionId === 'string')
      .map((version) => version.VersionId),
  );
}

export function selectNewRestoredVersion({ before, after, markerKey, sourceVersionId }) {
  if (
    typeof markerKey !== 'string' ||
    markerKey.length === 0 ||
    typeof sourceVersionId !== 'string' ||
    sourceVersionId.length === 0
  ) {
    throw new Error('S3_RESTORED_VERSION_SET_INVALID');
  }
  const priorVersionIds = versionIdsForKey(before, markerKey);
  const candidatesByVersionId = new Map(
    (after?.Versions ?? [])
      .filter(
        (version) =>
          version?.Key === markerKey &&
          typeof version?.VersionId === 'string' &&
          version.VersionId !== sourceVersionId &&
          !priorVersionIds.has(version.VersionId),
      )
      .map((version) => [version.VersionId, version]),
  );
  if (candidatesByVersionId.size !== 1) {
    throw new Error('S3_RESTORED_VERSION_SET_INVALID');
  }
  return candidatesByVersionId.values().next().value;
}
