# Data Flow

## 1. Authentication and Tenant Context

1. Browser 跳转 Cognito managed login，使用 Authorization Code + PKCE。
2. `apps/web` BFF 换取 token，把 token 加密保存在有 TTL 的 server-side session；Browser 仅收到 opaque HttpOnly cookie。
3. API 验证 identity 后，从 PostgreSQL 加载 active Membership/RoleBinding。
4. API 在数据库 transaction 内设置 transaction-local `tenant_id/workspace_id` context；RLS 与 application policy 双重执行。
5. 授权失败返回稳定 error code 并写安全 Audit Event，不回显目标资源是否存在。

## 2. Workspace Onboarding

1. Owner 创建 Tenant/Workspace。
2. Editor 填写 Company/Brand Profile 与一个或多个行业中立 `Offering`。
3. 动态属性以 versioned schema + value 保存；不把行业示例映射为固定字段。
4. Profile/Offering 每次修订生成 revision/hash 与 Audit Event。

## 3. Site Verification and Crawl

1. Editor 登记 Site 与期望验证方法。
2. API 生成 DNS/file/OAuth challenge；验证成功后记录 ownership evidence。
3. API 在预算与 policy 通过后写 Job + transactional outbox。
4. Relay 把 outbox 投递到 SQS；Worker 通过 SSRF-safe fetch policy 抓取授权 host。
5. HTML、headers、robots/sitemap 与解析结果写 S3；hash/metadata/technical findings 写 PostgreSQL。
6. Crawl 失败保留原因、attempt、retry eligibility，不伪造 baseline。

## 4. Evidence and Claim Approval

1. Evidence Source 来自租户上传、授权 crawl 或具名公开来源。
2. Worker/Editor 抽取 proposed Claim，并绑定 exact evidence snippet、source hash、locale/market 与有效期。
3. Reviewer 检查事实、技术、法律与品牌 policy；只批准 exact Claim revision。
4. APPROVED Claim 才能进入 content brief；过期或证据变化会使下游 Artifact 进入复核队列。

## 5. Prompt, Plan and Artifact Generation

1. 系统根据 Profile、Offering、site baseline 与已批准 taxonomy 提议 Prompt Set。
2. Reviewer 确认 20–50 Prompt、1–3 个 `market + locale + region` scopes 与 Measurement Scenario。
3. Opportunity engine 使用 business value、evidence readiness、visibility gap、effort 与 risk 生成 Content Plan。
4. Writer job 只收到 approved brief、Approved Claim IDs 与非秘密上下文。
5. 输出 Artifact envelope、revision、content payload、sourceArtifactIds、Claim map 与 hash。
6. Reviewer 批准 exact revision；任何内容变化都会产生新 hash 并使旧 approval 失效。

## 6. Review-to-Publish

1. 已批准 Artifact 被转换为目标 Channel Package 与 preview。
2. API 从 Channel Registry 检查 Adapter capability、terms status、authorization scope 与 revision/hash。
3. 不具备真实写入资格时返回 `EXPORT_ONLY`，生成下载/人工交接包，不伪报成功。
4. 具备资格时，Publisher 触发 publish command；API 预留 budget、创建 PublicationRecord 与 idempotency key，再入队。
5. Worker 临时读取 Secrets Manager credential，调用 Adapter，并回查远端状态。
6. 成功、失败、remote ID、attempt、rollback handle 与 exact revision 全部记录；重试复用 idempotency key。

## 7. Measurement and Experiment

1. Analyst 启动 baseline/re-measurement；系统固定 Provider、surface、model/version、scope、fresh-session/search 参数与重复次数。
2. Worker 每个 Prompt/Surface 至少执行三次；原始回答、citation、screenshot、成本与错误写入证据存储。
3. Parser 生成 mention、citation、accuracy、coverage 等派生结果，并保存 method/schema version。
4. `ERROR/NOT_CHECKED/INCONCLUSIVE/NOT_APPLICABLE` 不进入成功率与准确率分母。
5. Provider/场景变化时建立分层或新 baseline；Snapshot/Experiment 只比较兼容 cohort。

## 8. Budget, Retention and Deletion

1. Job 提交前以 transaction 预留 Tenant/Workspace/Provider budget；80% 告警，100% 硬停。
2. Worker 上报 usage 并结算 reservation；失败重试仍计入实际 Provider cost。
3. Lifecycle job 按 30/90/180/365 天策略处理 log、screenshot、raw evidence 与 audit digest。
4. 删除请求立即冻结访问、撤销 Connector authorization；active data 30 天内删除、backup 90 天内淘汰。
5. Legal hold 仅保留具名对象版本并对 Tenant 可见；跨租户导出永远拒绝。
