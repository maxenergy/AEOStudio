# Assumptions

以下是假设，不等于用户已确认；如后续答案冲突，以用户答案为准。

## A-001 — Approval-First Publishing

- Default: 所有事实、公开竞品比较、网站代码变更和外部发布必须经过具名人工审批。
- Why non-blocking: 它直接继承 Playbook 的安全边界，并可在不改变核心数据模型的前提下按渠道细化。

## A-002 — Tenant Isolation

- Default: Company Profile、Product、Claim、Prompt Run、Publication credential、原始证据和指标按 tenant/workspace 隔离；跨租户只共享无客户数据的 Schema、Method Registry 和 Skill 模板。
- Why non-blocking: 这是多租户 SaaS 的安全下限，不依赖具体技术栈。

## A-003 — No Ranking Guarantee

- Default: 产品报告测得的 AI Visibility 和 SEO/AEO/GEO 变化，披露 provider、surface、model、locale、region、时间、样本、失败和不确定性；不承诺固定排名、收录、引用或推荐。
- Why non-blocking: 第三方搜索和 AI 答案不可控，承诺固定结果会造成产品与合规风险。

## A-004 — Failure Semantics

- Default: `NOT_APPLICABLE`、`NOT_CHECKED`、`ERROR` 与 `INCONCLUSIVE` 不换算成零分或成功；原始证据与派生判断分开保存。
- Why non-blocking: 这是可信测量所需的数据语义，可独立于 UI 和 Provider 实现。

## A-005 — Initial Product Language

- Default: 管理后台先支持简体中文，数据模型从第一天保留 `locale` 和 `market`，内容资产允许多语言。
- Why non-blocking: 可先交付中文体验，同时避免未来多语言迁移破坏契约。

## A-006 — Billing Integration

- Default: MVP 实现 Plan、quota、usage、budget reservation、80% 告警和 100% 硬停，但不接真实 payment processor；套餐与额度由平台管理员配置。
- Why non-blocking: 成本控制和多租户边界可先被完整验证，支付渠道不改变核心 domain contract。

## A-007 — Initial Crawl Limit

- Default: 首轮 onboarding crawl 仅限一个已验证 Site，最多 500 个 canonical pages 或 2 GiB 原始响应，以先到者为准；Owner 可配置更低上限。
- Why non-blocking: 防止首轮抓取无界消耗，同时不改变 Site/CrawlJob/Artifact 模型。

## A-008 — External Provider Availability

- Default: 实现和 CI 使用 versioned fixtures、recorded contract response 或 Provider 官方 sandbox；没有合法 API、授权或条款依据的 Surface/Channel 返回 `NOT_CHECKED` 或 `EXPORT_ONLY`。
- Why non-blocking: 外部平台可用性会变化，Adapter contract 和失败语义不依赖某个真实账号始终可用。

## A-009 — Accessibility Baseline

- Default: 登录后主路径以 WCAG 2.2 AA 为目标，支持键盘操作、可见焦点、语义化错误、表单标签与不只依赖颜色的状态表达。
- Why non-blocking: 这是企业 SaaS 的可用性基线，可通过组件与 E2E/a11y checks 实现，不改变业务范围。
