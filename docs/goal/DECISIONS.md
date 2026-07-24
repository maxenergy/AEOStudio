# Decisions

## User-Confirmed Decisions

| ID | Decision | Consequence |
|---|---|---|
| D-001 | MVP 完整闭环为 Profile → Prompt → Claim → Plan → Audit → Publish → Run → Snapshot → Experiment | 任务必须形成 user-visible vertical flow，不能只搭层 |
| D-002 | 示例行业不是产品边界 | 使用行业中立 `Offering`、dynamic attributes 和 configurable taxonomy |
| D-003 | Tenant 是计费/密钥/保留/审计硬边界；Tenant 下多个 Workspace | 全部业务数据、授权与审计必须有 Tenant/Workspace scope |
| D-004 | Owner/Admin/Editor/Reviewer/Publisher/Analyst/Viewer，Reviewer/Publisher/Agent 职责分离 | Agent 不能自批；Publisher 只发布 Approved exact revision |
| D-005 | 第三方渠道先生成适配包，审核后提供发布按钮 | eligibility 满足才真实写入，否则 `EXPORT_ONLY`，不伪报成功 |
| D-006 | Technical、Content/Evidence、Measured AI Visibility 永久分开 | 不生成跨 Surface 混合总分 |
| D-007 | Search 首批 GSC/Bing；AI target 为 ChatGPT Search、Google AI Mode/AI Overviews、Perplexity，Registry 扩展 | API/consumer UI/collection method 必须分层和版本化 |
| D-008 | 20–50 Prompt、1–3 market+locale+region scopes、每 Prompt/Surface ≥3 次 | Measurement 任务与预算按该基线设计 |
| D-009 | API/job/SLO/capacity/budget/RPO/RTO 采用 Q-006 数字 | 验收需 load、queue、budget 和 restore evidence |
| D-010 | retention/delete/PII/audit lifecycle 采用 Q-007A | S3 lifecycle、Object Lock、delete tombstone 与 revoke 必须实现 |
| D-011 | AWS Singapore 单区域、跨境 Provider 逐项 Owner approval | 不创建跨区域 replica；Provider 未批准为 `NOT_CHECKED` |
| D-012 | TypeScript 6、Node 24、Next 16.2/React 19.2、Nest 11/Fastify 5 modular monolith | Web/API/Worker 独立进程，共享 domain/contracts |
| D-013 | pnpm/Vitest/Playwright/Zod contract-first 工具链 | `pnpm verify`、contract drift 与 TDD 强制 |
| D-014 | RDS PostgreSQL 18、Kysely、Postgres search、SQS、S3、Secrets Manager、Fargate/OpenTofu | 不用 EKS、Redis durable core、OpenSearch dual-write、Prisma schema-first |
| D-015 | Cognito、OpenTelemetry/ADOT、GitHub OIDC、SBOM/provenance、严格 dependency/license policy | identity/authz 分离，telemetry 留新加坡，prod 人工批准 |

## Agent-Made Non-Blocking Assumptions

| ID | Default | Reversal Cost |
|---|---|---|
| A-001 | 所有公开事实/竞品/代码变更/发布人工审批 | Low；可按 channel 加更严 policy，不能低于硬边界 |
| A-002 | 管理后台首发简体中文，domain 保留 locale/market | Medium；UI 文案可扩展，schema 不需迁移 |
| A-003 | MVP 不接 payment processor，只做 plan/quota/usage/budget | Low；后续通过 BillingPort 接入 |
| A-004 | 首 crawl 500 pages 或 2 GiB | Low；Tenant policy 可配置更低/以后提高 |
| A-005 | Provider integration 默认 fixture/recording/sandbox | Low；production credentials 后续启用 |
| A-006 | 关键流程目标 WCAG 2.2 AA | Low；组件层与 E2E 继续提高 |

完整理由见 [`ASSUMPTIONS.md`](./ASSUMPTIONS.md)。

## Rejected Product Alternatives

- 固定 ICP/行业 vertical：与用户明确纠正冲突，会把示例变成架构限制。
- 第三方永久 export-only：与“审核后发布按钮”的用户要求冲突。
- 所有渠道都强制真实自动发布：违反 API/authorization/terms eligibility。
- 跨平台“总分”：掩盖 acquisition method、Surface 和失败分母差异。
- 结果保证型营销：第三方 Search/AI 行为不可控，形成产品与合规风险。

## Rejected Architecture Alternatives

- Next.js-only、Python-first core、Java microservices。
- EKS/Kubernetes、跨区域 active-active、中国大陆与 Singapore 混合 cell。
- Redis/BullMQ durable core、Kafka、OpenSearch dual-write。
- Prisma schema-first + application-only tenant filters。
- Cognito groups 作为 RBAC、LocalStorage JWT、长期 AWS key、外部 APM 默认上送。
- 只扫描 npm dependency 而忽略 image/Action/model/dataset/content terms。

## Decision Change Protocol

任何会削弱 Tenant isolation、approval/hash、failure semantics、residency、secret boundary 或 no-ranking-guarantee 的变更都是 breaking product decision：必须更新 `QUESTIONS.md`、`ANSWERS.md`、`REQUIREMENTS.md`、`DESIGN.md`、`ACCEPTANCE.md` 与受影响 tasks，并由用户重新确认。普通版本 patch、域名/ARN、Provider credential 等 environment parameter 不需要重新拷问。
