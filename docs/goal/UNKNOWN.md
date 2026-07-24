# Unknown

## Blocking

- None.

## Resolved History

- [x] Q-001: 首个 MVP 的 user-visible end-to-end outcome 与发布边界。
- [x] Q-002A: 行业中立的 capability-based customer boundary，以及产品/服务/解决方案的统一抽象。
- [x] Q-003: tenant / company / brand / workspace / site / user 的层级和 RBAC。
- [x] Q-004A: 第三方渠道发布按钮的 Adapter、授权、条款与 fallback eligibility。
- [x] Q-005: 首批 measurement provider、surface、locale、region 和合法采集方式。
- [x] Q-006: p95、并发、SLA、RTO/RPO 与每租户预算硬上限。
- [x] Q-007A: 数据保留、删除、PII、审计和法律声明边界。
- [x] Q-007B: 主部署区域、Tenant data residency 与跨境 Provider policy。
- [x] Q-008A: language、runtime 与 main frameworks。
- [x] Q-008B: package manager、test、lint、format 与 contract generation。
- [x] Q-008C: database、object storage、search、queue、Secret Vault 与 deployment platform。
- [x] Q-008D: identity、observability、CI/CD、dependency 与 license policy。

## Non-Blocking

- 当前无；默认项记录在 `ASSUMPTIONS.md`。

## Freeze Gate

`BLOCKING` 已清零，可以冻结 `REQUIREMENTS.md`、`DESIGN.md` 与 `TASKS.md`。在 goal pack 交付前仍不写生产代码。
