# Design 设计文档（umbrella）: Multi-Tenant AEO/GEO/SEO Optimization Platform

> 这是对外 `@` 入口之一。下游编程 agent 用 `@docs/goal/DESIGN.md` 加载本文件，并通过下方链接按需展开细节。

## Related Documents

- 需求：[`REQUIREMENTS.md`](./REQUIREMENTS.md)
- 验收：[`ACCEPTANCE.md`](./ACCEPTANCE.md)
- 影响面：[`IMPACT.md`](./IMPACT.md)
- 决策记录：[`DECISIONS.md`](./DECISIONS.md)
- 任务拆分：[`TASKS.md`](./TASKS.md)
- 系统架构：[`../system/ARCHITECTURE.md`](../system/ARCHITECTURE.md)
- 模块边界：[`../system/MODULE_MAP.md`](../system/MODULE_MAP.md)
- 数据流：[`../system/DATA_FLOW.md`](../system/DATA_FLOW.md)
- 风险区：[`../system/RISK_AREAS.md`](../system/RISK_AREAS.md)

## Tech Stack 技术栈

| 维度 | 选型 | 版本约束 | 选型理由 | 淘汰候选 + 原因 |
|---|---|---|---|---|
| Language | TypeScript strict | `6.0.x` | Web/API/Worker/contract 共享类型与工具链 | Python-first：权限/契约双栈漂移；Java：首期交付成本高 |
| Runtime | Node.js LTS | `24.x`，生产 image 锁 patch digest | 与 TS/Next/Nest 当前稳定线一致 | Node Current：升级频繁；EOL major：无安全维护 |
| Web | Next.js App Router + React | Next `16.2.x`，React `19.2.x` | SSR、BFF/session boundary 与企业 UI | Next-only backend：长任务耦合；SPA-only：session/SSR 边界变弱 |
| API | NestJS + Fastify | Nest `11.x`，Fastify `5.x` | module/policy/OpenAPI 结构化，同时保持高效 HTTP | Express：吞吐与 schema integration 较弱；FastAPI core：双语言 |
| Worker | Nest standalone application | `11.x` | 与 API 共用 application/domain，同时独立扩缩 | Web background task：请求生命周期不可靠；独立微服务：过早拆分 |
| Repository | pnpm workspace + Turborepo | pnpm `11.x` exact；Turbo `2.x` | deterministic lockfile、任务图与缓存 | npm/Yarn 混用：workspace/lockfile 分裂；Nx：MVP 功能过重 |
| Contracts | Zod + nestjs-zod + openapi-typescript | Zod `4.x`、nestjs-zod `5.x`、openapi-typescript `7.x` | runtime/TS/OpenAPI/JSON Schema 单一真源 | class DTO + 手写 schema：漂移；compile-time-only types：无 runtime guard |
| Tests | Vitest + Fastify inject + Testcontainers + Playwright | Vitest `4.1.x`、Playwright `1.61.x`，其他锁 exact | 快速 unit/API、真实依赖 integration、真实浏览器 path | Jest 并存：双配置；内存 DB：语义不一致；live Provider CI：不稳定 |
| Type/Lint/Format | `tsc --noEmit` + ESLint flat + Prettier | TS `6.0.x`、ESLint `10.x`、Prettier `3.9.x` exact | strict static gate 和统一格式 | Biome-only：生态规则/版本适配风险；仅 framework lint：覆盖不足 |
| Primary DB | Amazon RDS PostgreSQL Multi-AZ | PostgreSQL `18.x` | ACID、RLS、JSON、FTS、extension、PITR | 自管 Postgres：恢复负担；NoSQL primary：关系/审批/lineage 不匹配 |
| Data Access | Kysely + node-postgres | Kysely `0.29.x`、`pg 8.x` | type-safe explicit SQL，便于 RLS/extension/复杂查询 | Prisma：RLS/extension 需大量旁路；Drizzle 1.0 beta：稳定性不足；TypeORM：隐式行为 |
| Search | PostgreSQL FTS + `pg_trgm` + `pgvector` | RDS-supported `pgvector 0.8.x` | MVP 单事务、Tenant filter 一致、成本低 | OpenSearch dual-write：复杂/昂贵；纯 vector：keyword/filters 不足 |
| Queue/Scheduler | SQS Standard + DLQ + EventBridge Scheduler | AWS managed API | 原生 at-least-once、Multi-AZ、低运维 | BullMQ/Redis：额外 durable cluster；Kafka：规模不匹配 |
| Object/Secrets | S3 + KMS + Secrets Manager | AWS managed API | versioning/lifecycle/Object Lock 与独立 Secret Vault | MinIO/Vault 自管：运维；secret in DB/state：边界违规 |
| Identity | Cognito Essentials + `openid-client` | Cognito managed service；openid-client `6.8.x` | PKCE、passkey/TOTP、regional user pool、OIDC standard | 自建密码/Keycloak：安全运维；Cognito groups RBAC：scope 漂移 |
| Observability | OpenTelemetry JS + ADOT + Pino + CloudWatch/X-Ray | OTel JS `2.x`、Pino `10.x` | vendor-neutral instrumentation，数据留新加坡 | 外部 APM 默认上送：跨境；console logs：不可查询/关联 |
| Deploy | OCI/ECR + ECS Fargate + ALB | image digest；Fargate current platform | 独立进程扩缩、managed compute | EKS/Kubernetes：运维面过大；Vercel-only：Worker/data boundary 不匹配 |
| IaC | OpenTofu | `1.11.x` exact | 可审查、remote state、ephemeral-sensitive 能力 | 手工 Console：不可复现；Terraform BUSL：license policy 风险 |
| CI/CD | GitHub Actions + AWS OIDC | Actions 固定 commit SHA | PR gates、短期云凭证、environment approval、attestation | 长期 AWS keys：难轮换；prod auto-deploy：审批不足 |

### 技术栈约束 Constraints

- `packageManager`、direct dependency、tool、GitHub Action 与 production image 必须 exact pin；升级通过独立 PR。
- pnpm 保持 `minimumReleaseAge ≥ 1440`、`trustPolicy=no-downgrade`、signature audit 与 lifecycle script allowlist。
- 自动允许 MIT/Apache-2.0/BSD-2/3-Clause/ISC/0BSD；高风险、未知、copyleft/source-available/proprietary 按 [`QUESTIONS.md`](./QUESTIONS.md#q-008d--identity-observability-delivery-and-supply-chain-policy) 的 policy 阻断或 legal review。
- 禁止引入 EKS、OpenSearch、Redis/BullMQ、跨区域 replication、外部 telemetry SaaS 或真实 payment processor，除非先修改已确认设计并重新审批。
- Node/框架 major 到 EOL 前必须建立显式升级任务；不能在实现中静默跨 major。

## Current System Context

Greenfield — 当前没有应用代码。原始 Playbook 与 `docs/goal/*` 是 source of truth；`docs/system/*` 描述目标边界。

### Greenfield Assumptions

- 已知输入：Tenant 用户、Company/Brand/Profile、Offering、授权 Site、Evidence、Provider/Channel authorization。
- 已知输出：Prompt Set、Claim Ledger、Content Plan、三类 Artifact、Channel Package、PublicationRecord、PromptRun、MetricSnapshot、Experiment、Audit Evidence。
- 已知 SLO：read 500 ms、write 1 s、job ack 2 s、queue start 30 s、99.5%、RPO 15 min、RTO 4 h。
- 已知部署：AWS Singapore 双 AZ；实际 account/domain/ARN 是 environment parameter，不是 blocking product decision。
- Blocking unknowns：None。

## Proposed Architecture

采用 modular monolith：一个 monorepo、共享 domain/application/contracts，Web/API/Worker 三个独立进程。API 是所有业务 state transition 的入口；Worker 只执行已创建的 Job。PostgreSQL 是事务真源，S3 是大型 Artifact/evidence payload，Secrets Manager 是 Connector secret vault，SQS 是 at-least-once transport。

关键深模块：

- `TenantContext`：把 identity、active membership、Workspace scope、DB transaction-local RLS context 绑定为一个不可分割的 request/job boundary。
- `ArtifactLedger`：以 append-only revision、hash、sourceArtifactIds、Claim map 管理 lineage；不暴露任意 status setter。
- `PublicationCoordinator`：eligibility、budget reservation、approval hash、idempotency、remote reconciliation 与 rollback record 的唯一入口。
- `MeasurementEngine`：scenario compatibility、Provider/Surface execution、raw evidence 与 denominator semantics 的唯一入口。
- `AdapterRegistry`：capability、auth scope、terms、region/retention/training/subprocessor 与 health 的 versioned registry。

## Module Responsibilities

| Module | Responsibility | Public Interface | Notes |
|---|---|---|---|
| `identity-access` | Session identity、Membership、RoleBinding、break-glass | `authorize(actor, action, resourceScope)` | Cognito group 不参与业务 RBAC |
| `profile-offering` | Profile/Offering/dynamic attribute revision | Commands/queries + Zod contracts | 禁止 industry closed enum |
| `site-crawl` | ownership、crawl policy、snapshot/baseline | `VerifySite`, `StartCrawl`, `GetBaseline` | SSRF boundary |
| `evidence-claims` | Evidence Source、Claim revision/review/expiry | `ProposeClaim`, `ReviewClaim` | Approved Claim 才供 Writer |
| `prompt-research` | Prompt Set、taxonomy、scope/scenario approval | `CreatePromptSet`, `ApprovePromptSet` | 20–50 prompt、1–3 scope |
| `content-planning` | opportunity scoring、Content Plan/Brief | `GeneratePlan`, `ApproveBrief` | cross-reference 必须可解析 |
| `artifacts` | envelope、payload、lineage、revision、approval | `CreateRevision`, `SubmitReview`, `ReviewRevision` | content-addressed hash |
| `channels-publishing` | package、registry eligibility、publish/reconcile | `BuildPackage`, `CheckEligibility`, `Publish` | exactly-once external effect |
| `measurement` | run、raw evidence、metrics、snapshot、experiment | `StartRun`, `BuildSnapshot`, `CompareExperiment` | scenario compatibility gate |
| `jobs-budgets` | queue state、retry、heartbeat、reservation/settlement | `SubmitJob`, `ReserveBudget`, `SettleUsage` | per-Tenant concurrency 5 |
| `privacy-audit` | retention/export/delete/legal hold/audit digest | `ExportTenant`, `RequestDeletion`, `AppendAudit` | cross-tenant export impossible |

## Data Flow

1. Cognito identity → Web server-side session → API loads active Membership → transaction-local RLS context。
2. Profile/Offering/Site onboarding → revisioned domain rows → Audit Event。
3. Verified Site → Job/outbox → SQS → Worker → S3 snapshot + PostgreSQL baseline。
4. Evidence → proposed Claim → Reviewer approval → Approved Claim set。
5. Prompt Set/Scenario approval → Content Plan/Brief → restricted Writer job → Artifact revision/lineage。
6. Reviewer approval → Channel Package/eligibility → Publisher command → idempotent Adapter → PublicationRecord。
7. Measurement Scenario → repeated PromptRuns → raw S3 evidence → metrics/snapshot/experiment。
8. Usage/event stream → budget settlement、alerts、retention、export/delete 与 Object Lock audit digest。

详见 [`../system/DATA_FLOW.md`](../system/DATA_FLOW.md)。

## Public Interfaces / Contracts

### HTTP Conventions

- Base path：`/api/v1`；OpenAPI `3.1` 由 Zod contract 生成。
- 所有 mutation 支持 `Idempotency-Key`；revision mutation 同时要求 `If-Match` 或 body 中 expected revision/hash。
- 成功 envelope：`{ data, meta: { requestId, schemaVersion } }`。
- 错误采用 RFC 9457 Problem Details-compatible shape：`type`, `title`, `status`, `code`, `detail`, `requestId`, `retryable`, `fieldErrors?`；不得包含 stack/secret/resource existence。
- List 使用 opaque cursor，不使用无界 offset；每页默认 50、最大 200。
- 所有 ID 为不可猜测的 UUIDv7；S3 object key 不含公司名、email 或 secret。

### HTTP Resources

- `/tenants`, `/tenants/{tenantId}/memberships`, `/workspaces`
- `/workspaces/{workspaceId}/profile`, `/offerings`
- `/sites`, `/sites/{siteId}/verifications`, `/crawls`, `/baselines`
- `/evidence-sources`, `/claims`, `/claims/{claimId}/reviews`
- `/prompt-sets`, `/measurement-scenarios`
- `/content-plans`, `/briefs`, `/artifacts`, `/artifacts/{id}/revisions/{rev}/reviews`
- `/channels`, `/channel-authorizations`, `/channel-packages`, `/publications`
- `/measurement-runs`, `/metric-snapshots`, `/experiments`
- `/budgets`, `/usage`, `/exports`, `/deletion-requests`, `/audit-events`

### Job/Event Contract

```text
JobEnvelope {
  schemaVersion, jobId, tenantId, workspaceId, jobType,
  aggregateId, expectedRevision?, idempotencyKey,
  budgetReservationId, requestedByActorId, createdAt, attempt
}
```

- Message 不含正文、Prompt、raw response、credential 或 Provider token。
- Outbox row 与 domain transaction 同时 commit；relay 可重复发送。
- Consumer inbox 以 `(consumer, messageId)` deduplicate；job handler 本身仍必须幂等。

### Artifact Contract

```text
ArtifactEnvelope {
  schemaVersion, artifactId, tenantId, workspaceId, type,
  revision, contentHash, status, locale, market,
  sourceArtifactIds[], claimBindings[], methodPolicyVersion,
  createdByActor, createdAt, payloadObjectRef
}
```

- Approval 引用 `(artifactId, revision, contentHash)`；hash 不同即 approval invalid。
- Claim binding 引用 exact Claim revision 与 evidence source hash。

### Adapter Contract

- `describe()`：capabilities、terms/version、region、retention、training、subprocessors、rate policy。
- `validateAuthorization()`：OAuth/API scope 与 expiry。
- `preview(package)`：纯函数或 sandbox-safe preview。
- `publish(command)`：要求 idempotency key + approved hash，返回 remote reference 或 typed ambiguous/error。
- `reconcile(remoteRef/idempotencyKey)`：确认真实远端状态。
- `rollback(remoteRef)`：仅在 Adapter 声明 capability 时可调用。
- Provider/Surface Adapter 另实现 `executeScenario()`，结果必须携带 acquisition method 与 raw evidence reference。

## Data Model / Migration

### Core Tables

- Identity/access：`users`, `external_identities`, `tenants`, `workspaces`, `memberships`, `role_bindings`, `sessions`, `break_glass_grants`。
- Knowledge：`profiles`, `profile_revisions`, `offerings`, `offering_revisions`, `attribute_definitions`, `attribute_values`。
- Sites：`sites`, `site_verifications`, `crawl_jobs`, `crawl_snapshots`, `baseline_findings`。
- Evidence/claims：`evidence_sources`, `evidence_snapshots`, `claims`, `claim_revisions`, `claim_evidence_links`, `claim_reviews`。
- Research/content：`prompt_sets`, `prompt_revisions`, `measurement_scenarios`, `opportunities`, `content_plans`, `briefs`, `artifacts`, `artifact_revisions`, `artifact_claim_links`, `artifact_reviews`。
- Publishing：`channel_definitions`, `adapter_versions`, `channel_authorizations`, `channel_packages`, `publication_records`, `publication_attempts`。
- Measurement：`measurement_runs`, `prompt_runs`, `raw_evidence_refs`, `metric_observations`, `metric_snapshots`, `experiments`。
- Operations：`jobs`, `outbox_messages`, `inbox_messages`, `budget_policies`, `budget_reservations`, `usage_ledger`, `audit_events`, `audit_digests`, `exports`, `deletion_requests`, `legal_holds`。

### Tenant and Revision Rules

- 除 global registry/method/schema tables 外，所有业务表含 `tenant_id`；Workspace-owned row 还含 `workspace_id`。
- global table 不能引用 Tenant content 或 secret；registry override 以 Tenant-owned join table 表达。
- revision table append-only；current pointer 只通过 optimistic concurrency command 更新。
- 对外 metric 不能只存最终百分比；保存 numerator、eligible denominator、excluded status counts 与 method version。
- timestamp 使用 UTC `timestamptz`；展示层按 Tenant timezone；money/cost 使用 decimal + currency，不用 float。

### Migration Policy

- 显式 SQL migration，review RLS/constraint/index；production 禁止 auto-sync。
- Expand：添加 nullable/dual-readable schema → backfill/checkpoint → deploy readers/writers → verify。
- Contract：确认旧 image/job/message 全部退出后，再移除旧 column/index/contract。
- Job/Artifact schema 通过 versioned upcaster 兼容至少一个前一版本；不认识的未来版本进入 terminal quarantine，不猜测解析。
- Migration 由 one-off ECS task 使用 migration role 执行；Web/API/Worker runtime role 无 DDL 权限。

## Error Handling / Observability

### Error Taxonomy

- `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND_OR_FORBIDDEN`
- `REVISION_CONFLICT`, `APPROVAL_REQUIRED`, `APPROVAL_STALE`, `SELF_APPROVAL_FORBIDDEN`
- `ADAPTER_DISABLED`, `AUTHORIZATION_INVALID`, `TERMS_NOT_APPROVED`, `EXPORT_ONLY`
- `BUDGET_WARNING`, `BUDGET_BLOCKED`, `RATE_LIMITED`
- `PROVIDER_ERROR`, `PROVIDER_AMBIGUOUS`, `NOT_CHECKED`, `INCONCLUSIVE`
- `RETRYABLE_JOB_FAILURE`, `TERMINAL_JOB_FAILURE`, `SCHEMA_VERSION_UNSUPPORTED`

Retry 仅针对明确 transient failure，采用 bounded exponential backoff + jitter；validation/authz/terms/budget/revision conflict 不自动 retry。Ambiguous publish 必须先 reconcile，不能直接重试。

### Telemetry

- OpenTelemetry trace 跨 Web/API/outbox/SQS/Worker/Adapter 传播；Pino JSON 记录 `trace_id/request_id/job_id`。
- 普通 logs 不记录 Prompt、content、secret、token、PII、完整 query、raw Provider response；debug override 也不能绕过 redaction。
- metrics label 只用受控枚举/opaque low-cardinality dimension；禁止 user/prompt/URL。
- 告警覆盖 SLO burn、p95/5xx、auth denial、queue age/DLQ、heartbeat、Provider、DB、budget、publication、backup/restore。

## Security / Privacy / Permissions

- Cognito + PKCE；Browser 无 LocalStorage token。server-side session 有 absolute/idle TTL、rotation、revoke 与 CSRF protection。
- 所有账号 verified email + TOTP，或 user-verified passkey 满足 MFA；SMS 非默认。
- TenantContext 同时执行 active membership、policy action、Workspace scope、RLS transaction-local context。
- Platform Operator 通过 AWS IAM Identity Center；break-glass grant 与 Tenant user role 分开，默认正文/secret 不可见。
- Crawler 进行 scheme/host allow、DNS re-resolution、private/link-local/metadata deny、redirect recheck、size/type/time limits 与 HTML untrusted-content isolation。
- Connector secret 每 authorization 一个 Secrets Manager secret；API/Worker IAM 按 Adapter/Workspace reference 最小授权；Web 无读 secret 权限。
- Provider policy 在发送前检查 data classification、cross-border approval、retention/training/subprocessors/terms；不满足返回 `NOT_CHECKED`。
- PII 在 crawl/upload/prompt/log/export 前检测与 redaction；Tenant data 不用于平台训练。
- 保留：raw/crawl 180d、screenshot 90d、logs 30d、audit 365d；active delete 30d、backup 90d；legal hold 可见且具名。

### RBAC Summary

| Action | Owner | Admin | Editor | Reviewer | Publisher | Analyst | Viewer |
|---|---:|---:|---:|---:|---:|---:|---:|
| Manage Tenant/budget/cross-border/delete | Yes | Limited | No | No | No | No | No |
| Manage Workspace/authorization | Yes | Yes | No | No | No | No | No |
| Edit Profile/Offering/Evidence/Prompt/Draft | Yes | Yes | Yes | No | No | Limited | No |
| Approve Claim/Brief/Artifact | Yes* | No | No | Yes* | No | No | No |
| Publish approved revision | Yes | Optional | No | No | Yes | No | No |
| Run/interpret measurement | Yes | Yes | Limited | Read | No | Yes | Read |
| View | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

`*` 不能批准同一 actor/Agent 生成的 revision；实际 policy 还检查 Workspace scope。

## Performance / Concurrency

- API 使用 bounded query、cursor pagination、RDS connection pool/RDS Proxy compatibility；禁止 N+1 crawl/metric query。
- Read p95 500 ms、write p95 1 s、job ack 2 s 以不含外部 Provider latency 的 server timing 测量。
- SQS visibility timeout 根据 job class；Worker heartbeat 15 s，lease loss 后旧 worker 不得提交 stale completion。
- 每 Tenant semaphore 默认 5，global worker concurrency 50；Provider Adapter 另有 token bucket/rate policy。
- Budget reservation 与 idempotency row 使用数据库 unique constraint/transaction，不依赖内存 lock。
- Publication unique key：`(tenant_id, channel_authorization_id, artifact_revision_id, target, idempotency_key)`。
- Measurement metrics 异步计算；dashboard 读取 immutable snapshot，避免每次请求扫描 raw evidence。
- Search query 必带 tenant/workspace predicate，并以 benchmark 决定 FTS/vector index；未证明前不引入 OpenSearch。

## Rejected Alternatives

- **Next.js-only monolith**：长任务、secret 和 UI lifecycle 耦合。
- **Network microservices/EKS**：MVP 团队与容量不需要额外 service discovery、distributed transaction 和 cluster 运维。
- **Prisma + application-only tenant filters**：复杂 RLS/extension/migration 需要旁路，降低可审查性。
- **Redis/BullMQ durable core**：额外集群与恢复面；SQS 已满足 at-least-once。
- **OpenSearch from day one**：双写、成本、tenant filter 漂移，没有 benchmark 证据。
- **Cognito groups as RBAC**：不能准确表达多 Tenant/Workspace membership 与 exact policy。
- **External APM by default**：跨境与敏感数据风险；Singapore CloudWatch/X-Ray 足够 MVP。
- **Autonomous publishing**：违反 approval-first 和第三方条款边界。

## Do Not Touch

- `GEO_Agent_Implementation_Playbook_v1.0.docx` 保持只读。
- 不修改行业中立 `Offering` 为固定 Product enum。
- 不允许 Agent 自批、approval 脱离 exact revision/hash、Publisher 修改内容。
- 不合并 measurement Surface/API/cohort，不改变 failure denominator semantics。
- 不把 secret/raw evidence/PII 写入普通 log、SQS、OpenTofu state 或 GitHub artifact。
- 不引入被 [`NON_GOALS.md`](./NON_GOALS.md) 排除的架构或渠道自动化。

## Impact Summary

> 详见 [`IMPACT.md`](./IMPACT.md)。

- 这是一个从零建立身份、知识、内容、发布、测量、审计和 AWS 平台面的高影响 greenfield 工程；必须按 [`TASKS.md`](./TASKS.md) 的 vertical slices 逐步形成可运行闭环，不能横向铺完所有表再补行为。
