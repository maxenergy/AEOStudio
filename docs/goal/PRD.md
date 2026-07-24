# PRD: Multi-Tenant AEO/GEO/SEO Optimization Platform

## Problem Statement

企业拥有产品、服务、解决方案和大量网站内容，却通常无法把事实、证据、用户问题、内容资产、渠道发布和 AI/Search 可见度测量连接成一个持续闭环。现有工具往往只生成文案或单点 SEO 分数，无法证明公开内容依据了什么 Claim、由谁批准、发布了哪个 revision，也无法区分技术健康、内容准备度与真实 AI answer visibility。

本产品要提供一个行业中立的多租户平台：用户登录后建立公司/品牌与 `Offering` 知识，授权自有网站，平台基于原理、规格、功能、使用方法、应用场景、兼容性和证据等可扩展维度，形成可审批、可发布、可测量、可复盘的 AEO/GEO/SEO 运营闭环。

## Goals

- 让一个真实租户完整走通 Profile → Prompt → Claim → Plan → Audit → Publish → Run → Snapshot → Experiment。
- 让每个对外事实可追溯到 Approved Claim 与 Evidence Source，每个指标可追溯到 raw PromptRun。
- 让用户先审核 exact revision，再通过合规 Adapter 发布到自有站点或第三方渠道；不具备资格时提供真实的 export/manual handoff。
- 同时覆盖传统 Search 数据面和真实 AI answer surfaces，但永久分开技术、内容准备度与实测可见度。
- 从第一天具备 Tenant/Workspace 隔离、RBAC、预算硬停、审计、数据生命周期和 Singapore residency 控制。
- 保持行业、Offering 类型、属性维度、Prompt taxonomy、内容模板和 Channel Adapter 可配置扩展。

## Non-Goals

- 不保证搜索收录、排名、AI 提及、引用、推荐、流量或销售结果。
- 不把任何示例行业、产品类型或渠道写死为平台边界。
- 不绕过验证码、不使用浏览器密码模拟、不抓包调用私有 API、不违反第三方平台条款。
- MVP 不做 autonomous approval/autonomous publishing、跨区域 active-active、中国大陆独立部署、OpenSearch 双写、Kubernetes/EKS 或网络微服务拆分。
- MVP 不接真实支付处理器，不自动宣称 GDPR/CCPA/ISO/SOC 等法律或安全认证。
- 详细排除项见 [`NON_GOALS.md`](./NON_GOALS.md)。

## Users / Actors

- `Owner`：创建 Tenant、批准预算/跨境 Provider policy、管理成员、删除/导出数据。
- `Admin`：管理 Workspace、配置 Adapter 与日常运营，但不能越过 Owner-only policy。
- `Editor`：维护 Profile/Offering/Evidence/Prompt/Content Draft。
- `Reviewer`：审核 Claim、Brief、Artifact exact revision；不能审批自己作为生成 actor 产生的 revision。
- `Publisher`：只能发布已批准的 exact revision；不能修改内容或补审批。
- `Analyst`：配置 Measurement Scenario、运行 baseline/remeasurement、解释 evidence-backed metrics。
- `Viewer`：只读查看授权 Workspace 的报告和证据。
- `Platform Operator`：维护服务与恢复演练，默认不能查看租户正文或 secret；break-glass 必须具名、限时、可撤销、全审计。
- `Agent/Worker`：在 versioned task contract、budget、approved inputs 和 Adapter capability 内执行，永远不能自批。
- `External Provider/Channel`：Search、AI answer surface、CMS、社媒、目录或数据服务，只能经 Registry 中的合规 Adapter 访问。

## User Stories

1. As an Owner, I want to create isolated Workspaces and assign roles, so that multiple brands or customers can be operated without data leakage.
2. As an Editor, I want to describe any product, service or solution with dynamic attributes, so that the platform is not limited to a fixed industry.
3. As an Editor, I want to verify and crawl an owned site, so that the platform can identify technical/content gaps from authorized evidence.
4. As a Reviewer, I want every Claim to include exact evidence and expiry, so that unsupported facts cannot enter public content.
5. As an Analyst, I want to approve Prompt Sets and reproducible scenarios, so that visibility measurements remain comparable.
6. As an Editor, I want prioritized content briefs and three publishable asset types, so that I can act on the highest-value evidence-ready opportunities.
7. As a Reviewer, I want approval bound to an exact hash, so that post-approval edits cannot be published silently.
8. As a Publisher, I want a publish button only when the Adapter and authorization are eligible, so that external writes are compliant and auditable.
9. As an Analyst, I want to drill every metric down to raw evidence, so that reports expose uncertainty instead of hiding it.
10. As an Owner, I want budget hard stops, exports and deletion controls, so that Agent/API costs and data lifecycle stay under my control.

## Functional Requirements

- **FR-1 Identity and tenancy**：支持 Cognito 登录、Tenant/Workspace 创建、跨 Tenant membership 与 active-session revoke。
- **FR-2 RBAC**：实现 Owner/Admin/Editor/Reviewer/Publisher/Analyst/Viewer 的 Tenant/Workspace scope，并执行 Reviewer/Publisher/Agent 职责分离。
- **FR-3 Profile and Offering**：建立 Company/Brand Profile 与行业中立 `Offering`，属性、taxonomy、locale、market 可扩展。
- **FR-4 Site verification and crawl**：通过 OAuth、DNS、site file 或 admin challenge 验证站点所有权，执行一个 Site 的安全抓取与 technical/content baseline。
- **FR-5 Evidence and Claims**：登记 Evidence Source、snapshot/hash、license/publicity，提取 Claim、限定条件、expiry 与 approval state。
- **FR-6 Prompt and scenario**：生成/编辑/审批 20–50 Prompt、1–3 个 market+locale+region scopes 与 versioned Measurement Scenario。
- **FR-7 Planning**：根据 business value、evidence readiness、visibility gap、effort 与 risk 生成优先级 Content Plan 和 Brief。
- **FR-8 Artifact production**：生成定义/产品页、比较页、技术/证据页三类 Artifact，包含 Claim/source map、lineage、schema/method version 与 exact hash。
- **FR-9 Review**：事实、技术、合规和品牌审核只能批准 exact revision；修改后必须重新审批。
- **FR-10 Package and publishing**：生成 versioned Content/Channel Package、preview、PublicationRecord、rollback/failure record。
- **FR-11 Eligibility**：真实发布仅在 Adapter enabled、授权有效、scope 足够、terms 允许且 exact revision 已批准时执行；否则 `EXPORT_ONLY`。
- **FR-12 Owned-site adapters**：MVP 实现 Git Pull Request、WordPress/WooCommerce Draft、Shopify Draft 与 signed webhook contract。
- **FR-13 Measurement**：集成 Google Search Console、Bing Webmaster，并通过 Provider/Surface Registry 运行 ChatGPT Search、Google AI Mode/AI Overviews、Perplexity 的合法样本或 `NOT_CHECKED`。
- **FR-14 Reporting**：永久分开 Technical Health、Content & Evidence Readiness、Measured AI Visibility；展示 mention/citation/accuracy/coverage/cost/error 与 raw evidence drill-down。
- **FR-15 Experiment**：以兼容 Measurement Scenario 比较 baseline/remeasurement，记录 intervention、cohort、result 与 caveat。
- **FR-16 Jobs and budgets**：异步 job 有 progress/heartbeat/retry/cancel；Tenant/Workspace/Provider/job 预算 80% 告警、100% 硬停。
- **FR-17 Privacy lifecycle**：实现 retention、tenant export、connector revoke、Workspace/Tenant freeze/delete、backup tombstone 与 visible legal hold。
- **FR-18 Audit**：登录、角色、break-glass、credential、crawl、Claim/Artifact approval、publish、budget、export、delete 全部写 tamper-evident Audit Event。
- **FR-19 Registry policy**：Channel/Provider/Method Registry 记录 capability、terms、region、retention、training use、subprocessor 与版本。
- **FR-20 Error semantics**：对用户和 API 保留 `NOT_APPLICABLE/NOT_CHECKED/ERROR/INCONCLUSIVE` 等稳定语义，不把失败伪装成分数。

## Non-Functional Requirements

- **NFR-1 Performance**：认证读取 p95 ≤ 500 ms、写入 p95 ≤ 1 s；异步提交确认 p95 ≤ 2 s。
- **NFR-2 Queue**：健康系统 queue start p95 ≤ 30 s，运行 job 至少每 15 s 更新 heartbeat/progress。
- **NFR-3 Workflow time**：单 Offering + 单 Site 首份 Content Plan ≤ 15 min；20–50 Prompt 首轮多 Surface baseline ≤ 2 h，不含人工/外部限流。
- **NFR-4 Capacity**：至少 100 个并发交互会话、全局 50 个并发 job、单 Tenant 默认 5 个并发 job。
- **NFR-5 Reliability**：Control Plane 月度 SLO 99.5%，RPO ≤ 15 min，RTO ≤ 4 h；发布 exactly-once external effect。
- **NFR-6 Security**：RLS + application policy 双重 tenant scope，secret 不进 Prompt/log/artifact，MFA，SSRF-safe crawl，immutable approval lineage。
- **NFR-7 Privacy**：平台数据固定 Singapore，跨境 Provider processing 需 Owner 显式批准；保留/删除按已确认期限执行。
- **NFR-8 Observability**：OpenTelemetry traces/metrics、structured logs、SLO/queue/budget/publish/backup alerts，且 telemetry redaction 默认开启。
- **NFR-9 Accessibility/i18n**：简体中文首发，domain 保留 locale/market，多语言 Artifact；主路径目标 WCAG 2.2 AA。
- **NFR-10 Supply chain**：exact dependency/action/image pin、SBOM/provenance、vulnerability/license/model/data terms gate。

## Constraints

- 技术栈与版本以 [`DESIGN.md`](./DESIGN.md) 为准，不得静默替换。
- 原始 Playbook 的 evidence-first、approval-first、lineage、failure transparency、tenant isolation 与 no-ranking-guarantee 是硬约束。
- Production Tenant 数据不得进入 GitHub runner、外部 APM 或未批准 Provider。
- Queue 可 at-least-once，但外部发布效果必须 exactly-once。
- 阻塞未知已清零；非阻塞默认值见 [`ASSUMPTIONS.md`](./ASSUMPTIONS.md)。

## Acceptance Criteria

验收标准统一定义在 [`ACCEPTANCE.md`](./ACCEPTANCE.md)，至少覆盖一个真实风格 synthetic brand 的完整闭环、跨租户拒绝、exact revision approval、export fallback、measurement evidence drill-down、budget hard stop、delete/export 和恢复演练。

## Open Questions

### Blocking

- None.

### Non-Blocking

- 见 [`ASSUMPTIONS.md`](./ASSUMPTIONS.md)；这些默认值可由 Owner 配置或在后续决策中替换，但不能削弱硬安全边界。
