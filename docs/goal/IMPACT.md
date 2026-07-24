# Impact Analysis

## Change Classification

- 类型：Greenfield platform implementation。
- 范围：Web、API、Worker、domain/application/contracts、database、Adapters、AWS infrastructure、CI/CD、security/observability 全栈新增。
- 风险级别：High。原因不是修改现有代码，而是多租户隔离、对外发布、付费 Provider、可审计事实和隐私删除均属于高后果行为。

## Affected Modules

| Area | New/Changed Modules | Primary Impact |
|---|---|---|
| User surface | `apps/web`, `packages/ui` | 登录、onboarding、review/publish、measurement dashboard、budget/privacy controls |
| Control plane | `apps/api`, `identity-access`, all application handlers | Tenant context、RBAC、state transition、REST/OpenAPI |
| Async plane | `apps/worker`, jobs/budgets | crawl/generate/publish/measure/export/delete/retry/heartbeat |
| Domain | `packages/domain`, `packages/application` | Entity、state machine、policy、ports、errors |
| Contracts | `packages/contracts` | HTTP/job/event/Artifact/Adapter schema 与 generated artifacts |
| Data | `packages/db`, SQL migrations | PostgreSQL schema、RLS、outbox/inbox、indexes、retention metadata |
| Integrations | `packages/adapters` | Cognito、S3/SQS/Secrets、crawl、AI/Search、CMS/channel |
| Operations | `infra`, `.github/workflows` | AWS Singapore、OIDC、deploy、backup、alarms、SBOM/provenance |
| Verification | `packages/testkit`, `tests/e2e`, contract fixtures | 双 Tenant、provider sandbox、chaos/idempotency、load/recovery |

## Affected Interfaces

- Browser routes：login/callback、Tenant/Workspace switch、onboarding、Claims、Prompts、Plans、Artifacts、Channels、Publications、Measurements、Experiments、Budgets、Audit、Privacy。
- REST `/api/v1/*` resource set 与 RFC 9457-compatible error contract。
- Generated OpenAPI 3.1、JSON Schema 2020-12、Web API types。
- SQS `JobEnvelope`、outbox/inbox semantics、heartbeat/progress events。
- Artifact/Claim/Prompt/Measurement/Publication versioned contracts。
- Adapter ports：Crawler、Evidence/AI/Search Surface、Git、WordPress/WooCommerce、Shopify、signed webhook、export。
- AWS resource/IAM/OpenTofu module outputs。
- CI verification、staging/prod promotion、SBOM/provenance interface。

## Data Impact

### Schema Changes

Greenfield 新增约 40–50 张关系表，分为 identity/access、knowledge、sites、evidence/claims、research/content、publishing、measurement、jobs/budgets、privacy/audit。最终表数由 vertical slices 收敛，但以下不能合并掉：

- append-only revision/review 与 mutable current pointer 必须分离；
- raw evidence object 与 derived metric 必须分离；
- publication record 与 attempt/reconciliation 必须分离；
- budget policy/reservation/usage ledger 必须分离；
- Tenant-owned row 与 global registry/method row 必须分离。

### Migration Requirements

- 每个 vertical slice 提交显式 forward SQL migration、RLS policy、constraint/index 和 rollback note。
- Production 只执行 expand-first migration；contract migration 延迟到旧 image/job/schema message 全部退出。
- 每个 migration 在 Testcontainers PostgreSQL 18 上执行 from-empty 与 from-previous-slice upgrade test。
- Extension `pg_trgm`/`vector` 的 availability 在 deploy preflight 检查；缺失时阻断而不是静默降级。

### Backward Compatibility

- HTTP `/v1` 不在 MVP 内静默 breaking；字段新增默认 optional/read-compatible，移除需要新 major contract。
- Job/Event/Artifact schema 支持至少前一个版本的 upcast；future version quarantine。
- Approved revision 永远保留 hash 与 lineage；不能通过 migration 改写历史内容。
- Measurement Scenario/Method version 变化建立新 cohort，不改写旧 snapshot。

## Risk Assessment

### Critical

- Tenant RLS/session context 错误导致数据泄漏。
- approval/hash 绕过导致未批准内容发布。
- SQS redelivery/ambiguous Provider response 导致重复发布。
- Crawler SSRF、malicious content prompt injection。
- secret/PII/raw evidence 进入日志、Prompt、CI 或跨境 Provider。

### High

- Measurement scenario 漂移或 denominator 错误产生误导报告。
- Budget race condition 导致付费 API 超支。
- Connector terms/region/authorization 变化后仍继续写入。
- Delete/retention/Object Lock/backup 之间承诺不一致。
- Migration contract phase 与旧 Worker 并行导致消息/状态损坏。

### Medium

- PostgreSQL hybrid search 的 CJK recall 或规模不足。
- External Provider sandbox 与 production response drift。
- High-cardinality telemetry 引发成本或泄漏。
- 多语言内容模板与 schema 的 locale fallback 不一致。

详细控制见 [`../system/RISK_AREAS.md`](../system/RISK_AREAS.md)。

## Concurrency and Performance Impact

- API mutation 必须同时处理 optimistic revision、idempotency、RLS 和 budget reservation；transaction 太大可能影响 p95。
- Worker 按 workload queue 隔离，crawl/generation/measurement/publish 不能共用无界 concurrency。
- Measurement 可能产生 20–50 Prompt × Surface × ≥3 repetitions；必须批次化、预算预留、并把 raw payload 放 S3。
- Publication reconciliation 不能占用长数据库 transaction；先记录 intent，再在短 transaction 中推进 state。
- Dashboard 必须读 immutable snapshot/aggregate，不能同步重算全部 PromptRun。

## Security and Privacy Impact

- 新增 Cognito identity、server-side session、MFA 与 Workspace membership security boundary。
- 新增 Secrets Manager connector secret lifecycle、KMS、IAM task roles、break-glass。
- 新增 Provider cross-border/data-classification gate 与 PII redaction。
- 新增 S3 lifecycle/Object Lock、Tenant export/delete/legal hold。
- 新增 supply-chain、license/model/data terms、SBOM/provenance gates。

## Test Impact

- 所有 slice 至少有 public-interface RED test、deny-path test 与必要 retry/replay test。
- 双 Tenant fixtures 是所有 Tenant-owned repository/API/Worker test 的默认，而不是单独安全测试。
- Provider/Channel 使用 versioned contract fixtures；default CI 无真实付费调用。
- 必须增加 publish duplicate-delivery chaos、SSRF corpus、denominator property、migration upgrade、retention clock、load、restore drill tests。
- Playwright 覆盖 login、onboarding、review、publish fallback、measurement、budget/delete 主路径与 accessibility。

## Constraints

- 原始 DOCX、goal decision trail 与硬 non-goals 不得修改或弱化。
- Production data plane 只在 `ap-southeast-1`；CI/staging 只用 synthetic data。
- 不引入跨区域 replica、EKS、OpenSearch dual-write、外部 APM 或 autonomous publishing。
- 技术栈 major/version constraints 以 [`DESIGN.md`](./DESIGN.md) 为准。

## Rollout Strategy

1. 先建立 session + Tenant/Workspace/RLS 可运行壳。
2. 逐个 vertical slice 增加 Profile、Crawl、Claim、Prompt/Plan、Artifact/Review。
3. 先完成 generic package/eligibility/fake adapter，再接 owned-site adapters。
4. 先用 deterministic provider fixtures 完成 Measurement semantics，再启用授权 sandbox/production Adapter。
5. 最后加入预算/lifecycle、AWS deploy、alerts、recovery 与 supply-chain promotion gate。
6. staging 全程 synthetic Tenant；production 首租户通过 feature flag/allowlist，观察后再扩大。

## Rollback Strategy

- Application：ECS 回滚到上一已验证 image digest；不得重新 build “同一版本”。
- Database：优先 forward-fix；只有尚未被新代码写入且 migration 明确标记 reversible 时才执行 down。破坏性 contract 失败使用 PITR/restore rehearsal 决策，不盲目 down。
- Queue：暂停 source queue consumer，保留消息；修复后受控 redrive DLQ，不能清空。
- Publishing：停止 Adapter capability；对已成功远端记录按 Adapter rollback capability 人工/自动处理，保留 PublicationRecord。
- Measurement：禁用受影响 Adapter/version，旧 raw evidence/snapshot 不改写，重新建立 cohort。
- Infrastructure：OpenTofu 回滚代码只用于可逆资源；数据库/S3/Secrets 删除必须有 protect/precondition，不能由普通 rollback 销毁。

## Unknown Impact Areas

- 具体 Provider/Channel production API 审批、quota、terms 与 regional processing 会变化；通过 Registry 隔离，未明确前 `NOT_CHECKED/EXPORT_ONLY`。
- 真实客户网站技术栈、CJK/多语言 corpus 和 crawl 规模尚无生产分布；先以 synthetic + pilot benchmark 设定索引与 limit。
- AWS account/domain/ARN 未分配；OpenTofu environment inputs 后补，不改变 design。
- 法律认证与市场专项审查不在 MVP；policy 提供证据但不自动宣称合规。
