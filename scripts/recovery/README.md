# Singapore staging restore drill

`run-restore-drill.mjs` performs an actual, isolated RDS point-in-time restore and AWS Backup S3 continuous restore in `ap-southeast-1`, then verifies an immutable database marker and an exact S3 object/checksum. It computes measured RPO and RTO and fails when RPO exceeds 15 minutes or RTO exceeds 4 hours. The RDS threshold requires both the selected recovery point and the recovered marker to be inside the 15-minute window; the marker must also be at or before the recovery point.

Run the script from an approved execution plane with network reachability into the staging VPC, such as an ECS one-off task or VPC-attached CodeBuild job. The restored RDS endpoint must resolve only to private addresses and the TLS database query must succeed; running from a public workstation is not a valid drill path.

The script is fail-closed and will not start unless `AEO_RESTORE_CONFIRM=staging` and `AWS_REGION=ap-southeast-1`. The target DB identifier must end in `-restore-drill`. For RDS, the script selects one second before `LatestRestorableTime`, rejects a selection earlier than `EarliestRestorableTime`, sends only that selected instant as the SDK `RestoreTime`, and records earliest, selected, and latest values as audit evidence. `AEO_S3_RESTORE_TIME` is required and is sent as AWS Backup S3 `RestoreTime`; it must be no earlier than the source marker and no later than the drill start. The source object's `VersionId` identifies the exact pre-restore evidence object, but AWS Backup does not preserve that identifier during restore. The script therefore discovers the newly created destination `VersionId`, requires it to differ from the source version, and verifies its checksum with `ChecksumMode=ENABLED`.

PITR does not guarantee that the restored instance response contains a new `MasterUserSecret`. The approved execution environment must therefore supply `AEO_RESTORE_DB_CREDENTIAL_SECRET_ARN`, a Singapore Secrets Manager ARN whose JSON contains non-empty `username` and `password` fields. It must also supply `AEO_RESTORE_DB_PARAMETER_GROUP`, the reviewed PostgreSQL-family parameter group for the restored engine version. The SDK request passes that group explicitly and the drill rejects a restored instance unless the exact group reports `in-sync`. The script retrieves the explicit credential secret only after the restored endpoint resolves exclusively to private addresses. It always uses the restored instance endpoint and ignores any host carried by the secret. Credentials remain in process memory and are never written to the evidence JSON; the TLS CA verification and immutable marker query remain mandatory.

The script does not delete restored resources; cleanup is a separate approved operational action so failed evidence remains available for investigation. Each drill uses a new evidence path and opens it with write-once semantics; it never overwrites prior evidence.

No restore has been executed merely because this script exists. Only an evidence file produced by an approved AWS run may be appended to `docs/goal/VERIFY.md` as real AC-T10 proof.

## Private Fargate execution plane

The repeatable runner is staging-only. `Dockerfile.recovery` packages the exact reviewed Node 24 Alpine base, the `pg` client, AWS SDK v3 clients, Alpine CA certificates, and the checksum-pinned global RDS CA bundle as a non-root image; it contains no AWS CLI or package manager. Its standalone `scripts/recovery/package-lock.json` is outside the pnpm workspace and is installed only with frozen `npm ci --omit=dev`. The lock follows the same `minimumReleaseAge` of 24 hours as the repository: the reviewed lock was resolved at `2026-07-23T07:36:00.000Z` with registry cutoff `2026-07-22T07:36:00.000Z` using `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --before=2026-07-22T07:36:00.000Z`. Any dependency update must move both timestamps, preserve at least 24 hours between them, regenerate the complete lock with the matching `--before` cutoff, and run `node scripts/security/verify-npm-lock-release-age.mjs --lock scripts/recovery/package-lock.json --manifest scripts/recovery/package.json`; that verifier enumerates every unique package version in the lock, reads its npm registry publication time, and fails closed if any timestamp is missing, unreachable, invalid, or later than the fixed cutoff. The resulting image must also pass the Recovery SBOM, OSV, license, and vulnerability gates. Publish that image to the immutable `aeostudio-recovery` ECR repository, record its manifest as `aeostudio-recovery@sha256:<64-hex-digest>`, and pass only that digest as the staging `recovery_image_digest` OpenTofu variable. Rebuilding or selecting an image inside the drill workflow is not permitted.

Before a run, a separately authorized recovery-data preparer writes a short-lived, non-secret JSON contract to `/aeostudio/staging/recovery/restore-drill-input`. The contract expires within one hour and has this shape:

```json
{
  "schemaVersion": "aeostudio.restore-drill-input.v1",
  "environment": "staging",
  "expiresAt": "2026-07-23T04:15:00.000Z",
  "rds": {
    "markerId": "123e4567-e89b-42d3-a456-426614174000"
  },
  "s3": {
    "markerChecksumSha256": "<base64-sha256>",
    "markerKey": "recovery/markers/<marker>.json",
    "markerVersionId": "<exact-source-version>",
    "recoveryPointArn": "arn:aws:backup:ap-southeast-1:<account>:recovery-point:continuous-<id>",
    "restoreTime": "<approved-UTC-instant>"
  }
}
```

The protected GitHub environment is `restore-drill-staging`. Configure `AWS_ACCOUNT_ID`, `AWS_STAGING_RESTORE_DRILL_OPERATOR_ROLE_ARN`, `AWS_STAGING_RESTORE_DRILL_STATE_MACHINE_ARN`, and `AEO_STAGING_RESTORE_EVIDENCE_BUCKET` as environment variables. Its OIDC subject must be the exact repository plus `environment:restore-drill-staging`; the operator can start and observe only the fixed state machine. It may list only the audit bucket's `restore-drills/` versions and read only `restore-drills/*` object versions. Because those objects use SSE-KMS, the role also has exact-key `kms:Decrypt` constrained to S3 and the audit bucket encryption context. It has no evidence write or delete action.

Dispatch `.github/workflows/restore-drill.yml` from `main`. The state machine—not workflow input—selects the immutable task definition, task and execution roles, both private subnets, the dedicated security group, and `AssignPublicIp=DISABLED`. It exposes no command, role, environment, subnet, security-group, or public-IP override. Only the ECS task role may read the exact database credential secret; neither GitHub nor the execution/operator roles can read it.

The task derives a unique drill and restored-database identifier from its ECS task ARN, then requires both the ECS metadata `Image` and manifest `ImageID` to match the approved repository and digest before it runs the fixed restore script. It conditionally creates exactly one KMS-encrypted object at `s3://<staging-audit-bucket>/restore-drills/<ecs-task-id>.json`. A duplicate key fails because the upload uses `If-None-Match: *`. The workflow snapshots key plus `VersionId` before and after the broker run and fails closed unless there is exactly one new version. It downloads that exact immutable version and accepts it only when the schema is `aeostudio-restore-drill.v1`, the environment is `staging`, the outcome is `PASSED`, the `drillId` equals the task ID encoded in the key, every RPO value is between 0 and 15 minutes, and RTO is between 0 and 4 hours.

A successful workflow publishes `restore-drill-evidence-<workflow-run-id>-<run-attempt>`. It contains the original `restore-drill.json`, `restore-drill.json.sha256`, and `restore-drill-evidence-manifest.json`. Verify the payload from the artifact directory with `sha256sum -c restore-drill.json.sha256`. The manifest schema is `aeostudio.restore-drill-artifact.v1`; it binds the evidence bucket, key, immutable `VersionId`, task ID, evidence SHA-256, repository, `sourceSha`, restore workflow run ID, and run attempt. A separate execution-envelope artifact is diagnostic only and is never sufficient promotion evidence. The workflow never reads the database credential and cannot write or delete task evidence.

A production promotion consumes, but never runs, this staging restore. Given an explicit restore workflow run-id, it must read that GitHub Actions run, require the workflow path to be `.github/workflows/restore-drill.yml`, require a successful `main` run whose head SHA equals the promotion candidate, and derive the run attempt from that run record. It then downloads the one non-expired artifact named `restore-drill-evidence-<workflow-run-id>-<run-attempt>` from that same run. Promotion must verify the checksum, the manifest's run ID, run attempt and `sourceSha`, and the original evidence thresholds above. It must not accept a similarly named artifact from another run, an execution envelope, or caller-supplied evidence JSON.

Production restore execution is forbidden: the production module does not receive a recovery image or operator role, every runner resource is gated to `environment == "staging"`, and the workflow has no production input or role path. Provisioning or running the plane still requires an approved OpenTofu apply and protected-environment dispatch; adding these files performs neither action.
