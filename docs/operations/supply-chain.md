# AEOStudio delivery and supply-chain runbook

## Release invariants

A release is one source commit, one GitHub build run/attempt, and exactly four immutable private-ECR references: ADOT, API, Web, and Worker. Tenant Data Broker uses the exact Worker repository and digest; it is never built or promoted as a fifth image. The `release-digests.json` artifact is the build-once manifest. Tags are informational; privileged operations use `image@sha256` references.

Production may promote only the same four digests that passed staging. It downloads the signed build artifact and `staging-release-contract-<run>-<attempt>`, then proves that the immutable staging contract and smoke envelope match the source SHA, build run, build attempt, and all four independent digests. Runtime evidence carries a fifth `tenantDataBroker` binding that must equal the Worker digest.

Every pull request, merge queue, and main push runs pinned OpenTofu 1.11.6 formatting, backend=false initialization, and validation without AWS credentials. A separate protected staging-plan job is eligible only on a non-fork main push. It uses GitHub OIDC and an explicitly read-only plan role; when the role or reviewed backend/variable inputs are absent it uploads `NOT_RUN` status evidence instead of fabricating a plan. A configured run uploads only redacted change metadata, the plan digest, actual AWS account identity, and a source-bound static-policy decision; it never uploads the binary plan or raw inputs. CI never runs `tofu apply`; infrastructure apply remains separately reviewed.

No automatic ECR lifecycle expiry is configured. A digest may still be referenced by a current or rollback task definition, and an OCI attestation may be an untagged referrer. Cleanup must separately prove a digest is absent from every active and retained immutable release contract and that its OCI attestations are no longer required. The safe default is indefinite retention.

## GitHub controls

Configure these environments before enabling delivery:

1. Protect main and require application, security, and review gates.
2. Create staging, limited to main.
3. Create production, limited to main, with an independent required reviewer and no self-review.
4. Create bootstrap-staging and bootstrap-production with the same protected-review rule.
5. Create staging-plan, limited to main, with only the read-only plan role and reviewed plan inputs below.
6. Protect workflow and infrastructure changes with CODEOWNERS.
7. Retain manifest, attestation, contract, smoke, bootstrap, plan, and change-ticket evidence for at least 90 days.

Required variables:

| Variable | Scope and purpose |
| --- | --- |
| AWS_ACCOUNT_ID | Repository-level exact AWS account |
| AWS_STAGING_BUILD_ROLE_ARN | Repository-level aeostudio-staging-image-builder |
| AWS_RELEASE_VERIFY_ROLE_ARN | Repository-level main-ref, ECR-read-only verifier |
| AWS_STAGING_PLAN_ROLE_ARN | staging-plan environment, OIDC role limited to state and provider read operations |
| AEO_STAGING_BACKEND_BUCKET | Repository-level exact S3 bucket name shared by staging-plan canonicalization and promotion validation |
| AWS_STAGING_DEPLOY_ROLE_ARN | staging environment deploy client |
| AWS_STAGING_ACCEPTANCE_ROLE_ARN | staging-acceptance environment, read-only CloudWatch Logs/alarm-history and X-Ray query role; it has no `SetAlarmState` permission |
| AWS_STAGING_RESTORE_DRILL_OPERATOR_ROLE_ARN | restore-drill-staging environment, client for the fixed private restore workflow |
| AWS_STAGING_RESTORE_DRILL_STATE_MACHINE_ARN | Exact fixed Singapore restore state machine |
| AWS_PRODUCTION_DEPLOY_ROLE_ARN | production environment deploy client |
| AWS_STAGING_BOOTSTRAP_OPERATOR_ROLE_ARN | bootstrap-staging protected operator |
| AWS_PRODUCTION_BOOTSTRAP_OPERATOR_ROLE_ARN | bootstrap-production protected operator |
| AEO_BOOTSTRAP_COMPLETE | Environment-level exact string true only after bootstrap and scale-up |
| AEO_STAGING_BASE_URL / AEO_PRODUCTION_BASE_URL | HTTPS smoke origins |
| AEO_STAGING_APPROVED_HOST | Exact hostname allowed by the authenticated load profile |
| AEO_STAGING_COGNITO_ORIGIN | Exact HTTPS origin of the staging Cognito managed-login domain |
| AEO_STAGING_SMOKE_TENANT_ID | Synthetic staging tenant only |
| AEO_STAGING_SMOKE_WORKSPACE_ID | Synthetic staging workspace only |
| AEO_STAGING_SMOKE_PREREQUISITE_PROFILE_ID | Synthetic Profile aggregate with an owned Site baseline; the smoke creates a new revision |
| AEO_STAGING_SMOKE_PREREQUISITE_BASELINE_ID | Completed synthetic Site baseline bound to that Profile |
| AEO_STAGING_SMOKE_SYNTHETIC_CHANNEL_KEY / AEO_STAGING_SMOKE_SYNTHETIC_ADAPTER_VERSION_ID | Reviewed production adapter route limited to the controlled staging receiver |
| AEO_STAGING_SMOKE_MANUAL_PROVIDER_KEY / AEO_STAGING_SMOKE_MANUAL_SURFACE_KEY | Reviewed-manual measurement Surface used by the synthetic evidence run |
| AEO_STAGING_SMOKE_MANUAL_ADAPTER_VERSION / AEO_STAGING_SMOKE_MANUAL_TERMS_VERSION | Exact pre-approved measurement policy contract |
| AEO_STAGING_RESTORE_EVIDENCE_BUCKET | Exact Object-Lock evidence bucket for immutable restore artifacts |
| AEO_SYNTHETIC_FAULT_APPROVED | staging-acceptance opt-in; exact `true` only for the frozen v2 causal-fault readiness collector |
| AEO_APPROVED_SUPPLY_CHAIN_POLICY_SHA256 | Production approval of the fixed-order container-base plus license-policy manifest hash |
| AEO_LICENSE_APPROVAL_REFERENCE | Named external security/legal approval reference required by production |

The machine-readable scope contract is `scripts/infra/github-environment-contract.json` schema v2. Its local static gate parses every workflow job and its actual protected environment, then requires every `${{ vars.* }}` and `${{ secrets.* }}` reference to exist at repository scope or that job's exact environment scope. Missing configuration is a preflight failure (or the staging-plan workflow's explicit `NOT_RUN` status); it never authorizes AWS/GitHub evidence collection or changes an external evidence gate.

The global bootstrap stack requires `staging_plan_state_bucket_arn` to be one exact S3 bucket ARN; it must equal `arn:aws:s3:::<AEO_STAGING_BACKEND_BUCKET>`. `staging_plan_state_key` is fixed to `aeostudio/staging/opentofu.tfstate`. Its `github_roles.staging_plan` output must be `arn:aws:iam::<AWS_ACCOUNT_ID>:role/aeostudio-staging-plan`, and that exact value is the only permitted `AWS_STAGING_PLAN_ROLE_ARN`.

The protected staging-plan environment contains `AEO_STAGING_BACKEND_HCL` and `AEO_STAGING_PLAN_TFVARS_JSON`. Before requesting GitHub OIDC credentials, the backend parser accepts only the exact `AEO_STAGING_BACKEND_BUCKET`, key `aeostudio/staging/opentofu.tfstate`, region `ap-southeast-1`, `encrypt=true`, and `use_lockfile=true`; it rejects every extra key, endpoint/proxy override, `skip_*` option, credential, profile, and assume-role field, then writes a fixed-order canonical backend. The evidence hashes only this canonical file, and production recomputes the expected canonical hash from the same exact bucket variable before accepting it. These values are unavailable to pull requests and forks. Missing values produce a successful `NOT_RUN` status artifact for diagnosis, but `NOT_RUN`, `FAILED`, a missing artifact, or any non-PASS policy decision blocks production promotion.

The staging environment contains exactly three protected operator secrets—`AEO_STAGING_SMOKE_COGNITO_USERNAME`, `AEO_STAGING_SMOKE_COGNITO_PASSWORD`, and `AEO_STAGING_SMOKE_COGNITO_TOTP_SECRET`—and three distinct protected Reviewer secrets—`AEO_STAGING_SMOKE_REVIEWER_COGNITO_USERNAME`, `AEO_STAGING_SMOKE_REVIEWER_COGNITO_PASSWORD`, and `AEO_STAGING_SMOKE_REVIEWER_COGNITO_TOTP_SECRET`. These identities must belong only to the synthetic staging Workspace, never to a customer or production Tenant. `AEO_STAGING_SMOKE_SYNTHETIC_PUBLICATION_TARGET` is also protected because it describes the reviewed production-adapter target for the controlled non-live receiver. Each identity completes the Cognito authorization-code PKCE and software-token MFA flow in a fresh browser context. HttpOnly session cookies stay only in their browser contexts and are disposed after verification; no persistent session-cookie secret is configured. Staging remains in production runtime mode: no fake runtime flag or fake adapter is permitted. Each reviewed manual measurement must retain the complete approved cohort (`prompts × scopes × repetitions`, at least 60 slots); its one supplied synthetic PASS and every missing `NOT_CHECKED` slot must reconcile with dashboard result, excluded, and per-metric sample counts. Every smoke creates and rereads a new immutable Experiment using the `APPROVED_ARTIFACT` intervention. The controlled receiver result is recorded separately as non-live `REMOTE_APPLIED` and is never represented as a published Artifact intervention; a pre-existing Experiment ID is not an input.

The separate staging-acceptance environment contains `AEO_STAGING_LOAD_TENANTS_JSON` as a protected secret. It describes exactly 10 synthetic Tenants with 10 globally unique session identities/cookies each, never customer credentials. Every authenticated k6 request disables redirects so a staging-origin response cannot forward the Cookie to another origin. Production promotion accepts explicit build, staging-plan, staging-acceptance, and restore workflow run IDs only after proving that every successful run belongs to this repository, uses `main`, shares the same source SHA, and supplies evidence from its exact run attempt.

AEO_BOOTSTRAP_COMPLETE is checked only after the runner enters its protected environment. An unbootstrapped staging build still produces signed artifacts without acquiring deploy credentials; deployment steps intentionally skip. Production fails closed when its protected value is not true.

## OIDC and privilege separation

Trust policies require aud=sts.amazonaws.com and exact GitHub subjects:

- builder and verifier: repo:<owner>/<repo>:ref:refs/heads/main;
- staging plan: repo:<owner>/<repo>:environment:staging-plan;
- staging deploy client: repo:<owner>/<repo>:environment:staging;
- production deploy client: repo:<owner>/<repo>:environment:production;
- bootstrap operators: the matching bootstrap-staging or bootstrap-production environment.

The routine deploy client has no `ecs:RegisterTaskDefinition`, `ecs:RunTask`, `ecs:UpdateService`, `ecs:TagResource`, or `iam:PassRole`. It can read the fixed pointer and immutable contracts, verify the four fixed ECR repositories, inspect task definitions and the exact Tenant Data Broker runtime, start the exact environment release state machine, and observe only its executions.

The trusted release broker alone verifies fixed repositories, captures active revisions, registers five statically defined task definitions, runs the exact migration, updates the four exact services, and restores exact contract rollback revisions. Those definitions are API, Web, Worker, Tenant Data Broker, and Migration. The caller can vary only the four digests and release evidence. It cannot inject a family, repository, role, command, override, environment variable, secret, service, cluster, subnet, security group, or target group.

The bootstrap operator also has no direct ECS mutation or pass-role permission. It reads one static bootstrap contract, verifies exact task definitions, and starts a no-input fixed broker. The broker runs them only while all four services are at zero.

Staging deploy and bootstrap client roles allow three-hour sessions, and the staging release job is bounded to 165 minutes. The production promotion role allows a six-hour session inside a 360-minute GitHub job, but the workflow establishes an earlier absolute deadline at 350 minutes and passes it through every release wait. The release state machine is bounded to 4,200 seconds and each client observation to 4,260 seconds. Before production `FINALIZE`, at least 250 minutes must remain: one 71-minute finalization observation, two 71-minute reconciliation observations, 25 minutes for terminal evidence, and a 12-minute safety margin. The worst-case pre-gate step ceiling is 157 minutes, which also fits before the 179-minute recovery reserve. Production cleanup is bounded to 150 minutes. Bootstrap remains bounded to 2,100 seconds, with a 2,250-second client wait inside a 50-minute job.

## Build, staging, and production flow

The main workflow runs deterministic verification plus OSV, Gitleaks, Trivy, and backend-free OpenTofu gates. Its source CycloneDX inventory comes from pnpm's installed frozen graph (`pnpm sbom`, never lockfile-only); unsupported optional-platform packages are omitted from that source decision and the exact Linux runtime images are checked separately. On a trusted main push, the protected staging-plan job either records `NOT_RUN` with its missing prerequisites or creates a real, unlocked, read-only staging plan and uploads a redacted resource-action summary. It builds each application image once under a unique `run-<run-id>-<attempt>` tag and mirrors the pinned complete ADOT multi-platform index into private ECR without digest drift. Every promoted digest is scanned, gets a CycloneDX inventory, and receives provenance and SBOM attestations.

Each exact image keeps the complete Syft CycloneDX inventory for OSV, attestation, and investigation. The application-license decision is derived from that same image SBOM and accepts only third-party npm package-root manifests physically installed below `/workspace`; nested fixture manifests, file records, the first-party `@aeostudio` namespace, and base-image tooling are not silently reclassified as application dependencies. A selected runtime package without an exact versioned purl or license fails closed. The filtered runtime inventories, license decisions, full image/SBOM OSV results, and one SHA-256 binding file are retained together. The Node/Debian base remains pinned by digest and is covered by the full exact-image scan; changing that digest requires a fresh named security/legal review rather than broadening the npm allowlist.

Before deployment, staging verifies both attestations for all four digests. `DEPLOY_START` rechecks all four fixed ECR repositories and immediately records the Standard execution ARN. An ADOT destination digest that differs from the pinned upstream index fails before service deployment. `DEPLOY_WAIT` waits for the broker and verifies the immutable contract plus the images in all five registered task definitions.

The broker migrates before service activation, verifies all four services, and checks the API, Web, and private Tenant Data Broker target groups. Target groups use a 30-second deregistration delay. Every service and target group has an independent bounded retry budget. Two healthy plus draining targets is not accepted; the broker waits for exactly two healthy targets.

Before public browser smoke, a separate OIDC-authorized verifier checks the exact Tenant Data Broker service, task definition, two running tasks, two healthy target registrations, Worker digest, and the Linux/amd64 child digest of the private ADOT index. Its evidence contains a strictly task-ARN-sorted row for every task with both runtime digests. Browser smoke then runs with AWS credentials explicitly cleared and checks health, readiness, login, and a sealed experiment. The `aeostudio.staging-smoke-envelope.v1` file binds results to source SHA, build run/attempt, four independent digests, the Broker-equals-Worker digest, and the full Broker runtime evidence. `FINALIZE` changes `AWAITING_SMOKE` to `DEPLOYED` and clears locks.

A started release that is not finalized runs `CLEANUP` under `always()`. Both that client and the release watchdog start or adopt exactly one deterministic `reconcile-${ReleaseId}` `RECOVER` execution with the exact three-key input `{Mode:"RECOVER",ReleaseId,DeployExecutionArn}`. They observe an active `FINALIZE` first, reject any execution/input/claim drift, and never create UUID or automatic `ROLLBACK` children. The shared recovery converges an unfinalized `AWAITING_SMOKE` release to rollback, completes an authorized partial finalization when its exact three hashes are present, and removes only terminal coordination proven by the generation-fenced records. A lost `StartExecution` or DynamoDB claim response is adopted only by exact name, ARN, input and own-claim evidence. GitHub force-cancel may suppress cleanup, so remaining locks are intentionally fail-closed.

Production accepts only a successful build workflow whose application, security, build, and staging jobs all succeeded. It also consumes the caller-selected successful `Verify` run, checks the exact staging-plan job attempt, downloads only `staging-opentofu-plan-evidence-<run>-<attempt>`, and validates schema v2 account/repository/source/run identity, Singapore region, plan SHA-256, source-tree hash, and PASS decisions for region, cross-region replica, broad IAM action, and forbidden-resource gates. Before protected approval it verifies all attestations, the exact manifest identity, the immutable staging contract, and the full staging smoke envelope. After approval it uses the same start, wait, smoke, finalize, and cleanup lifecycle. Production smoke calls only `/health` and `/ready` and uses no tenant data. Immediately before `FINALIZE`, it creates and downloads an immutable candidate artifact, proves its exact file inventory and digest, then re-reads the selected GitHub runs, attempts, artifacts and protected-environment evidence. The broker receives exactly the finalization-evidence, GitHub-environment and promotion-control-plane SHA-256 values. A deployed terminal then produces a self-contained 14-file finalized receipt artifact, retries its upload within the bounded tail, downloads it and verifies its exact inventory, archive digest and byte parity. Only the exact `FINALIZE` or `reconcile-${ReleaseId}` terminal observer may select the deployed result.

The GitHub candidate/final receipt and the AWS lifecycle transition are independently durable systems, not a cross-system atomic transaction. The verified candidate before `FINALIZE`, deterministic recovery, self-contained finalized artifact and exact post-upload download check narrow that evidence gap, but an administrator with separate artifact-deletion authority remains an external operational risk.

## Records and normal lock lifecycle

The broker owns two read models and one atomic coordination record:

| Record | Meaning |
| --- | --- |
| SSM `/aeostudio/<env>/release-contract` | Exact JSON release pointer: `UNINITIALIZED`, `AWAITING_SMOKE`, `DEPLOYED`, or `ROLLED_BACK` |
| SSM `/aeostudio/<env>/releases/<release-id>` | Immutable broker contract written with `Overwrite=false` |
| DynamoDB `aeostudio-<env>-release-control`, `CoordinationKey=ENVIRONMENT` | Generation-fenced environment lock, lifecycle claim, and pointer tuple |

The DynamoDB item is the concurrency authority. `Generation` is monotonic. An active deployment owns the exact `LockOwner` execution ARN, `ReleaseId`, `ContractName`, and `Phase`; a lifecycle operation owns `ClaimOwner` and `ClaimMode`. For a contract-ready release, `PointerStatus`, `PointerReleaseId`, and `PointerContractName` must match the exact SSM pointer and immutable contract. `PREPARATION_ABORTED` is a DynamoDB-only terminal marker for a generation that failed before the immutable contract existed and therefore does not replace the prior SSM pointer. Every transition uses a conditional `UpdateItem` over the full owner/release/contract/generation/phase tuple, then reads the item back consistently. A malformed DynamoDB AttributeValue is rejected, never treated as an absent field.

DEPLOY retains `LockOwner` at `AWAITING_SMOKE`. FINALIZE or an explicit successful ROLLBACK requires the SSM pointer, DynamoDB pointer tuple, lock tuple, immutable contract, release ID, environment, and generation to agree before atomically claiming the lifecycle operation. A successful terminal transition updates the pointer tuple and removes the lock and claim attributes in the same generation-fenced write. By contrast, failed DEPLOY compensation records `ROLLED_BACK`, returns a failed execution, and deliberately retains the environment lock for explicit recovery. Incomplete reconciliation also leaves coordination owned and therefore fail-closed.

## Fail-closed recovery and break glass

Routine deploy identities can consistently read the one coordination item but cannot mutate or delete it directly. Do not use an ad-hoc DynamoDB `UpdateItem`/`DeleteItem` or delete either SSM record to clear a release. The state machines own every conditional transition; DynamoDB point-in-time recovery and the immutable SSM contract are preserved for incident evidence.

1. Consistently read `aeostudio-<env>-release-control` at `CoordinationKey=ENVIRONMENT`; preserve the full typed item and `Generation`.
2. Read and preserve the SSM pointer and the immutable contract named by `ContractName` or `PointerContractName`.
3. Describe the exact Step Functions execution in `LockOwner`; if `ClaimOwner` exists, describe that exact lifecycle execution too.
4. Confirm release ID, contract name, pointer tuple, generation, environment, broker ARN, and execution names all agree. A wrong DynamoDB type or partial tuple is an incident, not an absent lock.
5. Never start a second release, manually remove fields, or reuse an execution name while either owner is `RUNNING` or any tuple is ambiguous.

Release IDs are restricted to 1–70 characters from `[A-Za-z0-9_-]`; the ten-character `reconcile-` prefix therefore remains within the Step Functions 80-character execution-name limit. Use exactly one broker case:

- Deploy `FAILED`, `TIMED_OUT`, or `ABORTED` with an exact immutable contract: invoke `RECOVER`; the broker conditionally takes over only a matching terminal claim.
- Deploy `SUCCEEDED` with the exact pointer at `AWAITING_SMOKE`: use normal `FINALIZE` only with approved smoke evidence. Workflow `CLEANUP` and the watchdog otherwise adopt the single deterministic `RECOVER`, which performs the rollback branch inside that shared execution. A separately authorized operator may still invoke explicit `ROLLBACK`; the automated controls do not create a second rollback child.
- A terminal lifecycle execution left a claim or lock: invoke `CLEANUP`/watchdog reconciliation for the same release. Both adopt the same deterministic `RECOVER`, verify the terminal pointer and exact generation, and remove coordination only after convergence; operators do not remove fields first.
- Pointer `DEPLOYED` or `ROLLED_BACK` with no owners: the release is already terminal only when the SSM and DynamoDB pointer tuples agree exactly. `PREPARATION_ABORTED` is terminal only when both owners are absent and its release/contract/generation tuple matches the failed preparation; the prior SSM pointer is intentionally unchanged.
- An immutable contract is absent, an owner execution cannot be found, a typed attribute is malformed, or the generation/tuple changed between reads: retain the item, prohibit promotion, and escalate. `CLEANUP_NOT_STARTED` is valid only when neither the exact lock nor an exact lifecycle claim exists.

Example after all required checks and approved stale-claim removal:

~~~text
node scripts/release/run-release-broker.mjs --mode RECOVER --environment staging --region ap-southeast-1 --expected-account-id <account-id> --release-id <release-id> --execution-name reconcile-<release-id>
~~~

Never blind-delete coordination, never reuse an execution name, and never infer safety only from a workflow conclusion.

## Reviewed immutable inputs

Dockerfiles pin the reviewed Node 24 base by digest and switch to the unprivileged node user. External Actions are pinned to full commit SHAs and recorded in scripts/security/action-pins.json. Updating an Action, scanner image, base image, role policy, broker definition, or timeout requires review and fresh staging evidence.
