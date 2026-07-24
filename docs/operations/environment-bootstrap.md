# Environment bootstrap runbook

## Invariant

A new staging or production environment starts with all four ECS services at desired count zero. The one-off bootstrap task reads the RDS-managed master secret inside the private VPC, creates separate least-privilege login principals, and seeds only the seven precreated Secrets Manager resources. The exact API image then runs the database migrations. A second reviewed OpenTofu apply is the only action that scales Web, API, Worker, and Tenant Data Broker to two tasks each.

No secret value enters OpenTofu state, a command line, or CloudWatch Logs. OpenTofu and the operator command handle only ARNs, resource IDs, and image digests. The bootstrap process logs only generic success or failure codes. Target-role passwords are converted client-side to PostgreSQL SCRAM-SHA-256 verifiers, so raw target passwords never enter SQL, bind parameters, server error context, or PostgreSQL statement logs. Secrets Manager request bodies are never logged.

The seven seeded resources are:

- `runtime_database_url` for `aeostudio_app_login`, which inherits `aeostudio_runtime`;
- `lifecycle_database_url` for `aeostudio_lifecycle_login`, which inherits `aeostudio_lifecycle_worker`;
- `admin_database_url` for the migration-only `aeostudio_migration_login`;
- `tenant_data_broker_database_url` for the isolated `aeostudio_tenant_data_broker_login`;
- `tenant_data_broker_hmac_key_ring`;
- `session_encryption_key`;
- `deletion_receipt_signing_key`.

Every platform principal, including the migration-only login, remains `NOBYPASSRLS`. The
migration login owns migrated tables and functions but is never supplied to Web, API, Worker,
or Tenant Data Broker services. Each forced-RLS Tenant table has one explicit permissive policy granted only
to the exact migration owner, with `USING (true)` and `WITH CHECK (true)`. This lets governed
migration-owned `SECURITY DEFINER` worker functions perform cross-Tenant claims without a
superuser or `BYPASSRLS` credential.

This is a schema invariant: every future migration that introduces a `public` table with
`tenant_id` and `FORCE ROW LEVEL SECURITY` must create the same exact-owner policy in that
migration. Every new `SECURITY DEFINER` function must also revoke PUBLIC `EXECUTE` before the
migration commits and grant execution only to its exact runtime group.

Every `SECURITY DEFINER` function in the `public` schema has PUBLIC `EXECUTE` revoked. Migrations
grant execution back only to the exact runtime or lifecycle group that owns the operation.

The role/bootstrap path is integration-tested on PostgreSQL 18.3 with a non-superuser,
`CREATEDB`/`CREATEROLE`, `NOBYPASSRLS` operator, including a second idempotent run. A live RDS
staging bootstrap and retry remain required release evidence; local PostgreSQL evidence does
not mark that external check complete.

Every password and key is a distinct random 32-byte base64url value. A database session advisory lock is held from before the seven target secrets are read until every required `PutSecretValue` has completed. Concurrent or retried bootstrap tasks therefore reuse the winning values instead of creating a database/secret mismatch.

## Prerequisites

- The global bootstrap state and the environment backend already exist.
- The approved environment variable file supplies all normal platform inputs and exact `sha256:` image digests. It contains no secret values.
- The API digest exists in the shared `aeostudio-api` ECR repository and is the digest intended for both bootstrap and initial migrations.
- The protected `bootstrap-staging` or `bootstrap-production` GitHub environment is configured with its exact bootstrap-operator role. That role can read the static bootstrap contract and start/observe only the fixed bootstrap broker; it has no direct ECS mutation or pass-role permission.
- Repository dependencies are installed with `pnpm install --frozen-lockfile`.

The examples below use staging. For production, substitute the production directory, environment name, approved account, backend, and variable file.

## 1. Apply the zero-service environment

From `infra/environments/staging`, initialize the reviewed backend and create a saved plan. Keep the bootstrap flag explicit even though its safe default is false:

```powershell
tofu init -backend-config=backend.hcl
tofu plan -var-file=environment.tfvars -var=bootstrap_complete=false -out=bootstrap-zero.tfplan
tofu apply bootstrap-zero.tfplan
```

Inspect the non-secret deployment output and confirm Web, API, Worker, and Tenant Data Broker each have desired count zero. Do not continue if any service has a running or pending task.

```powershell
$deployment = tofu output -json deployment | ConvertFrom-Json
$deployment | ConvertTo-Json -Depth 4
```

This first apply creates the empty Secrets Manager resources, RDS managed master secret, exact-digest bootstrap and migration task definitions, private subnets, and the migration security group. It does not launch an application service.

## 2. Run the private bootstrap and exact-digest migration

Preferred path: dispatch `Bootstrap an environment with an attested API image` from `main`. Supply the environment, the successful main-branch build run ID, and the approved change ticket. Before protected approval, the workflow requires successful verification, security, and build jobs and verifies the API provenance and CycloneDX attestations. The source build may have intentionally skipped staging deployment while `AEO_BOOTSTRAP_COMPLETE` was false.

The protected job checks that the static OpenTofu bootstrap contract uses the same API digest, validates both exact task definitions, starts the no-input bootstrap broker, and waits for completion. It never calls ECS `RunTask` directly and cannot supply a command, role, override, subnet, security group, or secret.

For an approved operator diagnosis using the same client, set only non-secret identifiers. The credentials must be for the exact bootstrap-operator role, and the digest must match both the signed build manifest and reviewed OpenTofu input:

```powershell
$environment = 'staging'
$accountId = $env:AWS_ACCOUNT_ID
$apiDigest = $env:AEO_API_IMAGE_DIGEST
$executionName = "bootstrap-$environment-<approved-change-id>"

node ../../../scripts/bootstrap/run-bootstrap.mjs `
  --environment $environment `
  --region ap-southeast-1 `
  --expected-account-id $accountId `
  --expected-api-digest $apiDigest `
  --execution-name $executionName `
  --confirm "bootstrap:$environment" `
  --output-evidence bootstrap-evidence.json
```

The client fails closed unless the static contract and both task definitions belong to the expected account, region, and environment; both tasks use the exact API digest and commands; task and execution roles are exact; the bootstrap task has no ECS secret injection; and its environment contains only the governed secret ARNs. The broker independently requires all services at zero, launches the exact private bootstrap task, requires one named container with exit zero, then does the same for migration.

The evidence file contains the contract, broker execution ARN/status, and sanitized bootstrap/migration task ARN, exact task-definition ARN, container name, and exit code. It contains no secret value.

On any failure, leave services at zero and do not set the release variable. Correct the cause and rerun this same command. Existing valid secret values are reused, so retry does not rotate a partially completed bootstrap.

## 3. Re-apply to scale services

Only after the broker reports `BOOTSTRAP_AND_MIGRATION_COMPLETE` and the evidence contains two exit codes of zero, create and review the scale-up plan:

```powershell
tofu plan -var-file=environment.tfvars -var=bootstrap_complete=true -out=bootstrap-complete.tfplan
tofu apply bootstrap-complete.tfplan
```

Confirm the plan changes each ECS service from desired count zero to two and does not replace the database, secrets, network, or task roles. Wait for all four services to become stable and verify the environment health endpoint.

## 4. Open the release gate

After the reviewed scale-up apply and stability check, set `AEO_BOOTSTRAP_COMPLETE=true` in the protected `staging` or `production` GitHub environment. The staging workflow reads it only after entering that environment, before acquiring deploy credentials. Production fails closed unless it is true. Keep it unset or false for every unbootstrapped environment.

Attach the saved-plan approvals and `bootstrap-evidence-<environment>-<run>-<attempt>` artifact to the change ticket. Record both one-off task ARNs and exit codes, the exact API digest, scale-up apply, and environment-variable change. Never attach secret values or database URLs.
