# Non-Goals

本文件与 `REQUIREMENTS.md` 同等强。任何实现若违反以下排除项，即使测试通过也视为失败。

## Explicitly Excluded Features

- 不保证或宣称固定搜索排名、收录、AI mention、citation、recommendation、流量、转化或收入提升。
- 不把 AIoT、智能安防、工业设备、企业软硬件或任何示例行业写成 closed enum、固定导航、强制字段、专用 Prompt 或专用工作流。
- MVP 不做全自动 Claim approval、全自动 Artifact approval 或无需 Publisher 的 autonomous publish。
- MVP 不接 Stripe/支付渠道；只实现 Plan/quota/usage/budget 控制。
- MVP 不做中国大陆本地数据驻留、ICP备案、境内 Provider cell；也不做 EU/US multi-region active-active。
- MVP 不做 SCIM、enterprise JIT provisioning、复杂 ABAC policy language 或自定义角色编辑器。
- MVP 不做 OpenSearch/Elasticsearch dual-write、Kafka、Kubernetes/EKS、service mesh 或独立网络微服务。
- MVP 不训练共享模型，不用 Tenant data 做平台或 Provider 模型训练。
- MVP 不做跨 Tenant 内容、Claim、Prompt result、credential、raw evidence 或 embedding 共享；只共享无租户数据的 Schema/Method/Skill。
- MVP 不做无限 crawl、全网未授权抓取或绕过 robots/terms 的采集。

## Prohibited Publishing and Collection Methods

- 浏览器密码模拟、Cookie 窃取、验证码绕过、设备指纹规避。
- 抓包/逆向调用私有 API，或规避第三方 rate limit、anti-bot、access control。
- 在 Adapter disabled、OAuth/API scope 不足、terms 未批准、credential 失效或 revision 未批准时执行真实外部写入。
- 以 UI 动画、optimistic response 或本地状态伪报远端发布成功。
- 把普通 LLM API 输出冒充 ChatGPT Search、Google AI Mode/AI Overviews、Perplexity consumer surface 结果。

## Implementation Styles To Avoid

- Next.js-only monolith；长任务不得在 Web request 生命周期执行。
- Python-first Control Plane、Java microservices 或首期双语言核心。
- 手写 DTO/interface 与独立 JSON Schema/OpenAPI 双份契约。
- Runtime 使用 migration/admin DB role，或只依赖 application filter 而无 RLS。
- Secret、OAuth token、API key、refresh token plaintext 写数据库、日志、Prompt、Artifact、SQS message、OpenTofu state 或 GitHub secret。
- 使用 Redis/BullMQ 作为唯一 durable queue；SQS redelivery 不能被假设为 exactly-once。
- 通过 snapshot-only test、mock database 或全局覆盖率百分比替代关键不变量测试。
- 默认 CI 调用真实付费 Provider 或读取生产 Tenant 数据。
- 未锁 commit SHA 的第三方 GitHub Action、未锁 digest 的 production base image。
- 永久 vulnerability/license/residency allowlist；所有例外必须有 expiry。

## Do Not Touch

- 不修改或覆盖 `GEO_Agent_Implementation_Playbook_v1.0.docx`；它是只读原始依据。
- 不删除 `docs/goal/QUESTIONS.md`、`ANSWERS.md`、`ASSUMPTIONS.md`、`UNKNOWN.md` 的决策轨迹。
- 不降低 Reviewer/Publisher separation、Agent 不能自批、approval 绑定 exact revision/hash 的规则。
- 不把 `NOT_APPLICABLE`、`NOT_CHECKED`、`ERROR`、`INCONCLUSIVE` 自动换算成 0、false 或 success。
- 不移除 Provider/Surface/model/locale/region/time/cost/raw evidence 的 measurement reproducibility 字段。
- 不允许平台运维默认查看租户正文或 secret；break-glass 必须具名、限时、可撤销、全审计。
- 不自动开启 cross-region replication 或未批准的 cross-border Provider processing。

## Scope-Creep Traps

- 为了“全网推广”一次性实现大量渠道；首期应先完成可扩展 Channel Registry、通用 Channel Package、资格判断和已确认 owned-site adapters。
- 为了“AI 可见度分数”合并不同 Surface、API 与 consumer UI；必须分层展示。
- 为了“更智能”让 Agent 自由读取全部 Workspace、secret 或未经批准 Claim。
- 为了“更快搜索”提前增加 OpenSearch，并引入尚未被 benchmark 证明必要的双写。
- 为了“合规”在没有法律审查时宣传取得某项认证。
- 为了“恢复能力”创建跨区域副本，违反 Singapore residency；MVP 只做区域内 Multi-AZ、backup 与 restore drill。
