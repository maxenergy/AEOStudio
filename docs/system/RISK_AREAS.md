# Risk Areas

## High Risk

### Tenant Isolation

- 风险：遗漏 `tenant_id` filter、错误 RLS session context、migration role 被 runtime 复用会造成跨租户泄漏。
- 控制：`FORCE RLS`、runtime 无 `BYPASSRLS`、transaction-local context、双租户 integration tests、禁止 repository 无 scope 查询。
- 失败门槛：任何跨租户读写测试失败都阻断发布。

### Approval and Revision Integrity

- 风险：批准后内容被修改、Writer 自批、Publisher 发布未批准 revision。
- 控制：content-addressed hash、append-only revision、职责分离、approval 引用 exact hash、状态机拒绝非法迁移。
- 失败门槛：无法证明远端内容对应 Approved revision 时 PublicationRecord 不能为成功。

### External Publishing

- 风险：重复发帖、越权 scope、渠道封禁、凭证泄露、错误成功状态。
- 控制：Channel Registry eligibility、OAuth/API only、idempotency、remote status reconciliation、Secrets Manager、export fallback。
- 禁止：密码浏览器模拟、验证码绕过、私有 API 抓包、违反平台条款的自动化。

### Measurement Validity

- 风险：把普通模型 API 当消费界面、场景漂移、失败进入分母、低样本导致虚假结论。
- 控制：versioned MeasurementScenario、surface 分层、至少三次重复、raw evidence、错误语义与 cohort compatibility checks。
- 失败门槛：没有 raw PromptRun 的指标不能出现在报告。

### SSRF and Untrusted Content

- 风险：Crawler 访问内网/metadata endpoint，恶意 HTML/prompt injection 影响 Agent。
- 控制：ownership verification、DNS/IP re-resolution、私网/loopback/link-local deny、redirect recheck、size/time/type limits、内容隔离与不信任标记。
- 注意：robots/crawler policy 不是 SSRF 安全控制。

### Secrets and Cross-Border Processing

- 风险：credential 进入 Prompt/log、Secrets Manager 跨区复制、Provider 未批准跨境处理。
- 控制：secret ARN only、最小 IAM、redaction、Adapter policy disclosure、Owner approval、未批准返回 `NOT_CHECKED`。

## Medium Risk

### Queue Redelivery and Concurrency

- SQS at-least-once 与乱序可能重复工作或覆盖状态。
- 使用 outbox/inbox、optimistic version、idempotency key、lease/heartbeat 与 terminal/retryable error taxonomy。

### Search Isolation and Recall

- PostgreSQL hybrid search 可能在 CJK recall 或规模上不足；embedding index 也可能错误跨 scope。
- 先建立 locale-aware normalization 与 benchmark；所有 index row 带 tenant/workspace scope；未达门槛才引入 SearchPort 后端。

### Data Lifecycle

- Object Lock、backup retention 与删除承诺可能冲突。
- 使用独立 bucket/retention class；删除 UI 明示 active、backup、audit/legal-hold 时间表并保存可验证 tombstone。

### Cost Explosion

- 多 Surface × Prompt × 重复次数与生成任务会快速消耗外部 API。
- 强制预估、reservation、80% 告警、100% 硬停、单 Tenant 并发上限 5。

### Schema and Adapter Drift

- Provider payload、OpenAPI、job/event 或 Channel API 变化会破坏执行。
- Zod contract single source、`schemaVersion`、contract fixtures、Adapter compatibility matrix 与 quarterly review。

## Operational Risk

- RPO/RTO 只靠“备份成功”无法证明；必须做 restore drill。
- GitHub runner 不能访问生产 Tenant 数据；staging 只用 synthetic fixtures。
- 日志 label 不得包含 user/prompt/URL，避免高基数成本和 PII 泄漏。
- 生产 migration 必须 expand/contract；破坏性 contract phase 需等待旧 image 完全退出。

## Do-Not-Touch Invariants

- 不把示例行业写死。
- 不降低人工审批、exact revision/hash 与职责分离。
- 不把 `ERROR/NOT_CHECKED/INCONCLUSIVE` 记为零分或成功。
- 不承诺排名、引用、收录或推荐。
- 不允许跨租户正文、Claim、Prompt result、secret 或 raw evidence 共享。
- 不在 MVP 引入跨区域 replica、EKS 或 OpenSearch 双写。
