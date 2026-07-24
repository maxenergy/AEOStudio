# Questions

## Seed Idea

开发一个多租户 AEO/GEO 优化平台。用户登录后填写公司与产品信息，平台结合产品原理、使用方法、应用场景，以及公司官网、网店、独立站等数字资产，为用户提供可持续、可审计的 AEO/GEO/SEO 优化与推广。

## Anchor

- Project type: Greenfield。仓库目前只有 `GEO_Agent_Implementation_Playbook_v1.0.docx`，没有应用代码、package manifest、测试或 CI。
- System docs: 尚无；需求拷问完成后按已冻结边界补充 `docs/system/*`。
- Repository instructions: 未发现仓库内 `AGENTS.md`、`CLAUDE.md` 或 `CONTEXT.md`；本轮遵循会话中给出的模型存储规则。
- Source baseline: Playbook v1.0 定义了 evidence-first、approval-first、artifact lineage、tenant isolation、可复现 measurement、失败透明和不承诺 AI 排名等不变量。

## Confirmed Questions

### Q-001 — First MVP User-Visible Outcome

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: 首个 MVP 是否按下面这条端到端成功路径验收？
- Recommended answer: `YES`。租户注册/登录 → 创建 workspace → 填写公司与 1 个产品 → 授权抓取 1 个自有官网/网店/独立站 → 平台形成 Company Profile、Product Registry、站点基线、Prompt Set 与 Claim Ledger → 生成优先级内容计划和 3 类可发布资产（定义/产品页、比较页、技术/证据页）→ 人工审批后只发布到租户自有站点 → 运行基线与复测，在仪表板展示提及、引用、准确性、覆盖率、成本及原始证据。
- Boundary: 第三方站点、社媒和目录先生成渠道适配稿与发布包；用户审核 exact revision 后，平台提供发布按钮。真实外部写入仍需该渠道存在合规 Adapter 与有效授权；不承诺收录、排名、引用或推荐。
- Reason: 这是最小但完整的 Profile → Prompt → Claim → Plan → Audit → Publish → Run → Snapshot → Experiment 闭环，既能产生真实用户价值，也能验证多租户、审批、证据与测量基础设施。

## Reframed Questions

### Q-002 — Initial ICP and Vertical

- Status: `REFRAMED BY USER`
- User correction: 此前列举的行业只是示例客户，不是平台范围；不得把任何示例行业写死到产品中。
- Design consequence: 行业、产品类型、属性维度、Prompt 分类和内容模板必须可配置或由租户数据派生，不得使用示例行业作为 closed enum、必填业务规则、固定导航或专用工作流。

## Confirmed Questions

### Q-002A — Capability-Based Customer Boundary

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: 首个 MVP 是否采用行业中立的客户边界：任何拥有明确产品、服务或解决方案，并至少拥有一个可授权数字资产的组织都可使用；平台通过动态属性、租户自定义分类和可配置模板适配差异，不设置固定行业名单？
- Recommended answer: `YES`。统一使用 `Offering` 表达产品、服务或解决方案；原理、规格、功能、使用方法、应用场景、兼容性、证据等是可扩展维度，而不是行业专属字段。
- Reason: 这样可以保持核心 Claim → Content → Measurement 闭环一致，同时确保任何客户示例都不会变成架构限制。

## Confirmed Questions

### Q-003 — Tenant Hierarchy and RBAC

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: 多租户层级与权限是否采用下面的模型？
- Recommended answer: `YES`。
  - `Tenant/Organization` 是合同、计费、密钥、数据保留和审计的硬隔离边界。
  - 一个 Tenant 可有多个 `Workspace`；每个 Workspace 表示一个独立运营的公司/品牌项目，拥有自己的 Company/Brand Profile、Offerings、Sites、Claims、内容、发布凭证、Measurement 与审批记录。
  - 一个 User 可加入多个 Tenant；角色授权同时支持 Tenant scope 和 Workspace scope。
  - MVP 角色为 `Owner`、`Admin`、`Editor`、`Reviewer`、`Publisher`、`Analyst/Viewer`；`Reviewer` 负责事实/内容批准，`Publisher` 只能发布已批准 revision，生成 Agent/API actor 永远不能给自己审批。
  - 平台运维默认看不到租户正文和密钥；紧急支持只能通过具名、限时、可撤销、全审计的 break-glass 流程进入。
- Reason: 该模型把商业账户与运营项目分开，既支持普通企业，也支持一个账户管理多个品牌/客户；同时保留审批职责分离和可验证的租户隔离。

## Reframed Questions

### Q-004 — Publishing Connectors and Authorization Boundary

- Status: `REFRAMED BY USER`
- User correction: 第三方站点、社媒和目录首期先生成渠道适配包，并在用户审核后提供发布按钮，而不是永久停留在导出模式。
- Question: MVP 的发布能力是否采用“通用发布包 + 自有站点 Adapter + 第三方渠道 review-to-publish”的边界？
- Recommended answer: `YES`。
  - 所有客户都可下载版本化 `Content Package`，包含 manifest、Markdown/HTML、JSON-LD、图片/数据资产、Claim/source map 和目标 revision。
  - 首批自有站点 Adapter 为 `Git Pull Request`、`WordPress/WooCommerce Draft`、`Shopify Draft`；另提供 signed webhook contract，供自建 CMS 后续接入。
  - 站点必须通过 OAuth、DNS、站点文件或管理员验证证明所有权；凭证按 Workspace 加密保存，不向 Agent、Prompt 或日志暴露。
  - Adapter 声明 `read`、`draft`、`publish` capability；默认只能创建 draft。只有 Reviewer 批准 exact revision/hash 后，Publisher 才能上线同一 revision；Git 路径只开 PR，不直接写 protected branch。
  - 第三方站点、社媒、目录和媒体先生成已审批的渠道适配包；审核通过后由发布按钮调用已授权 Adapter，并生成 Publication Record 与回滚/失败记录。
- Reason: 该方案覆盖大多数自有官网、网店、独立站和自建系统，同时把未经授权发布、凭证泄露、内容 revision 漂移和平台封禁风险挡在 MVP 外。

## Confirmed Questions

### Q-004A — Publish Button Eligibility

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: 第三方渠道的“发布”按钮是否只在该渠道存在已启用 Adapter、租户完成 OAuth/API 授权、权限范围有效且渠道条款允许自动发布时执行真实写入；其他渠道仍展示审核后的“导出/人工交接”，不得伪报发布成功？
- Recommended answer: `YES`。Channel Registry 以插件方式维护 Adapter 和 capability，不写死渠道名单；发布使用 idempotency key、exact revision/hash、预览、状态回查与 Publication Record。浏览器密码模拟、验证码绕过、抓包私有 API 和违反平台条款的自动化默认禁止。
- Reason: 用户仍能获得统一的“生成 → 审核 → 发布”体验，但系统不会为了按钮表象而制造账号封禁、重复发帖、授权越界或虚假成功记录。

## Confirmed Questions

### Q-005 — Measurement Surfaces and Scenario Contract

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: MVP 是否采用下面的可复现 Measurement Scenario，而不是生成一个跨平台混合“总分”？
- Recommended answer: `YES`。
  - 三类结果永久分开：`Technical Health`、`Content & Evidence Readiness`、`Measured AI Visibility`。
  - 首批 Search 数据面为 Google Search Console 与 Bing Webmaster Tools；首批 AI answer target surfaces 为 ChatGPT Search、Google AI Mode/AI Overviews、Perplexity，并通过 Provider/Surface Adapter Registry 扩展。
  - 官方 API 可用且语义相符时优先使用；否则仅在平台条款允许时使用用户授权的浏览器样本或人工导入。普通 LLM API、带搜索 API 与消费界面结果不得混在同一趋势中。
  - 每个 Workspace 由租户选择 1–3 个 `market + locale + region` scope；首轮使用 20–50 个已审批 Prompt，每个 Prompt/Surface 至少重复 3 次。
  - 每次运行固定并记录 provider、surface、model/version、locale、region、account context、fresh session、search enabled、参数、时间、成本、原始回答、引用和错误。
  - `ERROR`、`NOT_CHECKED`、`INCONCLUSIVE` 不进入成功率/准确率分母；Provider 或场景变化时分层或重新建立 baseline。
- Reason: 这能同时覆盖传统 SEO 与真实 AI answer visibility，并避免把 API 模拟结果、消费界面结果和技术审计混成无法解释的营销分数。

## Confirmed Questions

### Q-006 — Performance, Reliability and Budget Guardrails

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: MVP 是否采用下面的可验收 SLO、灾备与成本门槛？
- Recommended answer: `YES`。
  - 不含外部 Provider 时间时，已认证 API 读取 p95 ≤ 500 ms、写入 p95 ≤ 1 s；异步任务提交确认 p95 ≤ 2 s。
  - 平台健康且未触发 Provider rate limit 时，异步任务排队启动 p95 ≤ 30 s，运行中至少每 15 s 更新 heartbeat/progress。
  - 单 Offering + 单 Site 的首份 Content Plan 目标 ≤ 15 min；20–50 Prompt 的首轮多 Surface baseline 目标 ≤ 2 h。人工审批和外部 Provider 限流/故障单独显示，不计入平台处理 SLO。
  - MVP 容量下限：100 个并发交互会话、全局 50 个并发异步 job；单 Tenant 默认最多 5 个并发 job，Provider 并发由 Adapter rate policy 单独限制。
  - Control Plane 月度可用性 SLO 为 99.5%；付费合同 SLA 在 MVP 外。灾备目标为 RPO ≤ 15 min、RTO ≤ 4 h。
  - 队列允许 at-least-once delivery，但发布必须通过 idempotency key 实现 exactly-once external effect，重试不得重复发帖。
  - 每个计划、Tenant、Workspace、job 和 Provider 都有可配置预算；80% 告警，100% 硬停。只有 Owner 显式提升额度或购买增量后恢复，后台任务不得静默超支。
- Reason: 这些指标足够支撑首批多租户试点，并将外部平台波动与自身系统性能分开；预算硬停也能防止 Agent 或监测任务无限消费付费 API。

## Confirmed Questions

### Q-007A — Privacy and Data Lifecycle Baseline

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: MVP 是否采用下面的数据保留、删除、PII 与审计基线？
- Recommended answer: `YES`。
  - Company/Brand Profile、Offering、Claim、已发布 Artifact 与派生指标默认保留到 Tenant 删除或合同结束；租户可配置更短期限。
  - 原始 Prompt/AI response、抓取快照默认保留 180 天，截图 90 天，一般运行日志 30 天；安全、审批、发布、权限和数据操作 Audit Event 以 tamper-evident 方式保留 365 天。
  - Workspace/Tenant 删除请求立即冻结访问和撤销外部授权；活跃数据库与对象存储在 30 天内清除，备份在 90 天内自然淘汰。合法 legal hold 必须具名、记录理由并对 Tenant 可见。
  - Connector credential 删除时立即 revoke，密文在 24 小时内清除；密钥只存 Secret Vault，不进入 Prompt、Artifact、日志或分析系统。
  - 默认最小化 PII，并在抓取、上传、Prompt 构造、日志和导出前执行检测/脱敏；没有 Owner 的明确策略批准，不得把 PII 或机密内容发送给外部 AI Provider。
  - Tenant 数据不得用于训练平台或共享模型；外部 Provider 必须在 Adapter Registry 中记录 retention、training、region 和 subprocessors policy，Owner 授权后才可启用。
  - Tenant 可导出其 Profile、Offerings、Claims、Artifacts、Runs、Metrics、Publication Records 与 Audit Events；跨租户导出永远禁止。
  - 审计至少覆盖登录、角色变化、break-glass、凭证、抓取、Claim 审批、内容 revision、发布、预算、导出和删除。
  - MVP 提供隐私控制与审计证据，但不宣称自动取得 GDPR、CCPA 或其他法律认证；具体市场上线前仍需法律审查。
- Reason: 该基线在保留可复现实验证据的同时限制原始敏感数据寿命，并让删除、外部 AI 调用和运维访问都有明确可验证的边界。

## Confirmed Questions

### Q-007B — Primary Region and Cross-Border Provider Policy

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: MVP 是否采用“新加坡单一区域 + Adapter 级跨境审批”的部署与数据驻留策略？
- Recommended answer: `YES`。
  - MVP 的 Control Plane、数据库、对象存储、队列、搜索索引、Secret Vault 与备份部署在 Singapore region，并在区内使用多 AZ；不做 multi-region active-active。
  - Tenant 创建时固定 `home_region=apac-sg`；Tenant content、credential、raw evidence 与备份不得由平台自行复制到其他区域。
  - 每个外部 Provider Adapter 必须声明 storage region、processing region、retention、training use 与 subprocessors。无法保证 Singapore in-region processing 时，Owner 必须对指定数据类型和目的显式批准 cross-border processing；未批准则 Adapter 禁用或返回 `NOT_CHECKED`。
  - UI 和报告必须区分“平台数据驻留在新加坡”与“外部 Provider 在其他区域处理”；不得把 at-rest residency 宣传成端到端区域内处理。
  - 中国大陆本地数据驻留、ICP备案与境内 Provider 适配不纳入 MVP；如需要，后续建立独立 China cell，不从新加坡部署中暗中跨境复制。
  - 未来 EU、US 或其他 APAC residency 通过相同契约建立独立 region cell；Tenant 迁移必须显式导出、校验、导入与审计。
- Reason: 新加坡具备成熟的主流云区域覆盖，并可作为 APAC 单区域起点；但部分 AI Provider 只支持当地静态存储、不支持当地推理，因此必须把跨境处理做成可见且可拒绝的授权，而不是模糊承诺。

### Q-008A — Language, Runtime and Main Frameworks

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: Greenfield MVP 是否采用下面的 TypeScript modular monolith 技术基线？
- Recommended answer: `YES`。
  - Language: TypeScript `6.0.x`，启用 strict mode；共享 domain types 只从 versioned contracts 生成或导出。
  - Runtime: Node.js `24.x LTS`；生产镜像锁定 patch digest，不使用 Current 或 EOL major。
  - Web: Next.js `16.2.x` App Router + React `19.2.x`，只负责用户界面、BFF/session boundary 与 SSR，不承载长时 Agent job。
  - API: NestJS `11.x` + Fastify `5.x`，提供 REST/OpenAPI、authz、tenant scope、审批、预算和 Adapter orchestration。
  - Worker: 独立 Node/Nest application process，复用 domain/application packages，处理抓取、生成、审计、发布和 Measurement job。
  - Repository: monorepo 中的 `apps/web`、`apps/api`、`apps/worker` 与 `packages/domain|contracts|adapters|ui`；初期同一代码库、独立进程部署，不拆分网络微服务。
  - Python 不进入 Control Plane 核心依赖；确需浏览器、NLP 或模型工具时，通过 versioned job contract 作为隔离 Adapter/worker 引入。
- Reason: 端到端 TypeScript 能共享 tenant、Artifact、Claim 和状态机契约；独立 API/Worker 又能隔离长任务。它比全塞进 Next.js 更可靠，比首期微服务或双语言核心更快形成可测试闭环。
- Rejected for MVP: Next.js-only monolith（长任务与发布边界耦合）、Python-first FastAPI core（前后端契约与权限模型易漂移）、Java/Spring microservices（首期交付与运维成本过高）。

## Confirmed Questions

### Q-008B — Repository Tooling, Tests and Contract Generation

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: Greenfield MVP 是否采用下面的可复现工程工具链与 contract-first 测试基线？
- Recommended answer: `YES`。
  - Package/workspace: `pnpm 11.x`，在 `packageManager` 中锁定 exact version，并提交 `pnpm-lock.yaml`；CI 使用 frozen lockfile。以 pnpm workspace 管理依赖，`Turborepo 2.x` 只负责跨 package 的任务图和缓存。
  - Contract source of truth: `packages/contracts` 使用 `Zod 4.x` runtime schema，TypeScript type 只通过 `z.infer` 派生；HTTP request/response、job、event、Adapter payload 与 Artifact manifest 都必须携带可迁移的 `schemaVersion`，不得另写一套手工 DTO/interface。
  - Generated contracts: NestJS 通过 `nestjs-zod 5.x` 复用同一 schema，生成并校验 `OpenAPI 3.1`；同时从 Zod 输出 `JSON Schema Draft 2020-12`，Web 端由 `openapi-typescript 7.x` 生成 API types。生成物必须可重复，CI 检测 schema 或 generated client 漂移。
  - Tests: `Vitest 4.1.x` 负责 domain、application、component 与 API tests；Nest/Fastify HTTP 测试优先使用 `inject()`。数据库、队列和对象存储集成测试使用 Testcontainers 的真实服务，不用行为不一致的内存替身。
  - Browser/Adapter tests: `Playwright 1.61.x` 覆盖租户隔离、审批、发布、预算硬停与删除等关键浏览器路径；外部 Provider 默认使用 versioned fixture、recorded contract response 或官方 sandbox，默认 CI 不依赖真实付费网络调用。
  - Quality gates: `ESLint 10.x` flat config + 与 TypeScript 6 兼容的 typescript-eslint、精确锁定 `Prettier 3.9.x`、`tsc --noEmit`、package boundary/cycle 检查。统一 `pnpm verify` 至少执行 format check、lint、typecheck、unit、integration、contract drift 与 build；浏览器 E2E 在 CI 独立 stage 执行。
  - Test policy: 新行为先写失败的 acceptance/contract test 再实现；Tenant scope、RBAC、审批 revision/hash、发布幂等、预算硬停和状态机非法迁移属于高风险不变量，必须有正向、拒绝和重试用例，不能只靠快照或行覆盖率证明正确。
- Reason: 该组合让运行时校验、TypeScript 类型、OpenAPI、Agent/Adapter payload 和测试 fixture 来自同一契约，能及早发现多租户越权、revision 漂移、重复发布及前后端不一致；真实依赖集成测试又能覆盖 mock 难以发现的数据库和队列语义。
- Rejected for MVP: npm/Yarn 混用（lockfile 与 workspace 行为分裂）、Jest 与 Vitest 并存（双套配置）、手写 class DTO + 独立 JSON Schema（必然漂移）、默认 CI 直接调用付费 Provider（慢、不稳定且不可复现）、只靠 snapshot 或全局覆盖率门槛（无法证明安全不变量）。

## Confirmed Questions

### Q-008C — Data, Queue, Search, Secrets and Deployment Platform

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: MVP 是否采用下面的 AWS Singapore 单区域、managed-services-first 基础设施基线？
- Recommended answer: `YES`。
  - Region/network: 所有平台数据面固定在 AWS `ap-southeast-1`，跨 2 个 Availability Zones。只允许 ALB 公开入口；Web、API、Worker、数据库与管理端点位于 private subnets。默认不创建跨区域 replica。
  - Compute: `apps/web`、`apps/api`、`apps/worker` 构建为 immutable OCI image，存入 ECR，并作为独立 ECS Fargate service 部署。API/Web 按 CPU 与请求扩缩，Worker 按 SQS backlog/oldest-message-age 扩缩；不引入 Kubernetes/EKS。
  - Primary database: Amazon RDS for PostgreSQL `18.x` Multi-AZ，启用 KMS encryption、TLS、automated backup 与 point-in-time recovery。Tenant-owned table 必须含 `tenant_id`，并启用 `FORCE ROW LEVEL SECURITY`；应用角色不得拥有 `BYPASSRLS`，每个事务通过 transaction-local tenant context 执行，migration/admin role 与运行角色分离。
  - Data access/migrations: `Kysely 0.29.x` + `pg 8.x`，使用显式、可审查的 SQL migration；生产环境禁止 schema auto-sync。采用 expand/contract migration，旧版本仍在运行时不得先删除 column/index/enum value。
  - Search/retrieval: MVP 不部署独立 OpenSearch。结构化过滤和 keyword search 使用 PostgreSQL FTS、`pg_trgm` 与 locale-aware normalized search document；semantic retrieval 使用 RDS 支持的 `pgvector 0.8.x`。所有索引记录带 `tenant_id/workspace_id` 并受 RLS 保护。只有基准测试证明 PostgreSQL 无法满足容量、p95 或多语言 recall 验收时，才通过 SearchPort 引入 OpenSearch，MVP 不做双写。
  - Queue/scheduling: 使用 SQS Standard queues + 每队列 DLQ，按 crawl、generation、publish、measurement workload 隔离；EventBridge Scheduler 只触发计划任务。数据库 transactional outbox 负责可靠入队，consumer inbox/dedup key 负责重放，Publication Record/idempotency key 负责 exactly-once external publish effect。消息只携带 ID、scope 与 `schemaVersion`，不携带正文或 secret。
  - Object storage: S3 存储 crawl snapshot、raw evidence、screenshot、Artifact 与 export，启用 KMS、versioning、checksum、tenant-scoped object-key layout、authorization check 和 lifecycle rule，以落实 30/90/180 天保留期。另设 Audit Evidence bucket，使用 S3 Object Lock 保存 365 天 tamper-evident digest；legal hold 只作用于已批准对象版本。
  - Secret Vault: OAuth/API credential 每个 connector authorization 独立存入 AWS Secrets Manager，以 Singapore customer-managed KMS key 加密；数据库只保存 secret ARN 和非敏感 metadata。Web 无读取权限，API/Worker 采用最小 IAM 权限；禁止 cross-region secret replication。删除时先 revoke，再强制删除 secret，并在 24 小时内验证不可读取。
  - Infrastructure/recovery: `OpenTofu 1.11.x` 管理 VPC、IAM、ECS、RDS、SQS、S3、KMS、Secrets Manager、ALB/ECR 与备份策略；state 远端加密、锁定且不得包含 secret value。恢复演练必须验证已确认的 `RPO ≤ 15 min`、`RTO ≤ 4 h`，不能只验证“备份任务成功”。
- Reason: 该方案与已经冻结的新加坡 residency、100 session/50 job 容量及 at-least-once 队列语义一致；托管数据库、队列、对象存储和 Secret Vault 减少值守面，而 PostgreSQL 内建搜索先避免 OpenSearch 双写、额外成本和租户过滤漂移。
- Rejected for MVP: EKS/Kubernetes（运维面过大）、自管 PostgreSQL/Redis/MinIO（备份和故障转移负担）、Redis/BullMQ 作为唯一 durable queue（需额外集群）、首期 OpenSearch 双写（复杂且易漂移）、Prisma schema-first migration（RLS、extension 与复杂 SQL 仍需旁路）、跨区域 replica（违反已冻结 residency）、secret 写入数据库或 OpenTofu state（越过 Secret Vault 边界）。

## Active Question

### Q-008D — Identity, Observability, Delivery and Supply-Chain Policy

- Status: `CONFIRMED`
- User answer: `YES`（2026-07-20）
- Question: MVP 是否采用下面的 identity、observability、CI/CD、dependency 与 license policy？
- Recommended answer: `YES`。
  - Customer identity: 在 `ap-southeast-1` 使用 Amazon Cognito User Pool Essentials + custom-domain managed login，采用 OAuth 2.0 Authorization Code + PKCE；BFF 使用 `openid-client 6.8.x`。Browser 只持有 Secure、HttpOnly、SameSite opaque session cookie，Cognito token 保存在有 TTL、KMS envelope-encrypted 的 server-side session 中，不进入 LocalStorage。
  - Authentication controls: 所有账号必须验证 email，并注册 TOTP MFA，或使用启用 user verification 且可满足 MFA 的 WebAuthn/passkey；不以 SMS 作为默认 MFA。邀请、移除、session revoke、密码/因素重置和异常登录都写 Audit Event。Enterprise SAML/OIDC federation 可由 Cognito 后续接入，但 SCIM/JIT enterprise provisioning 不纳入 MVP。
  - Authorization boundary: Cognito 只证明 user identity，不承载 Tenant/Workspace membership、业务角色或审批权限。每次请求都从平台数据库加载 active membership，再由 API policy engine 检查 Tenant/Workspace scope；不得信任客户端传入角色，也不得把 Cognito group 当业务授权真源。AWS workload 访问使用 ECS task role，不使用共享 access key。
  - Observability: 使用 OpenTelemetry JS `2.x` + ADOT Collector，把 metrics/traces 发送到 Singapore CloudWatch/X-Ray；Pino `10.x` 输出 structured JSON logs。统一传播 `trace_id/request_id/job_id`，允许记录 tenant/workspace opaque ID，但禁止 Prompt、正文、credential、token、PII、完整 URL query 和 Provider raw response 进入普通日志。
  - Metrics/alerts: 指标 label 禁止 user/prompt/URL 等高基数字段。告警至少覆盖 API SLO burn、p95、5xx、auth denial surge、queue oldest age/DLQ、job heartbeat、Provider rate/error、数据库连接/存储、预算硬停、发布失败/疑似重复、备份与恢复演练；普通日志按 30 天清除，365 天 Audit Evidence 走独立不可变链路。
  - CI: GitHub Actions 的 PR gate 执行 `pnpm verify`、Testcontainers integration、Playwright E2E、OpenTofu validate/plan、secret scan、dependency/license review 和 lockfile/image vulnerability scan。Workflow 默认最小 `permissions`，第三方 Action 固定到审核过的 commit SHA，fork PR 永远拿不到部署权限或 secret。
  - CD: GitHub Actions 通过 OIDC 换取按 environment 限定的短期 AWS role，不保存长期 AWS key。`main` 自动部署 synthetic-data staging；production 只能由受保护 environment 人工批准。镜像 build once，以 digest 晋级，附 CycloneDX SBOM 与 signed provenance attestation；migration 先以 one-off ECS task 执行 expand phase，再滚动部署并做 smoke test，ECS deployment circuit breaker 或验证失败时回滚旧 digest。
  - Dependency security: 直接依赖和工具锁 exact version，基础镜像锁 digest；pnpm 保持至少 24 小时 `minimumReleaseAge`、`trustPolicy=no-downgrade`、registry signature audit 与显式 lifecycle-script allowlist。OSV-Scanner 检查 `pnpm-lock.yaml`、SBOM 与最终镜像；Renovate 每周提出普通更新，critical/high security fix 分别在 24 小时/7 天内处置，所有例外必须具名、说明原因和到期日。
  - License/terms: 自动允许 MIT、Apache-2.0、BSD-2/3-Clause、ISC、0BSD；AGPL、SSPL、BUSL、Commons Clause、未知或 proprietary runtime dependency 默认阻断，GPL/LGPL/MPL/EPL/CDDL 及其他 copyleft/source-available 必须逐项 legal review。相同 registry 也覆盖 container base image、GitHub Action、AI model、embedding model、dataset、字体/图片和渠道内容/API terms；无明确商业使用、再分发或衍生内容权利时不得进入生产。
  - Exception governance: vulnerability、license、residency、telemetry redaction 和 Provider terms 例外只能由 Owner + platform security/legal 具名批准，必须限定 scope、补偿控制与 expiry；过期自动重新阻断，不能用永久 allowlist 掩盖风险。
- Reason: 该方案把身份证明、业务授权、云工作负载权限和发布审批分成独立边界，并让日志、构建、部署与依赖都有可验证证据；同时保持生产 Tenant 数据不进入 GitHub runner 或跨境 telemetry SaaS。
- Rejected for MVP: 自建密码系统/Keycloak（安全与运维面过大）、把 Cognito group 当租户 RBAC（跨 Workspace 易漂移）、JWT/refresh token 放 LocalStorage（XSS 暴露）、长期 AWS access key（难轮换）、Sentry/外部 APM 默认接收 Tenant 数据（跨境与泄漏风险）、未锁 SHA 的 GitHub Action、只跑 `npm audit`、只检查 JavaScript license 而忽略模型/数据/内容条款、生产自动无审批发布。

## Queue

- 当前无；全部 blocking unknowns 已清零，可以冻结 goal pack。
