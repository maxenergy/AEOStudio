# Requirements 需求文档（umbrella）: Multi-Tenant AEO/GEO/SEO Optimization Platform

> 这是对外 `@` 入口之一。下游编程 agent 用 `@docs/goal/REQUIREMENTS.md` 加载本文件，再按需打开下方链接。本文件自包含；链接文件提供更细的证据和边界。

## Related Documents

- 原始 PRD：[`PRD.md`](./PRD.md)
- 明确不做的：[`NON_GOALS.md`](./NON_GOALS.md)
- 验收标准：[`ACCEPTANCE.md`](./ACCEPTANCE.md)
- 非阻塞假设：[`ASSUMPTIONS.md`](./ASSUMPTIONS.md)
- 已确认答案：[`ANSWERS.md`](./ANSWERS.md)
- 设计 & 技术栈：[`DESIGN.md`](./DESIGN.md)
- 任务拆分：[`TASKS.md`](./TASKS.md)

## Problem Statement 问题陈述

企业需要的不只是 AI 文案或 SEO 分数，而是一条可审计的运营链：把公司/品牌和行业中立 `Offering` 的事实与证据结构化，研究真实用户问题，生成 evidence-backed 内容，经过 exact-revision 人工审批后发布到合规渠道，再以可复现的 Search/AI answer scenario 测量结果并持续实验。目前缺少一个同时提供多租户隔离、Claim lineage、approval-first publishing、failure-transparent measurement 与预算/隐私控制的平台。

## Target Users / Actors 用户与角色

| 角色 | 动机 | 主要职责 | 受影响场景 |
|---|---|---|---|
| Owner | 控制组织、风险与成本 | Tenant/Workspace、成员、预算、跨境 policy、导出/删除 | 全生命周期 |
| Admin | 管理日常配置 | Workspace、Adapter authorization、运营设置 | onboarding/publishing |
| Editor | 维护知识和内容 | Profile、Offering、Evidence、Prompt、Draft | research/content |
| Reviewer | 保证事实与内容可信 | Claim/Brief/Artifact exact revision approval | audit/review |
| Publisher | 受控地执行发布 | 只发布已批准 revision、处理失败/回滚 | publishing |
| Analyst | 配置和解释测量 | Prompt Set、Scenario、Run、Snapshot、Experiment | measurement |
| Viewer | 消费结果 | 只读 dashboard/report/evidence | reporting |
| Platform Operator | 保持平台可用 | deploy、alerts、backup/restore、break-glass | operations |
| Agent/Worker | 执行受限任务 | 在 budget、contract、approved inputs 内工作 | async pipeline |
| External Provider/Channel | 提供数据或写入目标 | 通过 versioned Adapter capability/terms 交互 | connector boundary |

## In-Scope Use Cases 范围内用例

1. **UC-1 Secure tenant onboarding**：用户登录，创建 Tenant/Workspace，邀请具名角色。
   - 触发：首次注册或 Owner 创建新 Workspace。
   - 主路径：Cognito 登录 → Tenant/Workspace → Membership/RBAC → Audit Event。
   - 失败路径：无 membership、scope 不匹配、MFA/session 失效时拒绝且不泄漏资源存在性。
2. **UC-2 Industry-neutral knowledge onboarding**：Editor 填写 Company/Brand Profile、Offering 与动态维度。
   - 触发：新 Workspace。
   - 主路径：Profile → Offering → dynamic attributes → locale/market → revision/hash。
   - 失败路径：不完整/非法 schema 给字段级错误；绝不要求示例行业。
3. **UC-3 Authorized site baseline**：验证一个自有 Site 后执行安全 crawl。
   - 触发：Owner/Admin/Editor 登记站点。
   - 主路径：ownership challenge → policy/budget → crawl → snapshot → technical/content baseline。
   - 失败路径：未验证、SSRF、超限、robots/terms、timeout 分别给稳定结果和 retry eligibility。
4. **UC-4 Evidence-backed Claim Ledger**：登记来源、提议 Claim、人工批准/拒绝/过期。
   - 触发：crawl/upload/public source ingestion。
   - 主路径：Evidence Source → Claim revision → review → Approved Claim。
   - 失败路径：缺 snippet/hash/license/scope 或 actor 自批时阻断。
5. **UC-5 Prompt and content planning**：批准 Prompt Set/Scenario 并生成优先内容计划。
   - 触发：Profile、Offering、Claims、baseline ready。
   - 主路径：20–50 Prompt + 1–3 scopes → opportunity scoring → three asset briefs。
   - 失败路径：cross-reference/approved evidence 不完整时计划无效。
6. **UC-6 Artifact generation and approval**：生成三类资产并批准 exact revision。
   - 触发：approved brief。
   - 主路径：Writer restricted context → Artifact/Claim map/lineage → review → APPROVED hash。
   - 失败路径：内容变化、Claim expiry、self-approval 会使发布资格失效。
7. **UC-7 Review-to-publish**：生成 Channel Package，合规时真实发布，否则导出。
   - 触发：Publisher 选择 approved Artifact 与 channel。
   - 主路径：eligibility → preview → idempotent publish → reconciliation → PublicationRecord。
   - 失败路径：Adapter/auth/scope/terms 不满足为 `EXPORT_ONLY`；ambiguous response 不得标成功。
8. **UC-8 Measurement and experiment**：运行 baseline/remeasurement 并查看证据。
   - 触发：approved Prompt Set/Scenario。
   - 主路径：multi-surface repeated runs → raw evidence → metrics → Snapshot → Experiment。
   - 失败路径：Provider 不可用/条款不允许/场景漂移分别 `ERROR/NOT_CHECKED/INCONCLUSIVE` 或新 baseline。
9. **UC-9 Budget/privacy operations**：Owner 控制花费、export、retention 与 delete。
   - 触发：usage threshold 或 Owner request。
   - 主路径：reservation/alert/hard-stop、tenant-only export、freeze/revoke/delete timeline。
   - 失败路径：越权导出、legal hold 冲突、budget exhausted 明确拒绝并审计。

## Functional Requirements 功能需求

- **FR-1 Identity/Tenancy**：Cognito identity、server-side session、Tenant/Workspace/Membership；验收信号：AC-001–AC-003。
- **FR-2 Authorization**：Owner/Admin/Editor/Reviewer/Publisher/Analyst/Viewer scope、职责分离和 break-glass；验收信号：AC-004–AC-005、AC-T01。
- **FR-3 Profile/Offering**：Company/Brand Profile、行业中立 Offering、dynamic attributes/taxonomy/locale/market；验收信号：AC-006。
- **FR-4 Site/Crawl**：ownership challenge、SSRF-safe crawl、snapshot/hash、technical/content baseline、500 pages/2 GiB 默认上限；验收信号：AC-007–AC-008。
- **FR-5 Evidence/Claim**：Evidence Source license/publicity/snapshot、Claim scope/conditions/expiry/review；验收信号：AC-009。
- **FR-6 Prompt/Scenario**：20–50 approved Prompt、1–3 scopes、Provider/Surface/model/version/repetition 参数；验收信号：AC-010。
- **FR-7 Plan/Brief**：business value、evidence readiness、visibility gap、effort、risk、three asset briefs；验收信号：AC-011。
- **FR-8 Artifact/Lineage**：definition/product、comparison、technical/evidence assets，公共 envelope、Claim/source map、hash；验收信号：AC-012–AC-013。
- **FR-9 Channel package**：Registry-driven package/preview/manifest，不写死渠道名单；验收信号：AC-014。
- **FR-10 Eligibility/Publish**：enabled Adapter + valid OAuth/API scope + allowed terms + approved exact revision；否则 `EXPORT_ONLY`；验收信号：AC-015–AC-016。
- **FR-11 Owned adapters**：Git PR、WordPress/WooCommerce Draft、Shopify Draft、signed webhook；验收信号：AC-017。
- **FR-12 Measurement**：GSC/Bing Webmaster + Registry-driven AI answer surfaces，官方 API 优先，合法 browser sample/manual import fallback；验收信号：AC-018。
- **FR-13 Reporting**：三类结果分开、error denominator、raw evidence drill-down、cost/caveat；验收信号：AC-019–AC-021。
- **FR-14 Experiment**：compatible baseline/remeasurement、intervention、delta、caveat；验收信号：AC-022。
- **FR-15 Jobs/Budgets**：at-least-once-safe job、heartbeat/retry/cancel、80% alert/100% hard stop、Owner raise；验收信号：AC-023、AC-T05–AC-T06。
- **FR-16 Lifecycle/Audit**：retention、tenant export、freeze/delete、connector revoke、legal hold、tamper-evident audit；验收信号：AC-024、AC-T09。
- **FR-17 Provider policy**：Registry 声明 region/retention/training/subprocessors/terms，cross-border Owner approval；验收信号：AC-T08。
- **FR-18 Failure transparency**：稳定保存 `NOT_APPLICABLE/NOT_CHECKED/ERROR/INCONCLUSIVE`，不伪造成功；验收信号：AC-020、AC-T13。
- **FR-19 Honest outcomes**：所有报告披露 scenario/sample/error/uncertainty，不承诺第三方结果；验收信号：AC-025。

## Non-Functional Requirements 非功能需求

- **NFR-1 Performance**：read p95 ≤ 500 ms、write p95 ≤ 1 s、job ack p95 ≤ 2 s；健康 queue start p95 ≤ 30 s。
- **NFR-2 Workflow latency**：单 Offering + Site Content Plan ≤ 15 min；20–50 Prompt baseline ≤ 2 h，外部/人工时间分开。
- **NFR-3 Capacity**：100 concurrent sessions、50 global jobs、5 jobs/Tenant；Provider concurrency 单独 rate policy。
- **NFR-4 Availability/DR**：Control Plane SLO 99.5%，RPO ≤ 15 min、RTO ≤ 4 h，restore drill 提供证据。
- **NFR-5 Security**：MFA、opaque session、RLS、policy engine、SSRF protection、Secrets Manager、idempotency、signed webhook、no-self-approval。
- **NFR-6 Privacy/Residency**：Singapore at rest；raw response/crawl 180d、screenshot 90d、logs 30d、audit 365d；active delete 30d、backup 90d、secret 24h 验证不可读。
- **NFR-7 Observability**：OpenTelemetry/ADOT/Pino，trace/request/job correlation，redacted logs，SLO/queue/budget/publish/backup alarms。
- **NFR-8 Contract quality**：Zod 4 single source、schemaVersion、OpenAPI 3.1/JSON Schema 2020-12、generated client drift gate。
- **NFR-9 Testability**：Vitest/Fastify inject/Testcontainers/Playwright；关键不变量覆盖 positive/deny/retry，默认 CI 不依赖付费 Provider。
- **NFR-10 Accessibility/i18n**：简体中文首发，locale/market first-class，多语言 Artifact，关键流程目标 WCAG 2.2 AA。
- **NFR-11 Supply chain**：exact pins、release-age/trust/signature policy、OSV、license/terms、SBOM/provenance、manual production approval。

## Constraints 约束

- 技术：TypeScript modular monolith，独立 Web/API/Worker；PostgreSQL/SQS/S3/Secrets Manager/ECS Fargate；详见 [`DESIGN.md`](./DESIGN.md)。
- 业务：行业中立、evidence-first、approval-first、measurement reproducibility、failure transparency、no ranking guarantee。
- 数据：Tenant 是硬隔离边界；跨租户只共享不含客户数据的 Schema/Method/Skill。
- 发布：Agent 不能审批；Publisher 只能发布 Approved exact revision；外部 publish effect exactly-once。
- 合规：无明确 commercial use/processing/publishing 权利的 dependency/model/data/channel 不进入生产。
- 源文件：`GEO_Agent_Implementation_Playbook_v1.0.docx` 只读，不得被实现任务修改。

## Out of Scope / Non-Goals 明确不做

> 详见 [`NON_GOALS.md`](./NON_GOALS.md)。

- 不保证排名、收录、AI mention/citation/recommendation 或商业结果。
- 不写死示例行业、Offering 类型、渠道或 Provider。
- 不使用不合规自动化；不绕验证码/私有 API/平台条款。
- 不做 EKS、跨区 active-active、China cell、OpenSearch dual-write、自动审批或真实支付。
- 不训练或跨 Tenant 共享客户数据。

## Acceptance Criteria 验收标准

> 详见 [`ACCEPTANCE.md`](./ACCEPTANCE.md)。以下是 release gate 摘要。

- **AC-1 Complete loop**：synthetic brand 完整走通 Profile → Prompt → Claim → Plan → Audit → Publish → Run → Snapshot → Experiment。
- **AC-2 Isolation**：双 Tenant API/DB/S3/job 测试无跨租户泄漏；RLS 与 policy 双重拒绝。
- **AC-3 Trust**：任一事实下钻 Approved Claim/Evidence；任一 metric 下钻 raw PromptRun。
- **AC-4 Approval**：变更一个字符即产生新 hash 并阻断旧 approval；Agent 自批失败。
- **AC-5 Publishing**：无资格为 `EXPORT_ONLY`；重复交付不产生重复远端效果。
- **AC-6 Measurement**：三类结果分开，失败状态不进入成功分母，场景漂移不静默合并。
- **AC-7 Cost/privacy**：80%/100% budget 行为、tenant-only export、freeze/delete/revoke/retention 均可验证。
- **AC-8 Operations**：SLO/load、restore drill、alerts、SBOM/provenance、security/license gates 通过。

## Open Questions 待解问题

### Blocking 阻塞

- None.

### Non-Blocking 非阻塞

- 管理后台首发简体中文、MVP 不接 payment processor、首 crawl 默认 500 pages/2 GiB、外部 Provider 用 fixture/sandbox、关键流程目标 WCAG 2.2 AA；详见 [`ASSUMPTIONS.md`](./ASSUMPTIONS.md)。
