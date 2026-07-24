# Acceptance Criteria

## User-Visible Acceptance Criteria

- **AC-001 Login**：Given 一个已验证账号，when 通过 Cognito PKCE 登录，then Browser 只保存 opaque HttpOnly session cookie，用户进入 `/app`；未认证访问返回登录入口。
- **AC-002 Tenant creation**：Given 新用户，when 创建 Tenant 和第一个 Workspace，then 用户成为 Owner，审计中可见创建事件。
- **AC-003 Tenant isolation**：Given Tenant A 与 Tenant B 各有数据，when A 的任意角色猜测 B 的 ID 或使用 B 的 object reference，then API 返回不泄漏存在性的拒绝，数据库无跨 Tenant row/object access。
- **AC-004 Membership/RBAC**：Given Owner 邀请 Editor、Reviewer、Publisher、Analyst、Viewer，when 各角色执行允许和禁止操作，then policy matrix 与 Workspace scope 被严格执行。
- **AC-005 Separation of duties**：Given Agent/Editor 创建 Claim 或 Artifact revision，when 同一 actor 尝试批准，then 系统拒绝；Publisher 不能发布未批准或 hash 不一致的 revision。
- **AC-006 Industry neutrality**：Given 一个不在任何示例行业内的 service/solution，when Editor 建立 Offering，then 可用 dynamic attributes 完成 onboarding，API/schema/UI 不要求行业 closed enum。
- **AC-007 Site verification**：Given 未验证 Site，when 用户尝试 crawl，then 被拒绝；完成 DNS/file/OAuth/admin challenge 后才可启动。
- **AC-008 Crawl safety/baseline**：Given 已验证 Site，when 启动首轮 crawl，then 只访问允许 host，阻止 private/link-local/metadata endpoint，保存 snapshot/hash 和 technical/content baseline；超过 500 pages/2 GiB 后透明停止。
- **AC-009 Claim evidence**：Given proposed Claim，when 缺 evidence snippet/source hash/适用范围，then 不能 APPROVED；Reviewer 批准后可下钻到 exact evidence。
- **AC-010 Prompt approval**：Given Profile/Offering/Claims，when 系统提议 Prompt Set，then Reviewer 可编辑并批准 20–50 Prompt 与 1–3 scopes，revision/hash 可追溯。
- **AC-011 Content plan**：Given approved prompts/claims 和 site baseline，when 生成 Content Plan，then 输出 evidence-ready priority、gap/effort/risk，并包含三类 asset brief；缺失 cross-reference 时计划无效。
- **AC-012 Artifact lineage**：Given approved brief，when Writer 生成内容，then定义/产品页、比较页、技术/证据页包含 Artifact envelope、sourceArtifactIds、Claim map、method/schema version 与 hash。
- **AC-013 Exact revision review**：Given revision R1 已批准，when content 变更为 R2，then R1 approval 不适用于 R2，Publisher 只能选择重新审核或继续发布未变更的 R1。
- **AC-014 Channel package**：Given approved Artifact，when 选择任意 Registry channel，then 系统生成 versioned package/preview/manifest；Channel 名称不是 closed enum。
- **AC-015 Publish eligibility**：Given Adapter/authorization/terms 任一不满足，when 用户点击发布，then UI 显示具体 eligibility reason 并提供 `EXPORT_ONLY`，不创建虚假成功记录。
- **AC-016 Idempotent publish**：Given eligible exact revision，when Publisher 重复点击或 SQS redeliver，then远端最多产生一次效果，PublicationRecord 记录相同 idempotency key、remote ID 和 attempt history。
- **AC-017 Owned adapters**：Git Adapter 只开 Pull Request；WordPress/WooCommerce 与 Shopify 默认创建 draft；signed webhook 验签失败不得写入。
- **AC-018 Measurement baseline**：Given approved 20–50 Prompt、Surface 和 scope，when 运行 baseline，then每 Prompt/Surface 至少 3 次，保存完整 scenario、raw response/citation/error/cost；外部不可用显示 `NOT_CHECKED/ERROR`。
- **AC-019 Metric separation**：Dashboard 永久分开 Technical Health、Content & Evidence Readiness、Measured AI Visibility，且 API/consumer surface 不混为一条趋势。
- **AC-020 Denominator semantics**：Given `ERROR/NOT_CHECKED/INCONCLUSIVE/NOT_APPLICABLE` result，when 计算成功率/准确率，then这些结果不进入分母，并在报告中单独计数。
- **AC-021 Evidence drill-down**：Given 任一公开事实或 metric，when 用户点击 drill-down，then分别到达 Approved Claim/Evidence Source 或 PromptRun/raw evidence。
- **AC-022 Experiment**：Given baseline、published intervention 与兼容 remeasurement，when 创建 Experiment，then显示 comparable delta、scenario version 和 caveat；scenario 不兼容时拒绝直接比较。
- **AC-023 Budget hard stop**：Given Tenant/Provider budget 达 80%，then Owner 收到告警；达 100% 时新付费 job 返回 `BUDGET_BLOCKED`，只有 Owner 提升额度后恢复。
- **AC-024 Export/delete**：Given Owner 请求 export，then只包含该 Tenant 的 Profile/Offering/Claim/Artifact/Run/Metric/Publication/Audit；Given delete，then立即冻结访问/撤销授权，并显示 30/90 天清除时间表和 legal hold。
- **AC-025 No guarantee language**：所有 dashboard、报告和导出均披露样本、时间、Provider/Surface、错误与不确定性，不出现保证排名/引用/推荐的文案。

## Technical Acceptance Criteria

- **AC-T01 RLS**：每个 Tenant-owned table 含 `tenant_id`、启用并 `FORCE ROW LEVEL SECURITY`；runtime role 无 `BYPASSRLS`；双 Tenant Testcontainers suite 全绿。
- **AC-T02 Contracts**：HTTP/job/event/Adapter/Artifact 使用 Zod 4 单一 schema source，生成 JSON Schema 2020-12、OpenAPI 3.1 与 Web types；CI contract drift 为零。
- **AC-T03 Performance**：在定义的 MVP load profile 下，read p95 ≤ 500 ms、write p95 ≤ 1 s、job ack p95 ≤ 2 s、healthy queue start p95 ≤ 30 s。
- **AC-T04 Capacity**：100 concurrent sessions、50 global jobs、5 jobs/Tenant 的 load test 无 tenant leakage、budget bypass 或失控 error rate。
- **AC-T05 Job reliability**：Worker 每 15 s 内 heartbeat；retryable/terminal/cancel/budget-blocked 可区分；DLQ 有告警与受控 redrive。
- **AC-T06 Exactly-once effect**：publish chaos/duplicate-delivery tests 证明 at-least-once message 不产生重复远端内容。
- **AC-T07 Security**：SSRF、authz、session fixation/CSRF、secret redaction、signed webhook、malicious fixture tests 全绿；log/trace 中无 token/PII/raw provider payload。
- **AC-T08 Residency**：OpenTofu plan 只在 `ap-southeast-1` 创建 data-plane resource，无 cross-region replica；Adapter 未获 cross-border approval 时不可发送数据。
- **AC-T09 Lifecycle**：30/90/180/365 天 lifecycle 与 active/backup delete tombstone 有自动测试；Secrets Manager revoke/force-delete 在 24 小时验证窗口内不可读取。
- **AC-T10 Recovery**：实际 restore drill 证明 RPO ≤ 15 min、RTO ≤ 4 h，并保留时间戳、恢复点和 smoke evidence。
- **AC-T11 Observability**：API/job/publish/measurement trace 可关联；SLO burn、p95/5xx、queue/DLQ、budget、DB、backup alarms 可在 synthetic fault 中触发。
- **AC-T12 Supply chain**：production image 以 digest 部署，附 CycloneDX SBOM 与 signed provenance；OSV、secret、license、Action-SHA、image scan 无未批准 blocking issue。
- **AC-T13 Data quality**：`ERROR/NOT_CHECKED/INCONCLUSIVE/NOT_APPLICABLE` 的 denominator property tests 全绿；MetricSnapshot 可重算并得到相同结果。
- **AC-T14 Accessibility**：关键 onboarding、review、publish、dashboard 流程通过键盘、可见焦点、label/error 与自动 axe checks；不只用颜色表达状态。

## Regression Criteria

- 示例行业永远不能成为 required enum、route 或 hardcoded template selector。
- 修改 approved Claim/Artifact 必须产生新 revision/hash 并使旧 approval 不适用。
- Provider/Surface/model/scenario 变化不能静默并入旧 baseline。
- 任何 Adapter failure、timeout 或 ambiguous remote response 不能标为 `PUBLISHED`；必须 reconciliation 或人工处理。
- Owner 删除/冻结后，既有 session、Connector authorization 和后台 job 不能继续访问 Tenant data。
- Break-glass grant 到期后自动失效，且访问内容、操作者、理由、时间均可审计。
- `pnpm verify`、Playwright E2E、OpenTofu validation 与 goal-specific acceptance suite 全绿。

## Manual Verification Checklist

- [x] 用两个 synthetic Tenants 执行完整 onboarding，互相猜测 ID/object key 均失败。
- [x] 用非示例行业的 Offering 完成 Profile → Content Plan。
- [x] 修改一个已批准 Artifact 字符并确认 publish 被阻断。
- [x] 在无 Channel authorization 时验证 export fallback；在 fake/sandbox Adapter 下验证一次真实写入与重复点击不重复。
- [x] 运行一次含 success、citation missing、Provider error、NOT_CHECKED 的 baseline，核对分母与 raw evidence。
- [x] 把 Tenant budget 调到 80%/100%，观察 alert 和 hard stop。
- [x] 执行 Tenant export，检查无其他 Tenant ID/object；执行 delete rehearsal，检查 session/job/authorization freeze。
- [ ] 检查 CloudWatch/X-Ray sample，确认有 correlation 而无 Prompt/token/PII。
- [ ] 从已部署 image digest 验证 SBOM/provenance，并执行 staging smoke/rollback rehearsal。
- [ ] 完成 RDS/S3 restore drill 并记录真实 RPO/RTO。

### Local Manual Evidence — 2026-07-24

- Items 1–2: `output/playwright/acceptance-1-2-result.json` records four PASS steps, two distinct identities/Tenants, opaque cross-scope 404 responses and an industry-neutral community service bound through Profile/Offering to a READY Content Plan.
- Items 3–4: `output/playwright/acceptance-3-4-result.json` records 409 `APPROVAL_STALE`, no stale publish button, both export-only paths, one published fake remote reference, exactly `PUBLISH/AMBIGUOUS` then `RECONCILE/APPLIED`, and an idempotent 200 replay with `created=false`. The focused fake/currentness suite passed 2 files / 44 tests and verifies zero stale effect and one remote effect.
- Item 5: `output/playwright/acceptance-5-result.json` records PASS with `PASS/FAIL/ERROR/NOT_CHECKED/INCONCLUSIVE`, separated excluded counts, reproducible metric denominators and raw Provider-error evidence. The full integration/property gate remains the authoritative persistence/recomputation evidence.
- Item 6: `output/playwright/acceptance-6-result.json` records the 80% alert, exact-100% success and over-100% `BUDGET_BLOCKED`; PostgreSQL concurrency/budget tests in the full integration gate prove atomic reservation behavior.
- Item 7: `output/playwright/acceptance-7-result.json` and `acceptance-7-tenant-export.json` record a machine-checked Tenant-only export, session-cookie clearing, frozen governance and opaque post-freeze access. The dedicated PostgreSQL lifecycle/property suite passed 2 files / 44 tests for session revocation, Job cancellation/freeze, authorization revocation and secret deletion timing. Browser IDs are explicit fake-runtime IDs, not represented as live PostgreSQL rows.
- Items 8–10 remain unchecked and cannot be promoted by local mocks or static configuration.
