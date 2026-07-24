# Tasks 任务拆分（umbrella）: Multi-Tenant AEO/GEO/SEO Optimization Platform

> 这是对外 `@` 入口之一。下游编程 agent 用 `@docs/goal/TASKS.md` 加载本文件，按 **TDD red → green → refactor** 顺序逐任务推进。

## Related Documents

- 实施策略：[`PLAN.md`](./PLAN.md)
- 验证证据：[`VERIFY.md`](./VERIFY.md)
- 需求：[`REQUIREMENTS.md`](./REQUIREMENTS.md)
- 设计 & 技术栈：[`DESIGN.md`](./DESIGN.md)
- 影响面：[`IMPACT.md`](./IMPACT.md)
- 验收标准：[`ACCEPTANCE.md`](./ACCEPTANCE.md)
- 明确不做：[`NON_GOALS.md`](./NON_GOALS.md)

## TDD Contract（对所有任务强制）

1. 先写本任务 **RED Test**，只允许创建运行该测试所需的 test harness/config，不得预写生产行为。
2. 跑 **Verification Command**，确认得到指定 **Expected Failure**；任意编译/环境错误不算合格 RED。
3. 只在 **GREEN Boundary** 内写最小实现。
4. 再跑验证并确认全绿；绿后才可做 **Refactor Allowance**，refactor 后再跑一次。
5. 把 RED/GREEN/refactor 命令、关键输出和剩余风险追加到 [`VERIFY.md`](./VERIFY.md)。
6. 当前任务 Acceptance Criteria 未全部满足，不得进入下一任务。

## Task Order 任务顺序

1. Secure sign-in and application shell
2. Tenant/Workspace isolation and RBAC
3. Industry-neutral Profile/Offering onboarding
4. Durable jobs, progress and budget hard stop
5. Verified site crawl and baseline
6. Evidence Source and Claim Ledger approval
7. Prompt Set and Measurement Scenario approval
8. Evidence-ready Content Plan and briefs
9. Artifact generation, lineage and exact-revision review
10. Generic Channel Package and publication core
11. Git Pull Request Adapter
12. WordPress/WooCommerce Draft Adapter
13. Shopify Draft Adapter
14. Signed webhook Adapter
15. Multi-Surface measurement baseline and dashboard
16. Remeasurement, Snapshot and Experiment
17. Audit, retention, export and deletion
18. AWS staging, observability, recovery and supply chain

---

## Task 1: Secure Sign-In and Application Shell

### Goal

从空仓库建立可运行 monorepo，并让用户通过 OIDC/PKCE 安全登录到最小 application shell。

### User-Visible Behavior

未登录用户访问 `/app` 被送往 `/login`；完成 fake OIDC/Cognito-compatible callback 后进入空 Workspace shell，Browser 只有 Secure/HttpOnly/SameSite opaque session cookie，登出后 session 立即失效。

### Scope

- 包含：pnpm/Turbo workspace、Web/API 基础 app、shared contracts、Cognito/OIDC port、server-side encrypted session、login/callback/logout、health/readiness、中文 shell。
- 不含：Tenant/Workspace 创建、任何业务数据、真实 AWS deployment。

### Files Likely Touched

- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig*.json`
- `apps/web/**`, `apps/api/**`
- `packages/contracts/src/auth/**`, `packages/application/src/auth/**`, `packages/adapters/src/identity/**`
- `packages/db/migrations/0001_sessions.sql`
- `tests/integration/task-01-auth-session.test.ts`, `tests/e2e/task-01-auth.spec.ts`

### RED Test

先创建最小 test runner/config，再写：未认证 `GET /app` 必须 redirect/login；OIDC callback 必须 rotation session ID、设置 cookie flags；logout/revoked session 再访问 API 必须 401。测试只通过 HTTP/browser public interface，OIDC 使用 deterministic fake issuer。

### Expected Failure

测试能启动后，必须因 auth route/session behavior 尚不存在而失败：例如 `expected 302 or 401, received 404`，或 callback 后 `expected opaque session cookie, received none`；module/import/数据库连接错误不算合格 RED。

### GREEN Boundary

只建立运行该行为所需的 monorepo、OIDC adapter port、session repository/API/Web routes 与 migration；不创建 Tenant tables、RBAC 或通用 UI framework 扩张。

### Refactor Allowance

全绿后可抽取 cookie policy、clock/ID port 与 test fake；禁止引入 Auth.js、LocalStorage token、业务 membership 或跨 app framework 重构。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-01-auth-session.test.ts
pnpm exec playwright test tests/e2e/task-01-auth.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-001 的登录、cookie、logout/revoke 行为通过。
- Session token/authorization code 不出现在 Browser LocalStorage、普通 log 或 response body。
- `/health` 与 `/ready` 可区分 process alive 和 dependency ready。

### Rollback Condition

若无法在不暴露 token 或不破坏 PKCE/session rotation 的情况下通过，移除 auth routes/session migration 并保留 RED tests；不得改成 password 自建或 LocalStorage JWT。

### Dependencies

- None；这是 bootstrap slice。

### Do Not Touch

- 不实现 Tenant/RBAC、Provider/Channel 或业务 Artifact。
- 不修改 `GEO_Agent_Implementation_Playbook_v1.0.docx` 与已冻结 goal docs。

---

## Task 2: Tenant/Workspace Isolation and RBAC

### Goal

让已登录用户创建 Tenant/Workspace、邀请角色，并通过 application policy + PostgreSQL RLS 获得硬隔离。

### User-Visible Behavior

新用户创建 Tenant/Workspace 后成为 Owner；Owner 可邀请各角色并切换 Workspace；越权 actor 或另一个 Tenant 猜测 ID 时只能得到不泄漏存在性的拒绝。

### Scope

- 包含：Tenant/Workspace/Membership/RoleBinding、invite/accept/revoke、role matrix、TenantContext、RLS、Workspace switcher、基础 Audit Events。
- 不含：自定义角色编辑器、SCIM/JIT、Profile/Offering。

### Files Likely Touched

- `packages/domain/src/identity-access/**`, `packages/application/src/identity-access/**`
- `packages/db/migrations/0002_tenancy_rls.sql`, `packages/db/src/tenant-context/**`
- `apps/api/src/tenants/**`, `apps/web/src/app/**`
- `tests/integration/task-02-tenant-rbac.test.ts`, `tests/e2e/task-02-workspace.spec.ts`

### RED Test

使用两个 Tenant/多个 Workspace fixture：Owner 创建和邀请成功；Editor/Viewer 的禁止操作为 403/opaque 404；Tenant A 通过 API、repository、猜测 object ID 均读不到 Tenant B；runtime DB role 尝试绕过 RLS 失败；生成 actor 自批 policy 预留为 deny。

### Expected Failure

必须出现行为断言失败，例如 `expected tenant B resource to be hidden, received 200`、`expected Publisher content edit to be forbidden` 或 `row_security policy missing`，而不是 migration/test harness 无法启动。

### GREEN Boundary

只实现固定角色与 action matrix、active membership、transaction-local TenantContext、RLS policies、invite flow 和最小 Workspace UI；不实现 ABAC language 或业务资源。

### Refactor Allowance

绿后可统一 policy helpers、scope types 与双 Tenant fixture；不能弱化 FORCE RLS、让 runtime role 获得 BYPASSRLS，或把 Cognito groups 作为授权真源。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-02-tenant-rbac.test.ts
pnpm exec playwright test tests/e2e/task-02-workspace.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-002–AC-005 与 AC-T01 通过。
- 所有 Tenant-owned repository 要求显式 TenantContext，缺失时 fail closed。
- Invite、role change、revoke 与 denial 写具名 Audit Event。

### Rollback Condition

任何双 Tenant test 暴露 row/object existence 或 runtime role 可绕过 RLS 时，停止后续任务并回滚该 slice 的 routes/policies；不得以 application filter 临时替代。

### Dependencies

- Task 1。

### Do Not Touch

- 不增加行业/Offering 字段。
- 不允许 Reviewer/Publisher/Agent separation 通过 UI-only 控制。

---

## Task 3: Industry-Neutral Profile and Offering Onboarding

### Goal

让 Editor 为任何公司/品牌建立 Profile，并用动态维度描述产品、服务或解决方案 `Offering`。

### User-Visible Behavior

Editor 可填写公司信息、数字资产、目标市场，以及 Offering 的原理、规格、功能、使用方法、应用场景、兼容性、证据提示和自定义字段；非示例行业也能完成 onboarding。

### Scope

- 包含：Profile/Offering revision、dynamic attribute definition/value、locale/market、字段级 validation、completeness summary、UI wizard、审计。
- 不含：站点抓取、Claim approval、行业专用模板。

### Files Likely Touched

- `packages/domain/src/profile-offering/**`, `packages/contracts/src/profile-offering/**`
- `packages/db/migrations/0003_profiles_offerings.sql`
- `apps/api/src/profile-offering/**`, `apps/web/src/app/onboarding/**`
- `tests/integration/task-03-offering.test.ts`, `tests/e2e/task-03-onboarding.spec.ts`

### RED Test

创建一个与 AIoT/安防/工业设备无关的 synthetic service，提交租户自定义 attributes 并读取相同 revision；断言 schema/API/UI 无 required industry enum；错误值返回字段级错误；Tenant B 不可见。

### Expected Failure

必须因 Profile/Offering endpoint 或 dynamic attribute behavior 未实现而失败，例如 `expected custom attribute to round-trip, received 404`；若测试被固定 industry enum 拒绝，错误应明确暴露该设计违规。

### GREEN Boundary

只实现行业中立 Profile/Offering、versioned attributes 和 onboarding UI；预置字段只是可编辑建议，不成为 closed enum/专用 workflow。

### Refactor Allowance

绿后可抽取 revision service、schema registry 与表单 renderer；禁止加入行业 switch/case、示例行业 route 或 template hardcode。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-03-offering.test.ts
pnpm exec playwright test tests/e2e/task-03-onboarding.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-006 通过，任意 Offering kind 可用动态维度表达。
- 每次修改生成 revision/hash，旧 revision 可读但不能原地改写。
- Profile/Offering audit 不记录未脱敏 PII。

### Rollback Condition

若只能通过固定行业 schema 完成 onboarding，回滚该 schema/UI 并保留 failing neutrality test；不得把示例客户当默认强制路径。

### Dependencies

- Task 2。

### Do Not Touch

- 不实现 Claim、Prompt、Content Plan。
- 不把 `Offering` 重命名或收窄为仅 `Product`。

---

## Task 4: Durable Jobs, Progress and Budget Hard Stop

### Goal

让用户启动一个 Profile Readiness 异步分析，建立可重放的 job/outbox/inbox、progress/heartbeat 与预算 reservation/hard-stop 基础。

### User-Visible Behavior

Editor 启动 readiness analysis 后立即收到 Job ID，在 UI 看到 QUEUED/RUNNING/progress/result；Owner 配置预算后可看到 80% warning，100% 时新付费 job 为 `BUDGET_BLOCKED`，提高额度后恢复。

### Scope

- 包含：Job state machine、transactional outbox、SQS adapter/fake、consumer inbox、heartbeat/lease、retry/cancel、BudgetPolicy/Reservation/UsageLedger、per-Tenant concurrency 5、readiness job。
- 不含：真实 AI Provider、crawl、publish。

### Files Likely Touched

- `packages/domain/src/jobs-budgets/**`, `packages/application/src/jobs-budgets/**`
- `packages/db/migrations/0004_jobs_budgets.sql`
- `packages/adapters/src/queue/**`, `apps/worker/**`
- `apps/api/src/jobs/**`, `apps/web/src/app/jobs/**`
- `tests/integration/task-04-jobs-budget.test.ts`, `tests/e2e/task-04-job-progress.spec.ts`

### RED Test

断言 command 与 outbox 原子提交；同一 SQS message 重放只结算一次；lease 丢失的 Worker 不能写 stale success；15 s heartbeat；80% alert；100% block；Owner 提额后新 job 可入队；Tenant concurrency 第 6 个 job 保持 queued。

### Expected Failure

必须出现如 `expected one usage settlement, received two`、`expected BUDGET_BLOCKED, received QUEUED` 或 heartbeat 超过 15 s 的行为失败；不能以未安装 LocalStack/queue driver 作为 RED。

### GREEN Boundary

实现通用 job/budget 核心和一个 deterministic Profile Readiness handler；SQS payload 只放 IDs/scope/schemaVersion，不加入真实 Provider 内容。

### Refactor Allowance

绿后可抽取 clock、lease、retry classifier、outbox relay；禁止引入 Redis/BullMQ、无界 retry 或绕过 reservation 的 job path。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-04-jobs-budget.test.ts
pnpm exec playwright test tests/e2e/task-04-job-progress.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-023、AC-T05 的 job/budget 部分通过。
- Queue redelivery 不重复 result/usage；terminal/retryable/cancel/budget-blocked 可区分。
- Job API p95/ack 和 heartbeat metrics 可观测。

### Rollback Condition

发现重复结算、超预算仍调用外部边界、stale worker 覆盖新状态或跨 Tenant concurrency 泄漏时，暂停 Worker 并回滚该 slice；不得用内存锁遮掩。

### Dependencies

- Task 3。

### Do Not Touch

- 不接真实付费 Provider。
- 不把 payload/secret/raw content 放入 SQS message。

---

## Task 5: Verified Site Crawl and Technical Baseline

### Goal

让用户验证一个自有 Site，安全抓取授权范围，并获得可追溯的 technical/content baseline。

### User-Visible Behavior

未验证 Site 不能 crawl；完成 DNS/file/OAuth/admin challenge 后，Editor 可启动 crawl，查看 pages、sitemap/robots、status/canonical/schema/content findings、快照与透明的限制/失败原因。

### Scope

- 包含：Site/verification、crawl policy、SSRF-safe fetch、redirect/DNS recheck、500 pages/2 GiB limit、S3 snapshot/hash、baseline findings、job/progress UI。
- 不含：互联网无授权 crawl、内容生成、完整 SEO suite。

### Files Likely Touched

- `packages/domain/src/site-crawl/**`, `packages/application/src/site-crawl/**`
- `packages/db/migrations/0005_sites_crawls.sql`
- `packages/adapters/src/crawler/**`, `packages/adapters/src/storage/**`
- `apps/api/src/sites/**`, `apps/worker/src/jobs/crawl/**`, `apps/web/src/app/sites/**`
- `tests/integration/task-05-crawl.test.ts`, `tests/security/task-05-ssrf.test.ts`, `tests/e2e/task-05-site.spec.ts`

### RED Test

断言未验证拒绝；验证 challenge exact match；允许 host 正常抓取；loopback/private/link-local/metadata、DNS rebinding、redirect-to-private、oversize/timeout fixture 被阻断；快照 hash 与 finding 可下钻；超限透明 terminal/partial。

### Expected Failure

必须因安全/业务行为缺失失败，例如 `expected SSRF_BLOCKED, received 200`、`expected unverified site rejection` 或 snapshot reference 缺失；网络环境错误不算 RED，全部使用 deterministic local fixtures。

### GREEN Boundary

只支持一个已验证 Site 的 HTML/robots/sitemap baseline 与已列 findings；实现安全 fetch port 和 S3-compatible test adapter，不扩大到全网 crawler。

### Refactor Allowance

绿后可抽取 URL canonicalizer、fetch policy、finding registry；禁止让 robots 代替 SSRF 控制、允许 arbitrary scheme 或把 HTML 当 trusted instruction。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-05-crawl.test.ts tests/security/task-05-ssrf.test.ts
pnpm exec playwright test tests/e2e/task-05-site.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-007–AC-008 与 AC-T07 的 crawl 部分通过。
- Snapshot 有 checksum/content type/size/capturedAt/objectRef，finding 关联 exact snapshot。
- Crawl error/retry/partial 不伪装成 complete baseline。

### Rollback Condition

任何 SSRF bypass、未验证 crawl、超限失效或快照无法证明来源时，禁用 crawl capability 并回滚 handler；保留 Site registration 数据。

### Dependencies

- Task 4。

### Do Not Touch

- 不抓取第三方站点或使用验证码/anti-bot 绕过。
- 不让 crawled content 获得 system/tool instruction 权限。

---

## Task 6: Evidence Source and Claim Ledger Approval

### Goal

让 Editor 从上传/crawl/公开来源登记 Evidence，并让 Reviewer 只批准具备 exact evidence 的 Claim revision。

### User-Visible Behavior

用户可查看 Evidence Source、snapshot/license/publicity/hash，提议带数值/单位/范围/条件/expiry 的 Claim；缺证据、自批或过期 Claim 不能进入 Approved，批准后可下钻 exact snippet。

### Scope

- 包含：Evidence Source/Snapshot、Claim/ClaimRevision/EvidenceLink、review state machine、expiry/stale trigger、UI ledger、audit。
- 不含：Writer/content、自动法律结论、跨 Tenant evidence sharing。

### Files Likely Touched

- `packages/domain/src/evidence-claims/**`, `packages/contracts/src/evidence-claims/**`
- `packages/db/migrations/0006_evidence_claims.sql`
- `apps/api/src/claims/**`, `apps/web/src/app/claims/**`
- `tests/integration/task-06-claims.test.ts`, `tests/e2e/task-06-claim-review.spec.ts`

### RED Test

通过 API 建立 source/snapshot/Claim revision，断言缺 snippet/hash/scope/expiry 不能 submit/approve；生成 actor self-approval 被拒；Reviewer 批准 exact revision；source hash 改变或 expiry 到期使 Claim 非当前可用；Tenant B 不可见。

### Expected Failure

必须出现如 `expected NEEDS_EVIDENCE, received APPROVED`、`expected SELF_APPROVAL_FORBIDDEN` 或 evidence drill-down 404 的行为失败。

### GREEN Boundary

只实现 Evidence/Claim ledger、review/expiry 与 drill-down；自动抽取可用 deterministic suggestion，但不能自动批准或产生法律结论。

### Refactor Allowance

绿后可抽取 generic exact-revision review primitive；禁止跨 Tenant source dedup 暴露、原地改写 Approved Claim 或删除历史 review。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-06-claims.test.ts
pnpm exec playwright test tests/e2e/task-06-claim-review.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-009、AC-021 的 Claim drill-down 与 separation-of-duties 部分通过。
- Approved Claim 绑定 exact source snapshot/hash/snippet 和适用条件。
- expiry/source change 触发 stale/review queue，不静默继续供新 Artifact 使用。

### Rollback Condition

若 unsupported Claim 可 Approved、自批成功或历史 evidence/review 被覆盖，回滚 approval command 并冻结所有 Claim 为非可发布状态。

### Dependencies

- Task 5。

### Do Not Touch

- 不让公开网页 URL 可访问等同于支持 Claim。
- 不把社区内容自动升级为对外 Claim evidence。

---

## Task 7: Prompt Set and Measurement Scenario Approval

### Goal

让 Analyst/Editor 生成并人工批准可复现的 Prompt Set 与 Measurement Scenario。

### User-Visible Behavior

系统根据 Profile/Offering/Claims 提议问题，用户可编辑并批准 20–50 Prompt、persona/journey/query type、1–3 market+locale+region scopes，以及 Provider/Surface/repetition/fresh-session/search settings。

### Scope

- 包含：PromptSet/revisions、Prompt taxonomy、Scenario/version、approval/hash、Provider/Surface Registry read model、UI editor。
- 不含：真实 measurement execution、keyword volume 承诺、跨 Surface 总分。

### Files Likely Touched

- `packages/domain/src/prompt-research/**`, `packages/contracts/src/measurement-scenario/**`
- `packages/db/migrations/0007_prompts_scenarios.sql`
- `apps/api/src/prompts/**`, `apps/web/src/app/prompts/**`
- `tests/integration/task-07-prompts.test.ts`, `tests/e2e/task-07-prompt-set.spec.ts`

### RED Test

断言 Prompt Set 少于 20/超过 50、scope 超过 3、缺 locale/market/region、重复次数少于 3 或未知 Surface acquisition method 时不能批准；批准 exact hash；修改 Prompt 后旧 approval 失效；Registry 可扩展且无 hardcoded industry/channel enum。

### Expected Failure

必须因 validation/approval/versioning 未实现而失败，例如 `expected scenario approval rejection, received APPROVED` 或 `expected old approval stale after edit`。

### GREEN Boundary

实现 Prompt/Scenario contract、建议生成的 deterministic skeleton、review UI 和 Registry read model；不调用真实 Search/AI Provider。

### Refactor Allowance

绿后可抽取 taxonomy/validation helpers；禁止把普通 LLM model 当 consumer Surface、自动批准或生成混合总分配置。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-07-prompts.test.ts
pnpm exec playwright test tests/e2e/task-07-prompt-set.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-010 通过。
- Scenario 保存 provider/surface/model/version/locale/region/account/fresh-session/search/params/repetitions。
- Provider/Surface 不可用不删除配置，后续执行时可明确 `NOT_CHECKED`。

### Rollback Condition

若 scenario 无法稳定 version/hash、Prompt edit 不使 approval stale 或 API/consumer Surface 被混淆，回滚 approval capability 并保留 draft 数据。

### Dependencies

- Task 6。

### Do Not Touch

- 不执行 measurement 或调用真实 Provider。
- 不承诺 keyword volume、排名或 AI citation。

---

## Task 8: Evidence-Ready Content Plan and Briefs

### Goal

把 approved Profile/Offering/Claims/Prompt Set 与 site baseline 转换为可解释的优先 Content Plan 和三类 Brief。

### User-Visible Behavior

Editor 启动计划 job 后看到 opportunity 的 business value、evidence readiness、visibility gap、effort、risk 和排序理由，并得到定义/产品、比较、技术/证据三类 Brief；缺 Evidence 的机会成为 Evidence task 而不是编造内容。

### Scope

- 包含：Opportunity/ContentPlan/Brief、versioned scoring policy、cross-reference validation、job/progress、plan UI、brief approval prerequisite。
- 不含：正文生成、发布、真实 visibility measurement（可用 explicit baseline unknown）。

### Files Likely Touched

- `packages/domain/src/content-planning/**`, `packages/application/src/content-planning/**`
- `packages/db/migrations/0008_content_plans.sql`
- `apps/api/src/content-plans/**`, `apps/worker/src/jobs/content-plan/**`, `apps/web/src/app/plans/**`
- `tests/integration/task-08-content-plan.test.ts`, `tests/e2e/task-08-plan.spec.ts`

### RED Test

使用 fixed fixtures 断言排序可解释、同输入/method version 结果确定；每个 Brief 解析真实 prompt_id/claim_revision_id/sourceArtifactId；证据不足返回 Evidence task；比较 Brief 的竞品 Claim 需独立 evidence；任一 dangling reference 使 plan invalid。

### Expected Failure

必须出现 `expected dangling claim reference rejection`、`expected evidence task, received publishable brief` 或排序/产物不存在的行为失败，而非模型网络失败。

### GREEN Boundary

实现 deterministic scoring/brief skeleton 与 job/UI；可以保留 Agent suggestion port，但测试和最低 GREEN 不需要真实 LLM。只生成三类已确认 Brief。

### Refactor Allowance

绿后可抽取 scoring component、reference validator；禁止把主观 easy win 当事实、引入行业专用 template 或跳过 evidence readiness。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-08-content-plan.test.ts
pnpm exec playwright test tests/e2e/task-08-plan.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-011 通过，三类 Brief 都存在且 cross-reference 可解析。
- Plan 保存 method policy version、input artifact revisions 与 content hash。
- Evidence 不足的机会不能标 publish-ready。

### Rollback Condition

若 plan 存在 dangling reference、证据不足仍生成公开 Brief 或相同输入不可重现，禁用计划生成并回滚 handler；保留输入 Artifact。

### Dependencies

- Task 7。

### Do Not Touch

- 不生成正文或直接发布。
- 不创建跨平台混合 visibility score。

---

## Task 9: Artifact Generation, Lineage and Exact-Revision Review

### Goal

从 approved Brief 和 Approved Claims 生成三类可审计 Artifact，并让 Reviewer 只批准 exact revision/hash。

### User-Visible Behavior

Editor 可为三个 Brief 生成 definition/product、comparison、technical/evidence Draft，查看来源/Claim map/lineage；Reviewer 可批准/拒绝 exact revision。修改一个字符后旧 approval 立即失效。

### Scope

- 包含：Artifact envelope/revision/payload object/hash、Writer restricted context、Claim/source map、review state machine、preview/diff、Claim stale propagation。
- 不含：Channel package、真实发布、未批准 Claim 自动补写。

### Files Likely Touched

- `packages/domain/src/artifacts/**`, `packages/application/src/artifacts/**`
- `packages/db/migrations/0009_artifacts_reviews.sql`
- `packages/adapters/src/generation/**`, `apps/worker/src/jobs/generate-artifact/**`
- `apps/api/src/artifacts/**`, `apps/web/src/app/artifacts/**`
- `tests/integration/task-09-artifacts.test.ts`, `tests/e2e/task-09-artifact-review.spec.ts`

### RED Test

用 versioned generation fixture 断言 Writer input 只有 approved Brief/Claims 且无 secret；输出三类 Artifact、完整 sourceArtifactIds/claim revisions/hash；self-approval 拒绝；批准 R1 后修改为 R2，R1 approval 不适用；Claim expiry 使新 publish eligibility stale。

### Expected Failure

必须出现 `expected APPROVAL_STALE after content change`、`expected self approval denial`、`expected sourceArtifactIds to resolve` 或 Artifact 不存在的行为失败。

### GREEN Boundary

实现 Artifact ledger、三类 deterministic/fixture-backed generation、exact-revision review 和 UI；不构建渠道转换或发布。

### Refactor Allowance

绿后可复用 Task 6 的 review primitive、抽取 hashing/lineage resolver；禁止原地修改 payload、Writer 读取 Secrets Manager、Reviewer 批准未解析 reference。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-09-artifacts.test.ts
pnpm exec playwright test tests/e2e/task-09-artifact-review.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-012–AC-013 通过。
- 任一 Artifact 可下钻 approved Brief、Prompt、Claim revision 与 Evidence Source。
- Writer/Reviewer/Publisher actor 与时间完整审计。

### Rollback Condition

若旧 approval 可发布变更内容、lineage 断裂或 Writer 获得 secret/未批准 Claim，禁用 generation/review capability 并回滚 handler；保留不可变 revisions 供调查。

### Dependencies

- Task 8。

### Do Not Touch

- 不生成 Channel Package 或执行外部写入。
- 不允许 Agent/API actor 批准自己生成的 revision。

---

## Task 10: Generic Channel Package and Publication Core

### Goal

为任意 Registry channel 生成 versioned package，并建立 eligibility、export fallback、idempotency 与 PublicationRecord 核心。

### User-Visible Behavior

Publisher 选择 approved Artifact 和 channel 后看到 exact preview/manifest；无 Adapter/auth/terms/scope 时得到具体原因和 `EXPORT_ONLY` 下载；eligible fake Adapter 可发布一次，重复点击/queue replay 不重复，ambiguous response 先 reconcile。

### Scope

- 包含：Channel/Adapter Registry、Authorization metadata/secret ARN、package transform、manifest/checksum、eligibility、preview、PublicationRecord/Attempt、idempotency/reconcile/rollback port、export。
- 不含：Git/WordPress/Shopify 具体 API。

### Files Likely Touched

- `packages/domain/src/channels-publishing/**`, `packages/contracts/src/channels/**`
- `packages/db/migrations/0010_channels_publications.sql`
- `packages/adapters/src/channels/fake/**`, `packages/adapters/src/secrets/**`
- `apps/api/src/channels/**`, `apps/worker/src/jobs/publish/**`, `apps/web/src/app/channels/**`
- `tests/integration/task-10-publication-core.test.ts`, `tests/e2e/task-10-channel-package.spec.ts`

### RED Test

断言 Registry 不写死 channel enum；approved hash 才能打包；missing/expired auth、disabled Adapter、terms/scope 不足均 `EXPORT_ONLY`；重复 command/SQS delivery 远端 effect count=1；ambiguous response 不直接 retry，reconcile 后才决定 success/failure；PublicationRecord 保存 attempts/remoteRef/hash。

### Expected Failure

必须出现 `expected EXPORT_ONLY, received publish attempt`、`expected one remote effect, received two`、`expected ambiguous state to reconcile` 或 manifest/hash 缺失。

### GREEN Boundary

实现 generic package/registry/publication coordinator、fake Adapter 和 export UI；secret 仅通过 port 临时读取，SQS/DB 不保存 credential value。

### Refactor Allowance

绿后可抽取 Adapter test contract、package transformer registry；禁止加入密码浏览器模拟、私有 API、optimistic fake success 或 channel closed enum。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-10-publication-core.test.ts
pnpm exec playwright test tests/e2e/task-10-channel-package.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-014–AC-016、AC-T06 通过。
- Export package 含 manifest、Markdown/HTML、JSON-LD、asset refs、Claim/source map、revision/hash。
- 真实/假 Adapter 发布都必须由 Publisher actor 触发并受 budget/approval/eligibility gate。

### Rollback Condition

任何 duplicate effect、未经批准/授权写入、ambiguous 被标 success 或 secret 泄漏时，立即禁用所有 publish capability，保留 export-only 与 PublicationRecords，回滚 Worker handler。

### Dependencies

- Task 9。

### Do Not Touch

- 不接具体 production channel API。
- 不允许失败/timeout/unknown remote state 标为 `PUBLISHED`。

---

## Task 11: Git Pull Request Publishing Adapter

### Goal

让 eligible Workspace 把 approved Channel Package 以 Pull Request 发布到租户授权的 Git repository，而不直接写 protected branch。

### User-Visible Behavior

Publisher 预览目标 repo/base/path 和文件 diff，点击发布后得到 PR URL/number；重复操作复用/更新同一 idempotent intent，权限不足或 branch policy 冲突时显示可恢复失败。

### Scope

- 包含：OAuth/App authorization scope validation、path allowlist、branch/commit/PR creation、remote reconciliation、PR status、fake Git provider contract tests。
- 不含：自动 merge、direct push protected branch、任意 repository admin。

### Files Likely Touched

- `packages/adapters/src/channels/git/**`, `packages/contracts/src/channels/git.ts`
- `apps/api/src/channels/git/**`, `apps/worker/src/jobs/publish-git/**`
- `apps/web/src/app/channels/git/**`
- `tests/contract/task-11-git-adapter.test.ts`, `tests/e2e/task-11-git-publish.spec.ts`

### RED Test

针对 versioned fake Git API 跑通 Adapter contract：scope/installation/repo/path validation；只创建 branch+commit+PR；protected branch 无 direct write；duplicate/retry 不创建第二 PR；remote 409/timeout 先 reconcile；PR URL/rollback handle 写 PublicationRecord。

### Expected Failure

必须出现 `expected pull request creation, adapter unavailable`、`expected zero direct protected-branch writes` 或 duplicate PR count mismatch。

### GREEN Boundary

只实现 Git PR Adapter 和配置 UI，复用 Task 10 coordinator；不自动 merge、不修改 repository settings、不实现 GitHub 之外的额外 Git provider，除非同 contract 的 fake 不需 scope 扩张。

### Refactor Allowance

绿后可抽取 Git provider client/retry mapper；禁止把 Provider token 写 log/DB、fallback 为 direct push 或把 PR creation 当 published/merged。

### Verification Command

```bash
pnpm exec vitest run tests/contract/task-11-git-adapter.test.ts
pnpm exec playwright test tests/e2e/task-11-git-publish.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-017 的 Git 部分通过。
- PublicationRecord 区分 `PR_OPENED`、`MERGED`、`CLOSED/FAILED`，不能把 PR opened 等同生产上线。
- Path traversal、repo mismatch、insufficient scope 全部 fail closed。

### Rollback Condition

若 Adapter 可 direct push protected branch、创建重复 PR、越过 repo/path scope 或泄露 token，禁用 Git capability 并回滚 Adapter；已开 PR 保留 remoteRef 供人工关闭。

### Dependencies

- Task 10。

### Do Not Touch

- 不自动 merge 或修改 branch protection。
- 不把 Git PR status 混同 website indexed/AI visible。

---

## Task 12: WordPress/WooCommerce Draft Adapter

### Goal

让 eligible Workspace 把 approved Artifact 创建为 WordPress page/post 或 WooCommerce content draft，并保留 exact revision mapping。

### User-Visible Behavior

Publisher 选择 site、content type、slug/category/product target 并预览 payload；发布后只创建/更新 draft，返回 admin preview URL；重复请求不创建 duplicate，scope/schema/plugin mismatch 显示失败或 export fallback。

### Scope

- 包含：REST API authorization validation、page/post/WooCommerce draft mapping、media/JSON-LD safe handling、idempotency metadata、reconcile、draft rollback/trash contract。
- 不含：自动 publish、插件安装、wp-admin 密码自动化、任意 PHP/theme 修改。

### Files Likely Touched

- `packages/adapters/src/channels/wordpress/**`, `packages/contracts/src/channels/wordpress.ts`
- `apps/worker/src/jobs/publish-wordpress/**`, `apps/web/src/app/channels/wordpress/**`
- `tests/contract/task-12-wordpress-adapter.test.ts`, `tests/e2e/task-12-wordpress-draft.spec.ts`

### RED Test

用 versioned WordPress/WooCommerce fake server 断言 OAuth/application-password-over-TLS or approved token scope、draft status、slug conflict、media checksum、duplicate/retry、timeout reconcile、plugin endpoint absence、remote ID/preview URL/rollback record。

### Expected Failure

必须出现 `expected draft status, received publish/404`、duplicate remote object count >1、scope validation missing 或 reconcile 未执行。

### GREEN Boundary

实现 page/post 和 WooCommerce draft mapping 的最小 Adapter；只有 official REST contract，默认 status=draft，未知字段保留在 package/export 而不猜测写入。

### Refactor Allowance

绿后可抽取 CMS field mapper/media uploader；禁止浏览器密码登录、插件自动安装、直接改 theme/source 或默认 `publish`。

### Verification Command

```bash
pnpm exec vitest run tests/contract/task-12-wordpress-adapter.test.ts
pnpm exec playwright test tests/e2e/task-12-wordpress-draft.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-017 的 WordPress/WooCommerce 部分通过。
- exact Artifact hash 可从 PublicationRecord/remote metadata 对应到一个 draft。
- API/schema/plugin 不兼容时明确失败或 export，不丢字段、不伪报成功。

### Rollback Condition

若默认创建 published content、重复 draft、scope 越界或 remote content 与 approved hash 不一致，禁用 Adapter 并回滚；使用 remoteRef 把错误 draft 移入 trash（若 capability 允许）。

### Dependencies

- Task 10。

### Do Not Touch

- 不使用 wp-admin 浏览器密码自动化。
- 不安装插件、修改 theme 或直接执行数据库写入。

---

## Task 13: Shopify Draft Adapter

### Goal

让 eligible Workspace 通过 Shopify official Admin API 创建/更新 draft-compatible content，并保留 scope、version 与 exact revision evidence。

### User-Visible Behavior

Publisher 选择已授权 Shop 和目标 page/blog/product content，预览后创建 draft/未公开状态；API version/scope 不满足时显示 eligibility reason；duplicate/replay 不产生第二对象。

### Scope

- 包含：OAuth shop authorization、Admin API version contract、page/blog/product content mapping、publish-state guard、idempotency/reconcile、fake Shopify tests。
- 不含：订单/客户数据、theme code 自动修改、private/unstable API、自动上线。

### Files Likely Touched

- `packages/adapters/src/channels/shopify/**`, `packages/contracts/src/channels/shopify.ts`
- `apps/worker/src/jobs/publish-shopify/**`, `apps/web/src/app/channels/shopify/**`
- `tests/contract/task-13-shopify-adapter.test.ts`, `tests/e2e/task-13-shopify-draft.spec.ts`

### RED Test

针对 versioned fake Shopify Admin API 断言 shop/domain/token scope、API version、draft/unpublished guard、duplicate/retry、GraphQL userErrors、throttle/retry-after、timeout reconcile、remote ID/admin URL/rollback record。

### Expected Failure

必须出现 `expected unpublished content`、`expected one remote object`、`expected scope/version rejection` 或 userErrors 未映射的行为失败。

### GREEN Boundary

只实现已确认 content targets 的 official Admin API Adapter，默认不公开；不读取 customer/order data，不写 theme code。

### Refactor Allowance

绿后可抽取 GraphQL client/throttle mapper；禁止 private API、bypass scope、自动 publish 或扩大到 commerce operations。

### Verification Command

```bash
pnpm exec vitest run tests/contract/task-13-shopify-adapter.test.ts
pnpm exec playwright test tests/e2e/task-13-shopify-draft.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-017 的 Shopify 部分通过。
- Adapter Registry 保存 API version/required scopes/terms review，过期版本自动失去 eligibility。
- remote object 与 approved Artifact hash/revision 一一可追溯。

### Rollback Condition

若 Adapter 读取不必要 customer/order scope、自动公开、重复对象或 hash mismatch，立即撤销 Shopify capability/token 并回滚；保留 PublicationRecord。

### Dependencies

- Task 10。

### Do Not Touch

- 不访问 orders/customers 或修改 theme code。
- 不使用 private/unstable API 或自动 publish。

---

## Task 14: Signed Webhook Adapter

### Goal

提供一个供自建 CMS 接入的 versioned signed webhook contract，在不共享平台 secret 的情况下发送 approved Channel Package。

### User-Visible Behavior

Admin 配置 webhook endpoint/authorization，Publisher 预览并发送 approved package；接收方可验证 timestamp、nonce、body hash/signature；重放、过期、签名失败和非 2xx/ambiguous response 有明确记录与 reconciliation。

### Scope

- 包含：webhook contract/schemaVersion、HMAC/asymmetric signing policy、timestamp/nonce/replay cache、endpoint allowlist/SSRF guard、delivery/retry/reconcile callback contract、secret rotation metadata。
- 不含：自建 CMS 端实现、任意 URL blind POST、unsigned webhook。

### Files Likely Touched

- `packages/adapters/src/channels/signed-webhook/**`, `packages/contracts/src/channels/webhook.ts`
- `apps/api/src/channels/webhook/**`, `apps/worker/src/jobs/publish-webhook/**`
- `apps/web/src/app/channels/webhook/**`
- `tests/contract/task-14-webhook-adapter.test.ts`, `tests/security/task-14-webhook-ssrf.test.ts`

### RED Test

用 receiver fixture 断言 canonical body hash/signature、timestamp window、nonce replay rejection、secret rotation、approved revision/hash、endpoint private-IP/redirect blocking、duplicate send/reconcile、timeout/5xx classification；篡改一字必须验签失败。

### Expected Failure

必须出现 `expected signature verification success/failure`、`expected replay rejection`、`expected SSRF_BLOCKED` 或 duplicate receiver effect count mismatch。

### GREEN Boundary

实现一个稳定 webhook schema 与 signing/delivery Adapter；endpoint 需 ownership/admin verification，secret 只存 Secrets Manager。

### Refactor Allowance

绿后可抽取 canonicalization、signature key rotation、delivery receipt parser；禁止 unsigned fallback、arbitrary intranet endpoint 或把 202/timeout 无条件视为 published。

### Verification Command

```bash
pnpm exec vitest run tests/contract/task-14-webhook-adapter.test.ts tests/security/task-14-webhook-ssrf.test.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-017 的 signed webhook 部分通过。
- Contract 文档/JSON Schema 可供第三方实现，包含签名、重放与响应语义。
- Delivery/receipt 与 exact approved hash 可审计，ambiguous 需 reconcile/manual。

### Rollback Condition

若 signature 可被篡改绕过、replay 成功、endpoint SSRF 或 secret 泄漏，立即禁用 webhook Adapter、revoke secret 并回滚 delivery handler。

### Dependencies

- Task 10。

### Do Not Touch

- 不实现客户 CMS 内部代码。
- 不允许 unsigned、password-in-URL 或 arbitrary private endpoint fallback。

---

## Task 15: Multi-Surface Measurement Baseline and Evidence Dashboard

### Goal

按 approved Measurement Scenario 运行可复现 baseline，并让用户看到分层 metric、成本、错误和 raw evidence drill-down。

### User-Visible Behavior

Analyst 启动 baseline 后看到每个 Prompt/Surface 至少 3 次运行的进度；Dashboard 永久分开 Technical Health、Content & Evidence Readiness、Measured AI Visibility，并可从 mention/citation/accuracy/coverage/cost/error 下钻 raw PromptRun。

### Scope

- 包含：GSC/Bing connector contracts、ChatGPT Search/Google AI Mode/AI Overviews/Perplexity Surface registry/fixtures/manual import、PromptRun/raw evidence、parser/classifier、MetricObservation/Snapshot、denominator semantics、dashboard。
- 不含：违反条款的 consumer UI automation、跨 Surface 总分、因果结论。

### Files Likely Touched

- `packages/domain/src/measurement/**`, `packages/application/src/measurement/**`
- `packages/db/migrations/0015_measurement_runs.sql`
- `packages/adapters/src/measurement/**`, `apps/worker/src/jobs/measurement/**`
- `apps/api/src/measurement/**`, `apps/web/src/app/measurement/**`
- `tests/integration/task-15-measurement.test.ts`, `tests/property/task-15-denominator.test.ts`, `tests/e2e/task-15-dashboard.spec.ts`

### RED Test

使用混合 fixture（mention/citation、no mention、MISMATCH、ERROR、NOT_CHECKED、INCONCLUSIVE）断言：每 scenario repetition 完整记录；API/search API/consumer/manual acquisition 分层；excluded statuses 不进分母；raw evidence/cost/error 可下钻；Provider/model/scenario version 被保存；Tenant B 不可见。

### Expected Failure

必须出现 `expected eligible denominator N, received M`、`expected raw PromptRun drill-down`、`expected surface cohorts separated` 或 run/snapshot 不存在，而不是外部网络错误。

### GREEN Boundary

实现 fixture/manual-import capable SurfaceAdapter、GSC/Bing contract boundary、run/parser/snapshot 和三段 dashboard；没有合法 production acquisition 的 surface 返回 `NOT_CHECKED`，不模拟成功。

### Refactor Allowance

绿后可抽取 result classifier、denominator reducer、chart query；禁止混合普通 LLM API/consumer UI、删除 raw error、用零替代 excluded status 或添加总分。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-15-measurement.test.ts tests/property/task-15-denominator.test.ts
pnpm exec playwright test tests/e2e/task-15-dashboard.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-018–AC-021、AC-T13 通过。
- 每个 metric 保存 numerator/eligible denominator/excluded counts/method version，可由 raw runs 重算一致。
- 未批准 cross-border/terms/auth 的 Provider 不接收数据并显示 `NOT_CHECKED`。

### Rollback Condition

若 denominator 错误、surface cohort 混合、metric 无 raw evidence、未授权 Provider 收到数据或普通 API 被冒充 consumer result，禁用受影响 SurfaceAdapter 并回滚 snapshot builder；保留 raw evidence。

### Dependencies

- Task 7、Task 9、Task 10；具体 owned-site Adapter 不阻塞 fixture baseline，但 publication linkage 需 Task 10。

### Do Not Touch

- 不承诺排名/引用/推荐，不生成跨 Surface 综合分。
- 不实现违反平台条款的 browser automation。

---

## Task 16: Remeasurement, Snapshot and Experiment Comparison

### Goal

让 Analyst 把一次 approved/published intervention 与兼容 baseline/remeasurement 组成可解释 Experiment。

### User-Visible Behavior

用户选择 baseline、PublicationRecord/Artifact intervention 和 remeasurement 后看到 comparable cohort 的 delta、样本量、成本、error/excluded counts 与 caveat；scenario/provider/model 不兼容时系统拒绝直接比较并建议新 baseline/分层。

### Scope

- 包含：immutable MetricSnapshot、compatibility key、Experiment/intervention link、delta/uncertainty summary、rebaseline/stratify decision、experiment UI/report。
- 不含：统计因果保证、自动扩大 rollout、结果保证文案。

### Files Likely Touched

- `packages/domain/src/measurement/experiment/**`, `packages/contracts/src/experiments/**`
- `packages/db/migrations/0016_experiments.sql`
- `apps/api/src/experiments/**`, `apps/web/src/app/experiments/**`
- `tests/integration/task-16-experiment.test.ts`, `tests/property/task-16-compatibility.test.ts`, `tests/e2e/task-16-experiment.spec.ts`

### RED Test

断言相同 scenario/method/provider/surface/model/scope 的 snapshots 可比较；任一 compatibility field 变化时拒绝直接 delta；intervention 必须引用 exact approved Artifact/PublicationRecord；excluded status 分开；报告显示 caveat/no-guarantee；snapshot 不可修改。

### Expected Failure

必须出现 `expected INCOMPATIBLE_SCENARIO rejection`、`expected exact intervention linkage`、`expected immutable snapshot` 或 experiment route 不存在。

### GREEN Boundary

实现 compatibility key、snapshot sealing、simple descriptive delta 与 experiment UI；不引入因果推断/复杂显著性宣称。

### Refactor Allowance

绿后可抽取 cohort comparator/report formatter；禁止静默 normalize 不兼容 run、改写旧 snapshot 或声称 intervention 导致结果。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-16-experiment.test.ts tests/property/task-16-compatibility.test.ts
pnpm exec playwright test tests/e2e/task-16-experiment.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-022 与 AC-025 通过。
- Experiment 可下钻 baseline/remeasurement raw evidence 与 exact published intervention。
- 报告明确区分 observed association、sample/caveat 和不可比较情况。

### Rollback Condition

若不兼容 cohort 可被直接比较、snapshot 可修改或报告生成保证性/因果性文案，禁用 Experiment report 并回滚 comparator；旧 snapshots 保持只读。

### Dependencies

- Task 15。

### Do Not Touch

- 不做自动 rollout 或营销保证。
- 不把描述性 delta 解释为因果效果。

---

## Task 17: Audit, Retention, Tenant Export and Deletion

### Goal

让 Owner 获得可验证的 Audit、retention、tenant-only export、Connector revoke 与 Workspace/Tenant deletion lifecycle。

### User-Visible Behavior

Owner 查看登录/角色/审批/发布/预算/导出/删除 Audit timeline，导出本 Tenant 数据；发起删除后 session/job/Connector 立即冻结/撤销，UI 显示 active 30 天、backup 90 天、secret 24 小时与 legal hold 状态。

### Scope

- 包含：append-only AuditEvent/hash chain/digest/Object Lock port、30/90/180/365 retention、tenant export manifest/checksum、freeze/revoke/delete/tombstone、legal hold、break-glass grant/expiry/audit。
- 不含：法律认证、跨 Tenant export、不可见/无理由 legal hold、跨区域 archival。

### Files Likely Touched

- `packages/domain/src/privacy-audit/**`, `packages/application/src/privacy-audit/**`
- `packages/db/migrations/0017_privacy_audit.sql`
- `packages/adapters/src/audit-storage/**`, `packages/adapters/src/secrets/lifecycle/**`
- `apps/api/src/privacy/**`, `apps/worker/src/jobs/lifecycle/**`, `apps/web/src/app/privacy/**`
- `tests/integration/task-17-lifecycle.test.ts`, `tests/property/task-17-retention-clock.test.ts`, `tests/e2e/task-17-privacy.spec.ts`

### RED Test

使用 fake clock 和两个 Tenants 断言 export 只含本 Tenant 且 checksum/manifest 完整；删除请求立即 revoke session/auth/jobs；active/backup/object lifecycles 按时；secret force-delete 后不可读；legal hold 具名可见且只保留对象版本；Audit tamper 检测；break-glass 到期自动失效。

### Expected Failure

必须出现 `expected tenant-only export`、`expected session revoked immediately`、`expected object expired at retention boundary`、`audit digest mismatch not detected` 或 deletion workflow 不存在。

### GREEN Boundary

实现生命周期 state machine、export/delete jobs、Secrets/S3 ports、audit digest 与 UI；生产 S3 Object Lock/backup wiring 留 Task 18 IaC，但 application contract 必须完整通过 fake/Testcontainers。

### Refactor Allowance

绿后可抽取 retention policy engine/tombstone writer；禁止硬删除 AuditEvent、隐藏 legal hold、跳过 immediate freeze/revoke 或让 support break-glass 永久有效。

### Verification Command

```bash
pnpm exec vitest run tests/integration/task-17-lifecycle.test.ts tests/property/task-17-retention-clock.test.ts
pnpm exec playwright test tests/e2e/task-17-privacy.spec.ts
pnpm verify:fast
```

### Acceptance Criteria

- AC-024、AC-T09 与 regression delete/break-glass criteria 通过。
- Export manifest 列 schemaVersion/object hashes/time range，无其他 Tenant ID/object。
- Audit digest 可验证 tamper；ordinary log 与 immutable Audit Evidence 路径分开。

### Rollback Condition

若 export 泄漏跨 Tenant、删除后仍可访问、secret 可读、retention 提前/延后无记录或 audit tamper 未检出，立即禁用 export/delete finalization，保持 Tenant frozen 并回滚 handler，等待人工审计。

### Dependencies

- Task 2、Task 4、Task 10、Task 15。

### Do Not Touch

- 不跨区域复制或隐藏 legal hold。
- 不把一般应用日志伪装为 tamper-evident Audit Event。

---

## Task 18: AWS Staging, Observability, Recovery and Supply Chain

### Goal

把完整应用以可重复、可观测、可恢复且具供应链证据的方式部署到 AWS Singapore synthetic-data staging，并建立受保护 production promotion。

### User-Visible Behavior

Platform Operator 可从 GitHub Actions 使用 OIDC 部署 staging，通过 public smoke URL 验证登录到 Experiment 的 synthetic happy path；CloudWatch/X-Ray 可关联 request/job/publish/measurement；production promotion 需人工批准并按同一 image digest 晋级；restore drill 提供真实 RPO/RTO 证据。

### Scope

- 包含：OpenTofu VPC/ALB/ECS/ECR/RDS/SQS/DLQ/S3/Object Lock/KMS/Secrets/Cognito/alarms/backup、ADOT/Pino redaction、GitHub OIDC/PR gates/build/attest/deploy/rollback、SBOM/OSV/license/secret scans、load/smoke/restore drill。
- 不含：production Tenant onboarding、跨区域 replica、EKS/OpenSearch/外部 APM、真实 payment、无审批 production deploy。

### Files Likely Touched

- `infra/modules/**`, `infra/environments/staging/**`, `infra/environments/production/**`
- `.github/workflows/verify.yml`, `.github/workflows/build-attest.yml`, `.github/workflows/deploy*.yml`
- `packages/adapters/src/observability/**`, `apps/*/src/instrumentation.*`
- `scripts/smoke/**`, `scripts/recovery/**`, `tests/ops/task-18-infra.test.ts`, `tests/load/**`

### RED Test

先写 static/contract tests 断言所有 data-plane resources region=`ap-southeast-1`、双 AZ、private subnets、无 cross-region replica、runtime IAM least privilege、log retention/redaction、alarms/backup/Object Lock；workflow 无 long-lived key、Actions pin SHA、prod environment approval、build-once digest/SBOM/provenance；synthetic smoke/load/restore drill 预期指标。

### Expected Failure

必须因 IaC/workflow/telemetry 尚缺而出现明确断言，例如 `expected RDS Multi-AZ resource`、`expected GitHub OIDC role`、`expected trace correlation` 或 `expected signed SBOM attestation`；云账号凭证缺失不算 RED，静态 contract test 必须先运行。

### GREEN Boundary

只实现已冻结 AWS Singapore managed-service architecture、staging synthetic deployment、observability/recovery/supply-chain gates 和 protected prod promotion；不部署真实 production Tenant 数据，实际 apply 需具名 environment approval。

### Refactor Allowance

绿后可抽取 reusable OpenTofu modules/workflows/telemetry config；禁止跨区域 replication、wildcard IAM、secret in state、unredacted content logs、unapproved production apply 或重新 build prod image。

### Verification Command

```bash
pnpm exec vitest run tests/ops/task-18-infra.test.ts
tofu fmt -check -recursive
tofu -chdir=infra/environments/staging validate
pnpm security:verify
pnpm verify
pnpm test:e2e
```

### Acceptance Criteria

- AC-T03–AC-T05、AC-T07–AC-T12、AC-T14 在 staging/CI 对应 gate 通过。
- Load profile 达 100 sessions/50 jobs/5 per Tenant，且 p95/SLO/error/tenant isolation 达标。
- restore drill 实测 RPO ≤ 15 min、RTO ≤ 4 h；证据追加 `VERIFY.md`。
- Production image digest 有 CycloneDX SBOM、signed provenance、OSV/license/secret checks，且 promotion 需要人工批准。

### Rollback Condition

任一 residency/IAM/secret/redaction/SBOM/provenance/restore gate 失败，禁止 production promotion；已部署 staging 回滚上一 digest，保留 logs/queue/DB 供调查，不执行破坏性 OpenTofu destroy。

### Dependencies

- Tasks 1–17 全部完成并通过各自 Verification Command。

### Do Not Touch

- 不在未获明确 AWS environment approval 时 apply production。
- 不创建跨区域 replica、EKS、OpenSearch、外部 APM 或长期 AWS credentials。
