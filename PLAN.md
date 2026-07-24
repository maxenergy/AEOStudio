# AEOStudio 完成与生产化执行计划

> 目标仓库：`maxenergy/AEOStudio`  
> 建议保存位置：仓库根目录 `PLAN.md`  
> 当前审计基线：`main` 分支，初始单提交 `d8671ffcc734a76dcd71d87ea9928b3584ea8518`。执行前必须重新读取实际 `HEAD`，若已变化，以最新提交为准并先做差异审计。  
> 执行模型：Qoder / Qwen3.8 Max Preview 作为主编码 Agent。  
> 本计划补充而不覆盖冻结的 `docs/goal/PLAN.md`、`TASKS.md`、`REQUIREMENTS.md`、`DESIGN.md`、`ACCEPTANCE.md` 与 `NON_GOALS.md`。

---

## 0. 给主执行 Agent 的总指令

你是 AEOStudio 的主执行工程 Agent。你的任务不是重写架构，也不是制作演示页面，而是在现有代码基础上，把项目从“本地 synthetic/fake 闭环”推进到“真实数据可用、真实租户可操作、真实发布可审计、具备生产验收证据”的完整版本。

开始修改前，按顺序阅读：

1. `PLAN.md`（本文件）
2. `docs/goal/REQUIREMENTS.md`
3. `docs/goal/DESIGN.md`
4. `docs/goal/TASKS.md`
5. `docs/goal/ACCEPTANCE.md`
6. `docs/goal/NON_GOALS.md`
7. `docs/goal/VERIFY.md`
8. `docs/operations/task-18-evidence-status.md`
9. `docs/system/ARCHITECTURE.md`
10. `docs/system/MODULE_MAP.md`
11. `docs/system/DATA_FLOW.md`
12. `docs/system/RISK_AREAS.md`

执行规则：

- 严格执行 **RED → GREEN → REFACTOR → VERIFY → COMMIT**。
- 每个阶段先写能稳定暴露缺口的行为测试，再写最小实现。
- 不允许为了让测试通过而降低 Tenant 隔离、审批、幂等、证据、错误语义或生产 fail-closed 边界。
- 不允许把本地 mock、fake Provider、静态配置、`SetAlarmState`、OpenTofu validate 或文档声明冒充真实外部验收证据。
- 没有真实 AWS/GitHub/Provider 凭证时，完成全部本地代码、契约、测试和运行手册，但外部门槛继续标记为 `NOT_CHECKED`，并输出准确的阻塞说明。
- 不修改 `GEO_Agent_Implementation_Playbook_v1.0.docx`。
- `docs/goal/VERIFY.md` 只能追加证据，不能覆盖历史记录或删除既有残余风险说明。
- `docs/operations/task-18-evidence-status.md` 只能依据权威远程证据从 `NOT_CHECKED` 改为 `PASS`。
- 不在生产路径保留固定 UUID、`fixture-*`、`fake-*` 默认值、测试账号、测试 Secret ARN 或隐式内存回退。
- 生产日志、trace、队列、GitHub artifact、OpenTofu state 中不得出现 Prompt 正文、原始 Provider 回答、OAuth token、Secret、未脱敏 PII 或租户正文。
- 所有第三方依赖、GitHub Action 和生产镜像继续 exact pin；新增依赖必须通过 license、安全和 release-age 策略。
- 不使用普通 LLM API 输出冒充 ChatGPT Search、Google AI Mode、Google AI Overviews 或 Perplexity 消费界面结果。
- 不生成跨 Provider、跨 Surface 或 Search/AI 混合的单一“GEO 总分”。
- 不承诺排名、引用、推荐、流量、转化或收入。

完成每个阶段后：

1. 运行该阶段 targeted tests。
2. 运行 `pnpm verify:fast`。
3. 阶段结束运行 `pnpm verify` 和相关 Playwright。
4. 将命令、结果、关键证据、变更文件和残余风险追加到 `docs/goal/VERIFY.md`。
5. 做一个或多个语义清晰、可回滚的提交，不把全部改动压成一个不可审查的提交。

---

## 1. 最终 Definition of Done

项目只有同时满足下列条件，才能标记为“全部完成”。

### 1.1 产品闭环完成

一个从未预置数据的新 Tenant，使用正常 UI 而不是复制 UUID，可以完整执行：

`登录 → Tenant/Workspace → Profile → Offering → Site verification → Crawl/Baseline → Evidence/Claim → Prompt/Scenario → Measurement baseline → Content Plan → Brief approval → Artifact generation/review → Channel Package → Authorization → Draft/PR/Webhook publication → Reconcile → Remeasurement → Experiment → Export/Delete/Audit`

### 1.2 真实数据能力完成

- Google Search Console 使用官方授权与官方 API 获取真实 Search 数据。
- Bing Webmaster 使用官方授权与官方 API 获取真实 Search 数据；若官方能力或租户授权不可用，明确显示 `NOT_CHECKED`，不得伪造。
- AI answer consumer surfaces 至少具备完整的合规人工采集/导入流程、证据 manifest、审核和可复测能力。
- 普通模型 API 诊断数据作为单独 acquisition class，不与 consumer surface 合并。
- Production Measurement Worker 实际注入可用的生产 Adapter Registry，而不是只剩 manual-import fallback。

### 1.3 内容智能完成

- Prompt 不再只由固定 5×4 英文模板构成。
- Content Plan 不再依赖固定业务价值、固定风险和固定 Fixture ID。
- Production Artifact Generator 不再只是拼接 Claim statement。
- 生成内容必须是结构化、evidence-grounded、可追溯、可编辑、可审核的三类 Artifact。
- 所有事实必须绑定 Approved Claim revision 与 Evidence snapshot；无法绑定的事实必须被拒绝或明确标注为待证据项。

### 1.4 产品 UI 完成

- 用户无需手填数据库 UUID、对象引用、hash 或 Secret ARN 才能走主流程。
- Profile、Offering、Site、Claim、Prompt Set、Baseline、Plan、Brief、Artifact、Publication、Measurement Run 都有真实列表、选择和详情页面。
- 关键流程具备清晰的下一步、状态、错误、权限说明、空状态、加载状态和审计入口。
- 关键流程通过键盘操作、可见焦点、label/error 和 axe 自动检查。

### 1.5 工程质量完成

- `pnpm verify` 全绿。
- `pnpm test:e2e` 全绿。
- `pnpm test:ops` 全绿。
- `pnpm security:verify` 全绿。
- OpenTofu format/validate 全绿。
- 所有生产包 build 和 runtime smoke 全绿。
- 从空数据库 migration 与当前 schema upgrade migration 均通过。
- `apps/**` 与 `packages/**` 生产路径无未解释 `TODO`、`FIXME`、固定测试 UUID、测试 credential 或 production fake fallback。

### 1.6 生产外部证据完成

`docs/operations/task-18-evidence-status.md` 中九项外部门槛全部有权威证据并为 `PASS`：

1. Backend-bound OpenTofu plan
2. Singapore staging deploy
3. Public staging synthetic smoke
4. Load/SLO
5. RDS/S3 restore drill
6. CloudWatch/X-Ray real-fault alarms
7. Remote SBOM/provenance attestations
8. GitHub protected environments
9. Exact staging digest production promotion

任何一项缺失，最终状态仍为 `HOLD`，即使本地测试全部通过。

---

## 2. 不可破坏的系统不变量

以下项目是所有阶段的全局回归门槛：

1. **Tenant/Workspace 隔离**：所有 Tenant-owned 表含 `tenant_id`，需要时含 `workspace_id`，启用并强制 RLS；runtime role 无 `BYPASSRLS`。
2. **职责分离**：生成者、Agent、Editor 不得批准自己生成的 Claim、Brief 或 Artifact；Publisher 不得修改内容。
3. **Exact revision approval**：审批绑定 exact revision/hash；任意内容变化必须产生新 revision/hash，并使旧审批失效。
4. **发布真实性**：timeout、ambiguous、未授权、条款不满足或远端状态未知时不得标记 `PUBLISHED`。
5. **外部效果幂等**：SQS redelivery、双击、进程崩溃和重试不得产生重复外部内容。
6. **Measurement 可复现**：Provider、Surface、model、model version、scope、region、locale、acquisition method、adapter version、参数、时间、成本和 raw evidence 必须保留。
7. **分母语义**：`ERROR`、`NOT_CHECKED`、`INCONCLUSIVE`、`NOT_APPLICABLE` 不进入 eligible denominator，并单独计数。
8. **数据边界**：Secret、token、Prompt 正文、租户正文和 raw response 不进入普通日志、队列和公开 artifact。
9. **抓取安全**：只抓取明确授权或明确允许的来源；每次 DNS/redirect 重做 SSRF 检查；禁止 private/link-local/metadata 地址。
10. **不伪造结果**：无真实数据就显示 unavailable/unknown/not checked，不能用模板或模拟结果填充仪表板。
11. **不产生跨 Surface 总分**：Technical Health、Content & Evidence Readiness、Search Performance、Measured AI Visibility 分开呈现。
12. **无结果保证**：页面、导出、报告和生成内容都保留 no-guarantee 与不确定性说明。

---

## 3. 阶段 C00：建立可信基线、提交历史和开发入口

### 目标

把当前单一大提交和仓库内自述验证，转化为可重复执行、与 commit 绑定的可信工程基线。

### 工作项

- 重新读取 `HEAD`、当前 diff、workflow 状态和仓库设置。
- 建立工作分支，例如 `completion/production-readiness`。
- 首先运行，不修改代码：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
pnpm test:e2e
pnpm test:ops
pnpm security:verify
```

- 保存真实基线结果到 `docs/completion/BASELINE.md`，记录：
  - commit SHA；
  - Node/pnpm/Docker/PostgreSQL/OpenTofu 版本；
  - 每条命令 exit code；
  - 失败测试清单；
  - 现有 GitHub workflow/check 状态；
  - 外部凭证是否存在。
- 新增或完善根目录 `README.md`：
  - 产品目标；
  - 架构图文字说明；
  - 本地启动；
  - fake runtime 与 production runtime 的明确区别；
  - migration、测试和部署命令；
  - 当前真实完成状态；
  - 不保证排名等声明。
- 完善 `.env.example`，只列变量名、格式和用途，禁止真实值。
- 提供一条明确的本地开发入口，例如 `pnpm dev:bootstrap` 或文档化的 Docker/Testcontainers 启动流程。
- 确认 `README.md`、`.env.example` 和启动脚本不会默认启用 fake runtime 到 production。

### RED 测试

新增 operations/static test，证明：

- 生产构建或 `NODE_ENV=production` 不能启用任意 `fake` mode；
- README 中存在生产与 fake 的明确区分；
- `.env.example` 不包含疑似 Secret；
- 生产路径不使用固定测试 Tenant/Workspace ID。

### 验收

- 基线命令结果可复现。
- 当前失败被准确记录，不能先修改 `VERIFY.md` 声称成功。
- 后续每个提交都能在 GitHub Actions 上得到与 SHA 绑定的结果。

---

## 4. 阶段 C01：移除 Fixture 驱动的产品主流程

### 目标

用户通过正常列表与选择器连接真实业务对象，彻底移除主流程中的固定 UUID、`fixture-*` 和测试默认值。

### 当前重点缺口

重点检查并修复：

- `apps/web/src/app/app/plans/page.tsx` 中的 `FIXTURES`。
- `apps/web/src/app/app/artifacts/page.tsx` 中的 `FAKE_APPROVED_BRIEF_ID`。
- `artifact-fixture-v1` 等 production-visible method policy。
- Prompt 页面中的 `fixture-search-model`、`workspace-fixture-account` 等默认测试输入。
- 任何 UI 要求用户复制数据库 UUID 才能进入下一阶段的设计。

### 后端工作项

为下列资源提供有界、cursor-based、Tenant/Workspace 隔离的列表/搜索 API：

- Profiles 与 Profile revisions
- Offerings 与 Offering revisions
- Sites 与 Site baselines
- Evidence Sources 与 Claims
- Prompt Sets、Prompt revisions、Scenarios
- Measurement Runs 与 MetricSnapshots
- Content Plans、Opportunities、Briefs
- Artifacts 与 approved selectable revisions
- Channel Packages、Authorizations、Publications
- Experiments

要求：

- 使用 Zod contract 单一真源。
- 默认 50、最大 200，opaque cursor，不增加无界 offset。
- 所有列表返回用户可理解的 label、状态、revision、更新时间和 next-action 元数据。
- 不泄漏其他 Tenant/Workspace 对象是否存在。
- 为 Workspace 首页增加只读聚合 read model，用于显示完整流程状态和下一步；不要在 Web 层 N+1 查询十几个 endpoint。

### Web 工作项

- 新增统一 App Shell、Workspace 导航和流程进度面板。
- 每个阶段使用真实对象列表、搜索、选择器和详情链接。
- 从刚创建的对象自动导航到下一步，不要求人工复制 ID。
- 允许从历史 revision 中选择，但必须明确显示当前、已批准、已过期和 stale 状态。
- 所有角色只能看到其允许的动作；权限仍由 API 强制执行，UI 仅做辅助。

### RED 测试

新增：

- `tests/integration/completion-c01-resource-navigation.test.ts`
- `tests/e2e/completion-c01-real-workspace-flow.spec.ts`
- `tests/unit/completion-c01-production-fixture-scan.test.ts`

行为断言：

- 一个全新 Tenant 从 Profile 到 Artifact 全程无需手输 UUID。
- Tenant A 列表绝不出现 Tenant B 对象。
- production Web 源码不存在固定业务 UUID 和 `fixture-*` 默认值。
- 列表分页稳定、有界且 cursor 不可伪造越权。

### 验收

- 删除所有 production 主流程 fixture 常量。
- 新用户可从 Workspace 首页进入并继续完整流程。
- `pnpm verify` 和相关 E2E 全绿。

---

## 5. 阶段 C02：Evidence 上传、公共来源与竞品/替代方案研究

### 目标

让 Claim、Comparison 和 Content Plan 使用真实 Evidence，而不是要求用户手工填写 objectRef、SHA-256 或测试来源。

### 工作项

- 新增安全的 Evidence Upload 流程：
  - API 创建 upload intent；
  - 使用 Tenant/Workspace-bound capability 或预签名上传；
  - 服务端计算/验证 hash、content type、size；
  - 完成后生成 immutable EvidenceSnapshot；
  - Browser 不提交自称可信的 hash/objectRef。
- 支持文本、Markdown、PDF、CSV 和常见图片元数据；解析失败保留原始 snapshot 与明确状态。
- 将 `Public Evidence Source` 与 `Owned Site` 严格区分：
  - Owned Site 需要所有权验证；
  - Public source 只作为具名、具 license/publicity、具 snapshot/hash 的证据来源；
  - 不允许借 Public source 绕过全网抓取限制。
- 增加行业中立的 `Alternative/Competitor Reference`：
  - 名称、官网、Offering 描述、market/locale；
  - 只引用已登记的公共 Evidence；
  - 不把竞品名称写成平台级 enum；
  - Comparison Artifact 必须同时引用自身证据和独立竞品证据。
- 增加 Evidence 预览、版本、license/publicity、expiry 和 Claim 绑定 UI。
- PII/Secret 检测必须在进入生成与外部 Provider 前执行。

### RED 测试

- Browser 无法伪造 objectRef/hash。
- 跨 Tenant upload completion 被拒绝。
- Comparison 没有独立竞品证据时只能产生 Evidence Task，不能成为 publish-ready Brief。
- 上传对象中含 Secret/高风险 PII 时，外发 Provider policy 默认阻断。

### 验收

- Claim 创建不再要求普通用户填写 SHA-256/objectRef。
- Comparison 有真实、独立、可下钻的 Evidence lineage。
- Export/Delete/retention 覆盖新对象。

---

## 6. 阶段 C03：深度 Site Technical / Content / AEO 诊断

### 目标

把现有“HTTP/title/meta/canonical/JSON-LD 是否存在”的检查，扩展为可用于真实优化决策的站点基线。

### 架构要求

- 将 `apps/worker/src/site-crawl-handler.ts` 中抓取、解析、图构建和诊断职责拆开。
- 新增 versioned Analyzer Registry，例如：
  - `technical-html-v1`
  - `indexability-v1`
  - `structured-data-v1`
  - `content-evidence-v1`
  - `answer-readiness-v1`
  - `internal-link-graph-v1`
- 使用经过 license/security 审核的 HTML parser，不继续用正则承担完整 DOM 解析。
- 原始 snapshot immutable；诊断结果绑定 snapshot hash 与 analyzer version。
- 不产生跨模块万能总分；每个 section 保存独立指标、严重性、证据和建议。

### 必须实现的诊断

#### Technical Health

- HTTP 状态、redirect chain、最终 URL。
- robots.txt、meta robots、X-Robots-Tag。
- sitemap 覆盖、无效 URL、重复 URL、孤儿页。
- canonical 缺失、跨域、冲突、循环和多 canonical。
- title/H1/meta description 缺失、重复、过长、过短。
- HTML `lang`、hreflang 配对与默认语言。
- broken internal links、redirect links、深度、入链/出链。
- content type、页面大小、抓取超时和受限原因。
- JS-rendered adapter 作为显式可选能力，不在默认 crawler 中偷偷执行浏览器脚本。

#### Structured Data / Entity

- JSON-LD 可解析性。
- Schema.org type 与必要字段检查。
- Organization、Product、Service、Article、FAQ、Breadcrumb 等实体关系一致性。
- URL、名称、logo、sameAs、作者、日期、产品/服务标识的一致性。
- 结构化数据必须显示具体 snapshot 和 JSON pointer，不只显示“存在”。

#### Content & Evidence Readiness

- 页面正文抽取、主内容 hash、近似重复内容。
- 定义、步骤、比较、FAQ、规格、证据、引用、作者和更新时间结构。
- 页面中的事实与 Approved Claim 覆盖矩阵。
- 无 Evidence 支撑的量化或效果性表述。
- Prompt → 页面覆盖、Claim → 页面覆盖、Offering → 页面覆盖。
- answer-ready 段落、清晰标题层级和可引用片段。

#### AI Crawler Policy

- 通过配置化 Registry 检查相关 user-agent policy，不把任何具体 bot 名称写死为业务模型。
- 明确区分 crawl permission、training permission 和 search/index permission；不能从 robots 推导法律结论。

### UI

- Site 概览、页面清单、问题聚类、单页证据、链接图摘要。
- 每个 finding 包含：严重性、影响范围、证据、建议、方法版本、受影响页面。
- 可从 finding 创建 Content Opportunity 或 Evidence Task。

### RED 测试

- malicious HTML/JSON-LD 不能执行脚本或污染日志。
- redirect/DNS 每跳重新校验 SSRF。
- sitemap/robots/canonical/hreflang/link graph 使用确定性 fixtures。
- 相同 snapshot + analyzer version 生成相同结果。
- analyzer version 变化产生新结果，不修改历史结果。

### 验收

- 一个真实官网的基线能够产生可行动的 technical、content、evidence 和 answer-readiness 问题。
- Content Plan 能引用这些 finding，而不是只引用一个 baseline ID。

---

## 7. 阶段 C04：真实 Search Provider Adapter 与合规 AI Surface 采集

### 目标

完成生产 Measurement Adapter 层，使系统不再只有 fake/manual-import 才能产生数据。

### 7.1 Provider/Surface Registry

- Registry 数据必须包含：
  - providerKey / surfaceKey；
  - surfaceKind；
  - acquisitionClass；
  - adapterKey/version；
  - official/sandbox/manual 状态；
  - region、retention、training、subprocessors、terms；
  - required scopes；
  - rate policy；
  - unavailable reason。
- Owner 可管理 cross-border 和 purpose approval。
- Worker 每个外部 slot 前重新读取当前 policy、authorization、terms 和 lease。

### 7.2 Google Search Console

- 使用官方 OAuth 与官方 API。
- Site/Property 必须属于当前 Tenant/Workspace authorization。
- 保存 immutable raw response reference 与标准化查询维度。
- 支持按日期、country、device、page、query 等官方可用维度读取，但不得无界拉取。
- Search performance 与 AI answer visibility 永久分开展示。
- 默认 CI 使用 recorded contract fixture，不调用真实 Google 账号。

### 7.3 Bing Webmaster

- 使用官方授权/API 与版本化 contract。
- 与 GSC 相同地保存授权、scope、raw evidence、标准化结果和失败语义。
- 官方能力不可用或当前账号无权限时返回 `NOT_CHECKED`/明确 unavailable reason。

### 7.4 AI Answer Consumer Surfaces

- 继续支持 Reviewed Manual Import，但升级为产品功能：
  - CSV/JSON 模板下载；
  - slot manifest；
  - Prompt/scope/repetition 完整性校验；
  - raw answer、citation、截图/页面证据、时间、账户和采集说明；
  - Reviewer 审核；
  - 缺失槽位自动 `NOT_CHECKED`，不伪造成功。
- 只有在平台条款允许、用户明确授权且安全审查通过时，才增加浏览器采样 Adapter。
- 普通 OpenAI-compatible、Gemini、Qwen 等模型 API 只能作为 `MODEL_API_DIAGNOSTIC`，不得标成 consumer surface。

### 7.5 Production Runtime Composition

- `createProductionWorkerRuntime` 必须注入真实 `MeasurementSurfaceAdapterRegistry`。
- 缺少授权的 Adapter fail closed，但不应让整个 Worker 无法启动；该 surface 以 unavailable/not checked 表示。
- Adapter credential 从 Tenant-bound Secret capability 获取，不经过 Browser、Job payload 或普通 DB 字段。

### RED 测试

- recorded official API contract 发生 schema drift 时 fail closed。
- authorization revocation 后下一个 slot 不再发送外部请求。
- policy/terms/cross-border 未批准时零外部调用并产生 `NOT_CHECKED`。
- lease 丢失后零业务提交。
- 任何 consumer/manual/model API acquisition class 不得被合并。

### 验收

- 在 sandbox 或受控真实账号完成一次 GSC 数据读取。
- 在可用条件下完成一次 Bing 数据读取；不可用时保留权威 unavailable evidence。
- 一个 20 Prompt × 3 repetition 的 AI consumer manual baseline 可审核、可运行、可下钻。

---

## 8. 阶段 C05：Prompt Research Intelligence

### 目标

让 Prompt Set 来自 Profile、Offering、Claims、市场、站点内容、替代方案和历史测量，而不是固定英文模板。

### 架构

新增可替换的 `PromptResearchGenerator` port：

- `DeterministicPromptGenerator`：仅用于测试、离线 fallback 和 contract 验证。
- `StructuredLlmPromptGenerator`：生产可配置 Provider，输出必须通过 Zod schema。
- 每次生成保存：provider、model、model version、template version/hash、input revision IDs、cost、生成时间和 actor。
- Agent 只能生成 DRAFT，不能批准。

### 输入

- exact Profile revision；
- exact Offering revision；
- Approved Claim revisions；
- Site content inventory 和 findings；
- Alternative/Competitor References；
- market + locale + region；
- 历史 Prompt Set 与 Measurement gaps；
- 用户指定的业务目标和优先级。

### Prompt taxonomy

至少覆盖：

- branded / non-branded；
- definition；
- problem / solution；
- how-to；
- use case；
- specification；
- evidence / trust；
- comparison / alternative；
- purchase/adoption；
- troubleshooting；
- local/region；
- persona；
- journey stage；
- query intent。

### 质量控制

- 20–50 条，1–3 scopes。
- 去重、近似去重、覆盖度和多样性检查。
- 不生成无 Evidence 可回答的效果承诺；这类问题标为 evidence gap。
- 支持中文、英文及其他 locale，不再默认只生成英文。
- UI 显示生成依据、taxonomy 分布和缺口，用户可逐条编辑、禁用、增加和重新分类。

### RED 测试

- 相同 deterministic 输入产生相同 Prompt Set。
- LLM 输出缺字段、重复严重、越界数量或含禁止保证时被拒绝。
- 修改 Profile/Offering/Claim revision 后旧 Prompt approval 自动 stale。
- 同一 actor 不能批准自身生成的 revision。

### 验收

- 真实 AIBOX Offering 能生成一组中英文、分类完整、非模板重复的 Prompt Set。
- 每条 Prompt 可追溯到输入 revision 和生成策略。

---

## 9. 阶段 C06：数据驱动 Content Plan 与 Brief

### 目标

用真实测量和站点缺口生成可解释计划，替换固定 90/82/78 等静态分值和固定三行模板逻辑。

### 数据模型

每个 Opportunity 保存独立信号向量，不只保存最终分数：

- business priority（用户/Owner 配置）；
- evidence readiness；
- technical readiness；
- content coverage gap；
- Prompt coverage gap；
- Search opportunity；
- AI visibility observation；
- competitor/alternative evidence gap；
- effort；
- risk；
- freshness/expiry；
- method policy version。

规则：

- 不同 Surface 信号保持独立；可以在同一 plan 中并列说明，但不能制造跨 Surface 科学含义不明的总分。
- 若需要排序，只能使用明确、versioned、可解释的 policy；UI 必须显示每个分量和权重。
- 没有 measurement 时 visibility 保持 `UNKNOWN`，但其他真实信号仍可计算。
- 每个 Brief 必须引用真实 Prompt、Claim、Evidence、Site finding 和 source revision。
- 三类 MVP Artifact 继续保留：Definition/Offering、Comparison、Technical/Evidence。
- Evidence 不足时只创建 Evidence Task，不创建伪 publish-ready Brief。

### 页面级 PageSpec

为每种 Brief 生成 versioned PageSpec，例如：

- 目标受众与 scope；
- 目标 Prompt；
- 页面 intent；
- 标题/H1/章节结构；
- 必须覆盖的 Claim；
- Evidence 与 citation requirements；
- comparison fairness；
- metadata；
- JSON-LD 类型；
- internal links；
- locale/market；
- disclosure；
- acceptance checklist。

### RED 测试

- 任一 dangling reference 使计划 `INVALID`。
- expired/stale Claim 不能进入 ready Brief。
- 缺 comparison independent evidence 只能生成 Evidence Task。
- 同一 inputs + policy version 产生 deterministic plan/hash。
- policy version 变化产生新 plan，不覆盖历史。

### 验收

- UI 中不再出现固定 Fixture ID。
- AIBOX 真实数据能产生至少三类有依据的 Brief，并显示为什么排序。

---

## 10. 阶段 C07：Evidence-Grounded Artifact Writer

### 目标

把现有 Claim 拼接器升级为安全、结构化、可追溯的生产内容生成引擎。

### 架构

保留 `ArtifactGenerator` port，增加：

- deterministic generator：仅 test/fallback；
- production structured LLM generator；
- provider registry 与 budget/cost policy；
- strict structured output schema；
- generation attempt、raw response reference、model/version、prompt/template hash；
- bounded retry 与 invalid-output quarantine。

### 安全输入包

Writer 只能读取：

- approved exact Brief；
- approved current Claims；
- exact Evidence snapshots/snippets；
- exact Profile/Offering revisions；
- approved Prompt revision；
- exact Site baseline/findings；
- locale/market/method policy。

不得读取整个 Workspace、其他 Tenant、Secret 或未批准草稿。

### 输出要求

每个 Artifact 至少包含：

- title；
- meta title / meta description；
- summary；
- structured sections；
- Claim map；
- Evidence citation map；
- FAQ/definition/comparison table 等 PageSpec 指定结构；
- internal link recommendations；
- JSON-LD；
- disclosure；
- unsupported assertion report；
- schema/method/model/template version；
- content hash 与 lineage。

### 生成后验证

- 所有事实句必须映射到 Claim revision，无法映射则拒绝或移入“需要证据”区，不能直接发布。
- 数值、单位、适用范围和条件必须与 Claim 一致。
- Comparison 必须平衡呈现并引用独立 Evidence。
- 禁止保证排名、引用、推荐、流量、转化或收入。
- JSON-LD 通过 schema 和安全校验。
- HTML 输出继续进行严格 escaping/sanitization。
- 人工编辑创建 immutable next revision；显示语义 diff、Claim diff 和 Evidence diff。

### RED 测试

- 模型幻觉加入不存在数值时被阻断。
- 引用不存在 Claim 时被阻断。
- prompt injection Evidence 不能改变系统规则或读取 Secret。
- 修改 Claim/Evidence 后旧 Artifact approval 变 stale。
- 同一 approved exact input + deterministic adapter 产生相同 hash。
- LLM Provider timeout/invalid JSON 不生成成功 Artifact。

### 验收

- production 默认不再使用 `DeterministicArtifactGenerator` 生成客户内容。
- 三类 Artifact 对真实 AIBOX 数据产生可读、高质量、可审核结果。
- 任一事实可下钻到 exact Claim/Evidence。

---

## 11. 阶段 C08：Publishing 产品化与真实受控写入

### 目标

把已经存在的 Adapter 代码变成普通用户可配置、可预览、可回查、可回滚的产品流程。

### 授权体验

- 不再把“手填 AWS Secrets Manager ARN”作为普通用户的唯一入口。
- 为 GitHub、WordPress/WooCommerce、Shopify、Signed Webhook 提供 Connector setup wizard。
- OAuth Provider 使用 callback、state、PKCE 和 server-side session。
- 非 OAuth credential 通过受控 API 写入 Tenant-bound Secrets Manager；Browser 不回读 credential。
- UI 显示 scopes、target、terms、processing region、retention、training、subprocessors、validation status 和 expiry。

### 发布工作台

- Artifact → exact approved revision → Channel → Preview → Authorization → Eligibility → Publish。
- 显示 exact package manifest、planned diff、Claim/source map 和 target。
- 提供 Publication history 列表和详情。
- 对 ambiguous 状态只允许 reconcile，不允许盲重试。
- 对安全 terminal failure 提供新的 reviewed retry intent。
- 对支持 rollback 的 Adapter 提供显式 rollback command/API/UI：
  - 新 Job；
  - exact rollback handle；
  - role/approval 检查；
  - attempt history；
  - remote readback；
  - audit event；
  - 失败不得删除历史。
- GitHub 只创建 PR，不直接写 protected branch。
- WordPress/WooCommerce 与 Shopify 默认只创建 draft/unpublished content。
- Signed Webhook 必须验证 endpoint ownership、签名、receipt 与 replay protection。

### 真实验证顺序

1. GitHub sandbox/private test repository 创建一个真实 PR。
2. WordPress test site 创建一个真实 Draft。
3. Shopify development store 创建一个真实 unpublished Page/Product。
4. Signed Webhook test receiver 完成 delivery/reconcile。

每一个 Adapter 均需验证：

- 第一次效果；
- 双击/重投不重复；
- timeout after effect；
- reconcile；
- stale approval/currentness 阻断；
- authorization revoke；
- rollback 或明确无自动 rollback。

### RED 测试

- Browser 篡改 target/scope/hash 不可绕过 server-side reread。
- credential 不出现在 response、log、Job、PublicationRecord。
- duplicate delivery 最多一个远端效果。
- ambiguous 不能自动变 success。
- stale Prompt/Claim/Evidence/Artifact/Authorization 在执行前被最终 currentness fence 阻断。

### 验收

- 至少一个真实 Git PR 或 WordPress Draft 流程从 UI 完整跑通。
- PublicationRecord、attempts、remote state、审计和 rollback/reconcile 证据完整。

---

## 12. 阶段 C09：Measurement、趋势、调度与 Experiment 产品化

### 目标

在现有可靠 MetricSnapshot/Experiment 基础上，完成长期监测产品体验。

### 工作项

- Measurement Scenario 列表、版本、复制、停用和比较。
- Scheduler：
  - baseline；
  - weekly/monthly remeasurement；
  - Owner/Analyst 可暂停；
  - budget、rate policy、authorization、terms、currentness 每次执行前重查。
- Dashboard 永久分区：
  1. Technical Health
  2. Content & Evidence Readiness
  3. Search Performance
  4. Measured AI Visibility
- 每个趋势只比较 compatibility 完全一致的 cohort。
- Provider/model/surface/acquisition/version 变化时自动新建 series 或提示 rebaseline。
- 显示样本量、eligible denominator、excluded counts、cost、时间窗口和 uncertainty。
- Raw PromptRun 支持搜索、分页、导出和 Evidence drill-down。
- 支持按 Prompt taxonomy、scope、provider、surface、page/Offering 过滤。
- Measurement alert：
  - significant availability drop；
  - citation loss；
  - provider error spike；
  - cost anomaly；
  - stale authorization/policy；
  - 但不得宣称因果。
- Experiment 只能选择服务器返回的兼容组合，显示 baseline/intervention/remeasurement timeline 和 observed association caveat。

### RED 测试

- 不兼容 cohort 不能进入同一趋势或 delta。
- mixed currency 不换汇、不相加。
- scheduler redelivery 不产生重复 Run。
- authorization/policy 变化后后续 scheduled run 进入 `NOT_CHECKED`/blocked，而不是继续发送。
- raw evidence 列表分页与 metric source IDs 完全一致。

### 验收

- AIBOX 有一次 baseline、一次发布干预、一次 remeasurement 和一个兼容 Experiment。
- 用户能从任何 metric 下钻到 raw evidence，从任何事实下钻到 Claim/Evidence。

---

## 13. 阶段 C10：完整产品 UX、可访问性和维护性

### 目标

将当前工程工作台升级为可交付客户使用的简体中文产品界面，同时保留 locale/market 多语言能力。

### 工作项

- 统一 App Shell：侧边栏、Workspace switcher、breadcrumb、用户/角色、全局状态。
- Workspace 首页显示：
  - onboarding 完整度；
  - Site 状态；
  - Evidence/Claim readiness；
  - Prompt/Measurement 状态；
  - Plan/Artifact/Publication 状态；
  - 下一步动作；
  - budget/alerts。
- 将超大 `page.tsx` 拆分为可测试的 server actions、query modules、form components 和 view components。
- 统一表单错误：字段路径、错误代码、中文说明、保留用户输入。
- 统一状态徽章，不只依赖颜色。
- 所有 destructive/publish/revoke/delete 操作增加 exact target 确认和结果页。
- 响应式适配桌面和平板。
- i18n：UI 首发简体中文；Artifact/Prompt/market 数据使用 locale，不把中文写死到 domain。
- Accessibility：
  - keyboard-only；
  - focus management；
  - label/description/error association；
  - aria-live；
  - table caption；
  - axe checks；
  - 对比度和 reduced motion。
- 空状态和 unavailable 状态必须诚实说明下一步，不显示虚假图表。

### RED 测试

新增完整用户旅程 E2E，至少覆盖 Owner、Editor、Reviewer、Publisher、Analyst、Viewer。

- Owner 建 Tenant/预算/授权。
- Editor 建知识、Evidence、Prompt draft、Artifact revision。
- Reviewer 独立批准。
- Publisher 发布 exact approved revision。
- Analyst baseline/remeasurement/Experiment。
- Viewer 只读。
- axe 对关键页面无 blocking violation。

### 验收

- 普通用户不需要理解内部 UUID、objectRef、Secret ARN、hash 计算或数据库状态机。
- 所有关键流程在 UI 内闭环。

---

## 14. 阶段 C11：真实 AIBOX 租户端到端验收

### 目标

用真实业务数据证明系统不是只对 synthetic fixture 有效。

### 数据范围

以 AIBOX 边缘智能安防解决方案为真实租户，但不能把安防字段固化为平台 enum、route 或模板。

录入至少：

- 公司/品牌 Profile；
- 1–3 个 Offering；
- 官网和授权 Site；
- 原理、规格、功能、场景、兼容性；
- 真实 Evidence 文档、产品参数和案例材料；
- 竞品/替代方案与独立公开 Evidence；
- 中文市场 scope，必要时增加英文/新加坡 scope。

### 必须完成的真实流程

1. 创建真实 Tenant/Workspace。
2. Profile/Offering revisions。
3. 验证并抓取真实官网。
4. 查看深度 technical/content/AEO findings。
5. 上传 Evidence 并创建 Approved Claims。
6. 生成、编辑并批准 20–50 个 Prompt。
7. 运行 GSC/Bing Search 数据或记录明确的授权不可用状态。
8. 完成一个 AI consumer manual baseline。
9. 生成数据驱动 Content Plan 与三类 Brief。
10. 生成三类 LLM Artifact。
11. 独立 Reviewer 审批 exact revision。
12. 创建 Git PR 或 WordPress Draft。
13. Reconcile 并记录 Publication。
14. 执行 remeasurement。
15. 创建 Experiment。
16. 导出 Tenant 数据。
17. 执行 deletion rehearsal，不删除正式唯一数据。

### Evidence 输出

创建 `docs/completion/aibox-acceptance/`，保存脱敏证据索引：

- run IDs、revision IDs、hash；
- screenshots；
- API envelope；
- publication remote reference；
- measurement summary；
- Experiment summary；
- 所有 raw/secret/PII 仍留在受控存储，不复制进 Git。

### 验收

- 全流程没有人工修改数据库、手填内部 UUID 或替换源码 Fixture。
- AIBOX 只是验收租户，不成为平台硬编码行业。

---

## 15. 阶段 C12：GitHub、AWS Singapore 与九项权威外部 Gate

### 前提

只有在具名 AWS 账号、GitHub 仓库权限、域名、Cognito、staging/production environment 和审批人可用时执行。缺少凭证时，完成脚本和 runbook 后保持 `NOT_CHECKED`。

### 15.1 GitHub 仓库治理

- 保护 `main`。
- 必须通过 verify、E2E、security、build/attest 才能合并。
- staging/production 使用 protected environments。
- 指定具名 Reviewer，禁止 self-review。
- 只允许 main 部署。
- 确认 workflow permissions 最小化、Actions SHA pinned。
- 保存 repository/environment settings 的权威证据。

### 15.2 Backend-bound OpenTofu Plan

- 使用 reviewed remote backend 和实际变量。
- 仅 `ap-southeast-1` data plane。
- 计划中无 EKS、OpenSearch、跨区 replica 或未批准公共 endpoint。
- protected `staging-plan` workflow 产出不可变 plan/evidence artifact。

### 15.3 Singapore Staging Deploy

- 构建一次镜像，记录 API/Web/Worker/Recovery/ADOT exact digest。
- SBOM、provenance 和 scan 绑定同一 digest。
- migration 使用独立 role 和 one-off task。
- ECS、ALB、RDS、S3、SQS、Secrets、CloudWatch/X-Ray 部署完成。
- 输出 public staging URL、task definition ARN 和 digest manifest。

### 15.4 Synthetic Smoke

从公网 staging URL 运行真实 smoke，输出 `aeostudio-staging-smoke.v1`：

- login/session；
- Tenant isolation；
- create/read/write；
- Job ack；
- site/crawl minimal path；
- package/export；
- health/readiness；
- no secret/PII leakage。

### 15.5 Load/SLO

运行 k6 真实 staging 测试：

- 100 concurrent sessions；
- 50 global jobs；
- 5 jobs/Tenant；
- read p95 ≤ 500 ms；
- write p95 ≤ 1 s；
- job ack p95 ≤ 2 s；
- healthy queue start p95 ≤ 30 s；
- 无 Tenant leakage、budget bypass 或失控 error rate。

保留原始 summary、run ID、commit/digest 和 CloudWatch/X-Ray 关联。

### 15.6 Restore Drill

执行真实 RDS/S3 恢复：

- 记录恢复点；
- 记录开始/结束时间；
- 测量 RPO ≤ 15 min；
- 测量 RTO ≤ 4 h；
- 恢复后运行 smoke；
- 输出 `aeostudio-restore-drill.v1`；
- 不把成功 backup job 冒充 restore drill。

### 15.7 CloudWatch/X-Ray Real Fault Evidence

按冻结的 25-alarm matrix：

- 每个告警有 reviewed `REAL_FAULT` injector；
- 真实指标超过 threshold；
- 保存原始 `OK → ALARM → OK` HistoryData；
- CloudTrail 因果窗口内零 `SetAlarmState`；
- 保存匹配 X-Ray trace；
- 输出 `aeostudio.synthetic-fault-evidence.v2`。

没有 reviewed injector 的行继续 `NO_REVIEWED_REAL_FAULT_INJECTOR`。

### 15.8 Supply Chain

- main workflow verify/security/build 成功。
- exact digest CycloneDX SBOM。
- signed provenance attestation。
- OSV、Trivy、Gitleaks、license、Action pins 无未批准 blocking issue。
- 例外必须具名、范围明确、有 expiry。

### 15.9 Production Promotion

- 只提升已经通过 staging 验收的 exact digest。
- protected environment 人工审批。
- production 不重新构建镜像。
- 记录 deployment、digest、审批和 smoke。
- 失败进入单一、可审计的 recovery/rollback 流程。

### 验收

九项 gate 每项都必须有实际 artifact、URL、run ID、digest、时间和审批信息。完成后才可更新 `docs/operations/task-18-evidence-status.md`。

---

## 16. 阶段 C13：最终审计、文档和 Release

### 代码审计

- 搜索 production 路径中的：

```text
TODO
FIXME
fixture
fake
00000000-
example.test
test-secret
test-token
console.log
```

每个命中必须删除、限制到 test-only 或在审计记录中说明合理用途。

- 检查所有 runtime mode、Adapter、fallback 和 environment gate。
- 检查所有 mutation 是否有 auth、CSRF、TenantContext、RBAC、expected revision/hash 或 idempotency。
- 检查所有外部 effect 是否有 final currentness fence、reconcile 和 attempt history。
- 检查所有 list/query 是否有界、分页并使用 Tenant/Workspace predicate。
- 检查所有新增表的 RLS、FK、unique constraint、append-only/currentness 规则。
- 检查所有日志和 telemetry redaction。

### 最终命令

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm contracts:check
pnpm test:integration
pnpm test:ops
pnpm build
pnpm smoke:runtime
pnpm test:e2e
pnpm security:verify
tofu fmt -check -recursive
```

随后执行所有 staging、load、restore、alarm、attestation 和 production promotion Gate。

### 文档

更新或新增：

- `README.md`
- `.env.example`
- `docs/completion/BASELINE.md`
- `docs/completion/IMPLEMENTATION_SUMMARY.md`
- `docs/completion/FINAL_AUDIT.md`
- `docs/completion/EVIDENCE_INDEX.md`
- Provider/Adapter setup runbooks
- local development runbook
- staging deployment runbook
- incident/reconcile/rollback runbook
- restore runbook
- security/privacy data-flow说明
- `docs/goal/VERIFY.md` 追加最终证据
- `docs/operations/task-18-evidence-status.md` 按真实证据更新
- `docs/goal/ACCEPTANCE.md` 的 manual checklist 依据真实证据勾选

### Release 条件

只有在：

- 本地所有 gate 全绿；
- AIBOX 真实租户闭环完成；
- 九项外部 Gate 全部 PASS；
- manual checklist 10/10；
- Final Audit 无 P0/P1；
- production exact digest smoke 成功；

才创建正式 release/tag。否则状态继续为 `HOLD` 或 `BETA`。

---

## 17. 推荐提交/PR 顺序

不要把全部修改做成一个提交。建议至少按以下边界提交：

1. `chore: establish completion baseline and repository documentation`
2. `feat: add tenant-scoped resource lists and remove production fixture navigation`
3. `feat: add secure evidence upload and alternative research sources`
4. `feat: add versioned deep site diagnostics and content coverage analysis`
5. `feat: add production search provider adapters and measurement registry composition`
6. `feat: add structured prompt research generation and approval lineage`
7. `feat: make content planning data-driven and produce versioned page specs`
8. `feat: add evidence-grounded structured artifact generation`
9. `feat: productize connector authorization publication reconcile and rollback`
10. `feat: add scheduled measurement trends alerts and experiment workflow`
11. `feat: complete customer-facing workspace UX and accessibility`
12. `test: add real-tenant AIBOX acceptance flow`
13. `ops: complete protected staging load recovery observability and attestations`
14. `release: promote exact verified digest and publish final evidence index`

每个 PR/提交必须包含 targeted tests 和对应 `VERIFY.md` 追加记录。

---

## 18. 每阶段统一验收模板

在 `docs/goal/VERIFY.md` 追加：

```markdown
### Completion Cxx — <阶段名称>

- Base SHA:
- Commit SHA(s):
- RED command:
- RED observed failure:
- GREEN command:
- GREEN result:
- Full regression command/result:
- Browser evidence:
- External evidence:
- Files changed:
- Data migrations:
- Security/privacy review:
- Residual risk:
- Completed at / actor:
```

严禁写“全部通过”而不提供 exact command、exit code、run ID 或 artifact。

---

## 19. 外部凭证缺失时的交付方式

如果 Qoder 环境没有 AWS、GitHub protected environment、Google/Bing、WordPress、Shopify 等凭证：

1. 不询问与现有文档已经回答过的问题。
2. 完成全部本地实现、契约、recorded fixtures、fail-closed 行为、setup UI 和 runbook。
3. 创建 `docs/completion/BLOCKED_EXTERNAL.md`，逐项写明：
   - 缺少的账号/角色/变量；
   - 最小权限；
   - 精确执行命令；
   - 预期 artifact schema；
   - 成功判定；
   - 安全注意事项。
4. 外部 gate 保持 `NOT_CHECKED`。
5. 最终总结必须明确区分：
   - code complete；
   - local verified；
   - sandbox verified；
   - staging verified；
   - production verified。

---

## 20. 交给后续复审的最终输出

完成后，主 Agent 必须提交以下信息，供下一次独立审核：

- 最终 branch 和 HEAD SHA。
- 从本计划基线到 HEAD 的 commit 列表。
- changed files 汇总。
- migration 列表。
- 所有测试命令与结果。
- GitHub Actions run URLs/IDs。
- staging/production deployment、image digest、SBOM/provenance。
- GSC/Bing/AI Surface Adapter 状态。
- 真实发布 remote reference 和幂等/reconcile/rollback 证据。
- AIBOX 完整闭环 Evidence Index。
- 九项外部门槛状态。
- 所有仍未完成或仍为 `NOT_CHECKED` 的项目。

独立复审将重点检查：

1. 是否真正移除了生产 Fixture，而不是把常量换了位置。
2. 用户是否无需内部 ID 就能走完整流程。
3. Measurement 是否真实接入 Provider，而不是继续只有 manual/fake。
4. Prompt、Plan、Artifact 是否真正数据驱动、evidence-grounded。
5. 发布是否有真实远端效果且不重复。
6. Site 诊断是否超过简单 presence check。
7. Tenant/RLS/approval/currentness 是否无回归。
8. 外部 `PASS` 是否都有权威证据。
9. 是否仍诚实保留 `NOT_CHECKED`、不确定性与 no-guarantee 语言。
