# Answers

## Confirmed From User

### A-001 — Product Direction

- 形态：多租户 AEO/GEO 优化平台。
- 入口：用户登录后填写其公司与产品信息。
- 产品知识维度：产品原理、使用方法、应用场景及其他产品维度。
- 数字资产范围：公司网站、网店、独立站等。
- 目标：为租户提供覆盖 AEO、GEO、SEO 的持续优化与推广能力。

### A-002 — First MVP User-Visible Outcome

- 租户注册/登录并创建 workspace。
- 填写公司与 1 个产品，授权抓取 1 个自有官网、网店或独立站。
- 平台形成 Company Profile、Product Registry、站点基线、Prompt Set 与 Claim Ledger。
- 平台生成优先级内容计划，以及定义/产品页、比较页、技术/证据页三类可发布资产。
- 经人工审批后，只发布到租户自有站点。
- 平台运行基线和复测，在仪表板展示提及、引用、准确性、覆盖率、成本和原始证据。
- 第三方站点、社媒和目录先生成渠道适配稿与发布包；用户审核 exact revision 后，平台提供发布按钮。
- 不承诺收录、排名、引用或推荐。

### A-003 — Industry-Neutral Product Boundary

- 此前讨论中出现的具体行业只代表示例客户，不代表平台的固定目标行业。
- 不得把示例行业、产品类型或属性写成 closed enum、固定导航、必填业务规则、专用 Prompt、专用内容模板或专用工作流。
- 行业、产品类型、属性维度、Prompt taxonomy 和内容模板必须支持配置、扩展，或从租户提交的数据中派生。

### A-004 — Capability-Based Customer Boundary

- 任何拥有明确产品、服务或解决方案，并至少拥有一个可授权数字资产的组织均可使用平台。
- 统一使用 `Offering` 表达产品、服务或解决方案。
- 原理、规格、功能、使用方法、应用场景、兼容性、证据及其他租户维度均为可扩展属性，不是行业专属字段。
- 平台通过动态属性、租户自定义分类和可配置模板适配客户差异，不设置固定行业名单。

### A-005 — Tenant Hierarchy and RBAC

- `Tenant/Organization` 是合同、计费、密钥、数据保留和审计的硬隔离边界。
- 一个 Tenant 可拥有多个 `Workspace`；每个 Workspace 是独立运营的公司/品牌项目，拥有自己的 Company/Brand Profile、Offerings、Sites、Claims、内容、凭证、Measurement 与审批记录。
- User 可以加入多个 Tenant；角色授权支持 Tenant scope 与 Workspace scope。
- MVP 角色为 `Owner`、`Admin`、`Editor`、`Reviewer`、`Publisher`、`Analyst/Viewer`。
- Reviewer 负责事实与内容批准；Publisher 只能发布已批准 revision；生成 Agent/API actor 不能审批自己生成的内容。
- 平台运维默认看不到租户正文与密钥；紧急支持访问必须具名、限时、可撤销并全程审计。

### A-006 — Third-Party Review-to-Publish Flow

- 第三方站点、社媒和目录首期先生成各自的渠道适配包。
- 用户必须先审核对应的 exact revision。
- 审核通过后，平台提供发布按钮，而不是要求所有渠道永久停留在纯导出模式。
- 每次真实外部写入必须生成可审计的 Publication Record，并保留成功、失败、重试和回滚信息。

### A-007 — Publish Button Eligibility

- 只有当 Channel Registry 中存在已启用 Adapter、租户完成 OAuth/API 授权、权限范围有效且渠道条款允许自动发布时，发布按钮才执行真实外部写入。
- 其他渠道在审核后提供导出或人工交接，不得伪报发布成功。
- Channel Adapter 通过插件扩展，不写死渠道名单。
- 发布使用 idempotency key、exact revision/hash、预览、状态回查和 Publication Record。
- 浏览器密码模拟、验证码绕过、私有 API 抓包及违反平台条款的自动化默认禁止。

### A-008 — Measurement Surfaces and Scenario Contract

- `Technical Health`、`Content & Evidence Readiness` 与 `Measured AI Visibility` 永久分开报告，不生成跨平台混合总分。
- 首批 Search 数据面为 Google Search Console 与 Bing Webmaster Tools；首批 AI answer target surfaces 为 ChatGPT Search、Google AI Mode/AI Overviews 与 Perplexity，并通过 Provider/Surface Adapter Registry 扩展。
- 官方 API 语义相符时优先使用；否则仅在平台条款允许时使用用户授权的浏览器样本或人工导入。
- 普通 LLM API、带搜索 API 和消费界面结果不得混在同一趋势中。
- 每个 Workspace 选择 1–3 个 `market + locale + region` scope；首轮使用 20–50 个已审批 Prompt，每个 Prompt/Surface 至少重复 3 次。
- 每次运行保存完整场景、参数、成本、原始回答、引用和错误。
- `ERROR`、`NOT_CHECKED`、`INCONCLUSIVE` 不进入成功率或准确率分母；Provider/场景变化时分层或重建 baseline。

### A-009 — Performance, Reliability and Budget Guardrails

- 已认证 API 读取 p95 ≤ 500 ms、写入 p95 ≤ 1 s；异步任务提交确认 p95 ≤ 2 s。
- 平台健康且未触发外部 rate limit 时，异步任务排队启动 p95 ≤ 30 s，至少每 15 s 更新进度。
- 单 Offering + 单 Site 的首份 Content Plan 目标 ≤ 15 min；20–50 Prompt 的首轮多 Surface baseline 目标 ≤ 2 h。
- MVP 容量下限为 100 个并发交互会话和全局 50 个并发异步 job；单 Tenant 默认最多 5 个并发 job。
- Control Plane 月度可用性 SLO 99.5%；RPO ≤ 15 min，RTO ≤ 4 h；付费合同 SLA 在 MVP 外。
- 队列可采用 at-least-once delivery，但外部发布必须实现 exactly-once effect，重试不能重复发布。
- 计划、Tenant、Workspace、job 与 Provider 均有可配置预算；80% 告警、100% 硬停，只有 Owner 可提升额度。

### A-010 — Privacy and Data Lifecycle Baseline

- Company/Brand Profile、Offering、Claim、已发布 Artifact 与派生指标保留到 Tenant 删除或合同结束；租户可配置更短期限。
- 原始 Prompt/AI response 与抓取快照默认保留 180 天，截图 90 天，一般运行日志 30 天，tamper-evident Audit Event 365 天。
- 删除请求立即冻结访问并撤销外部授权；活跃数据 30 天内清除，备份 90 天内淘汰。Legal hold 必须具名、记录并对 Tenant 可见。
- Connector credential 立即 revoke，密文 24 小时内清除；密钥不得进入 Prompt、Artifact、日志或分析系统。
- 默认最小化、检测和脱敏 PII；未经 Owner 策略批准，不向外部 AI Provider 发送 PII 或机密内容。
- Tenant 数据不得用于训练平台或共享模型；Provider 必须披露 retention、training、region 与 subprocessors policy。
- Tenant 可导出自身数据，跨租户导出禁止；关键安全、权限、审批、发布、预算、导出和删除操作必须审计。
- MVP 不自动宣称取得特定法律认证，具体市场上线前仍需法律审查。

### A-011 — Primary Region and Cross-Border Provider Policy

- MVP 的 Control Plane、数据库、对象存储、队列、搜索索引、Secret Vault 与备份部署在 Singapore region，并在区内使用多 AZ；不做 multi-region active-active。
- Tenant 创建时固定 `home_region=apac-sg`；Tenant content、credential、raw evidence 与备份不得由平台自行复制到其他区域。
- 外部 Provider Adapter 必须声明 storage region、processing region、retention、training use 与 subprocessors。
- 无法保证 Singapore in-region processing 时，Owner 必须对指定数据类型和目的批准 cross-border processing；未批准则禁用或返回 `NOT_CHECKED`。
- UI 与报告必须区分平台静态数据驻留和外部 Provider 处理区域。
- 中国大陆本地数据驻留、ICP备案与境内 Provider 适配不纳入 MVP，后续通过独立 China cell 实现。
- 未来其他区域通过独立 region cell 扩展，Tenant 迁移必须显式导出、校验、导入并审计。

### A-012 — Language, Runtime and Main Frameworks

- 核心语言采用 strict TypeScript `6.0.x`，运行时采用 Node.js `24.x LTS`；生产镜像锁定 patch digest。
- Web 使用 Next.js `16.2.x` App Router + React `19.2.x`，只承载 UI、BFF/session boundary 与 SSR，不运行长时 Agent job。
- API 使用 NestJS `11.x` + Fastify `5.x`，负责 REST/OpenAPI、authz、tenant scope、审批、预算与 Adapter orchestration。
- Worker 是独立 Node/Nest application process，复用 domain/application packages，处理抓取、生成、审计、发布和 Measurement job。
- Repository 采用 modular-monolith monorepo：`apps/web`、`apps/api`、`apps/worker`、`packages/domain`、`packages/contracts`、`packages/adapters`、`packages/ui`；各 app 独立进程部署，MVP 不拆网络微服务。
- Python 不进入 Control Plane 核心；确需 Python 工具时，只能通过 versioned job contract 作为隔离 Adapter/worker 接入。

### A-013 — Repository Tooling, Tests and Contract Generation

- 使用 `pnpm 11.x` workspace 并锁定 exact package-manager version 和 lockfile；Turborepo `2.x` 只管理跨 package 任务图与缓存。
- `packages/contracts` 的 Zod `4.x` runtime schema 是 HTTP、job、event、Adapter 与 Artifact contract 的唯一真源；TypeScript types、JSON Schema Draft 2020-12、OpenAPI 3.1 与 Web API types 均由它派生。
- NestJS 使用 `nestjs-zod 5.x` 复用 schema，Web 使用 `openapi-typescript 7.x` 生成 API types；CI 检测 contract/generated artifact drift。
- Vitest `4.1.x` 覆盖 domain、application、component 与 API tests，Fastify API 优先用 `inject()`；数据库、队列与对象存储集成测试使用 Testcontainers 真实服务。
- Playwright `1.61.x` 覆盖关键浏览器路径；外部 Provider 默认使用 versioned fixture、recorded contract response 或官方 sandbox，默认 CI 不依赖付费网络调用。
- ESLint `10.x` flat config、兼容 TypeScript 6 的 typescript-eslint、精确锁定的 Prettier `3.9.x`、`tsc --noEmit` 和 package boundary/cycle checks 构成静态质量门禁。
- `pnpm verify` 统一运行 format check、lint、typecheck、unit、integration、contract drift 与 build；浏览器 E2E 在 CI 独立 stage 执行。
- 新行为遵循 RED → GREEN → REFACTOR；Tenant scope、RBAC、审批 revision/hash、发布幂等、预算硬停及非法状态迁移必须覆盖正向、拒绝和重试测试。

### A-014 — Data, Queue, Search, Secrets and Deployment Platform

- 平台固定部署在 AWS Singapore `ap-southeast-1` 的两个 Availability Zones；仅 ALB 暴露公网，Web/API/Worker、数据库及管理端点位于 private subnets，不创建跨区域 replica。
- Web、API、Worker 使用 immutable OCI image、ECR 与独立 ECS Fargate services；不采用 EKS/Kubernetes。
- 主数据库为 Amazon RDS for PostgreSQL `18.x` Multi-AZ，启用 KMS、TLS、automated backup 与 point-in-time recovery。
- Tenant-owned table 必须包含 `tenant_id` 并启用 `FORCE ROW LEVEL SECURITY`；应用角色无 `BYPASSRLS`，transaction-local tenant context、migration role 与 runtime role 分离。
- 数据访问使用 `Kysely 0.29.x` + `pg 8.x` 和显式 SQL expand/contract migration；生产禁止 schema auto-sync。
- MVP 搜索统一使用 PostgreSQL FTS、`pg_trgm`、locale-aware normalized document 与 `pgvector 0.8.x`；基准测试不能达标前不引入 OpenSearch，也不做双写。
- 异步任务使用按 workload 隔离的 SQS Standard queues + DLQ，EventBridge Scheduler 负责计划触发；transactional outbox、consumer dedup/inbox 与 Publication idempotency 分别保障可靠入队、重放安全和 exactly-once external effect。
- S3 以 KMS、versioning、checksum、tenant-scoped authorization 与 lifecycle 存储 Artifact/raw evidence；独立 Audit Evidence bucket 以 Object Lock 保存 365 天 digest 与 legal hold 对象。
- Connector authorization 独立存入 AWS Secrets Manager，以 Singapore KMS key 加密；数据库只保存 secret ARN/metadata，禁止跨区域复制，撤销后强制删除并在 24 小时内验证不可读取。
- OpenTofu `1.11.x` 管理全部基础设施，远端 state 加密锁定且不含 secret value；恢复演练必须实际验证 `RPO ≤ 15 min`、`RTO ≤ 4 h`。

### A-015 — Identity, Observability, Delivery and Supply-Chain Policy

- Customer identity 使用 Singapore Amazon Cognito User Pool Essentials、custom-domain managed login、Authorization Code + PKCE 与 `openid-client 6.8.x`；Browser 只保存 Secure/HttpOnly/SameSite opaque session cookie，token 放在 KMS envelope-encrypted server-side session。
- 所有账号验证 email，并使用 TOTP MFA，或使用启用 user verification 且可满足 MFA 的 WebAuthn/passkey；SMS 不是默认 MFA。
- Cognito 只证明 identity；Tenant/Workspace membership、RBAC 与审批权限以平台数据库为唯一真源，每次请求重新检查 active membership。AWS workload 使用 ECS task role。
- Observability 使用 OpenTelemetry JS `2.x`、ADOT、Singapore CloudWatch/X-Ray 与 Pino `10.x` structured logs；普通日志禁止 Prompt、正文、credential、token、PII、完整 URL query 与 Provider raw response。
- 指标禁止高基数 user/prompt/URL label；告警覆盖 SLO burn、p95/5xx、auth denial、queue/DLQ、job heartbeat、Provider、数据库、预算、发布和恢复演练；普通日志 30 天，Audit Evidence 365 天。
- GitHub Actions PR gate 执行 `pnpm verify`、integration/E2E、OpenTofu、secret、dependency/license 与 vulnerability checks；最小 permissions，第三方 Action 固定 commit SHA，fork PR 无部署权限。
- GitHub Actions 通过 OIDC 获取短期 AWS role；`main` 自动部署 synthetic-data staging，production 需 protected-environment 人工批准。镜像 build once、按 digest 晋级，并附 CycloneDX SBOM 与 signed provenance。
- 依赖锁 exact version，基础镜像锁 digest；pnpm 启用 minimum release age、trust-policy、signature audit 与 lifecycle-script allowlist；OSV-Scanner 检查 lockfile、SBOM 和最终镜像，critical/high 漏洞分别在 24 小时/7 天内处置。
- 自动允许 MIT、Apache-2.0、BSD-2/3-Clause、ISC、0BSD；高风险、未知、copyleft/source-available 或 proprietary license 按已确认规则阻断或 legal review。相同规则覆盖容器、Action、AI model、dataset、字体、图片与渠道/API terms。
- 所有 vulnerability、license、residency、redaction 与 Provider terms 例外必须具名、限 scope、有补偿控制和 expiry；过期自动重新阻断。

## Pending Confirmation

- None. 全部 blocking decisions 已由用户确认。
