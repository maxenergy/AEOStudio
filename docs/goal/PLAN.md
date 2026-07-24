# Implementation Plan: Multi-Tenant AEO/GEO/SEO Optimization Platform

## Goal

以严格 TDD vertical slices 从空仓库交付一个可部署、可审计的多租户 MVP，使 synthetic brand 完整走通 Profile → Prompt → Claim → Plan → Audit → Publish → Run → Snapshot → Experiment。

## Strategy

- 先建立 secure session、Tenant/Workspace/RLS 和行业中立 onboarding，形成最小可登录业务壳。
- 每个后续 slice 同时包含 contract、migration、domain policy、API、Worker（如需）、UI、测试与审计，不先横向铺 model/API/UI。
- 外部边界先使用 versioned fake/recorded fixtures 验证 contract/error semantics，再实现 Provider/Channel Adapter；默认 CI 不调用付费服务。
- 发布先完成 generic package/eligibility/idempotency，再逐个增加 Git、WordPress/WooCommerce、Shopify/signed-webhook Adapter。
- Measurement 先证明 scenario、raw evidence 与 denominator 正确，再做 experiment/delta；不先追求一个综合分数。
- 最后以 Tenant export/delete、AWS staging、observability、recovery 和 supply-chain promotion gate 封闭运营风险。
- 每个 task 按 RED → Expected Failure → GREEN → verify → refactor → evidence 顺序，当前 task 未绿不得继续。

## Verification Strategy

- Fast local gate：`pnpm verify:fast`（format check、lint、typecheck、unit、contract drift）。
- Full repository gate：`pnpm verify`（fast gate + integration + build）。
- Browser gate：`pnpm test:e2e`。
- Infrastructure gate：`tofu fmt -check -recursive && tofu -chdir=infra/environments/staging validate`。
- Security/supply-chain gate：`pnpm security:verify`（secret、OSV、license、SBOM/provenance policy tests）。
- Manual gate：执行 [`ACCEPTANCE.md`](./ACCEPTANCE.md) 的 checklist，并把证据追加到 [`VERIFY.md`](./VERIFY.md)。
- 每个 task 的 targeted Verification Command 见 [`TASKS.md`](./TASKS.md)。

## Task Order

1. Secure sign-in and application shell。
2. Tenant/Workspace isolation、membership 与 RBAC。
3. Industry-neutral Profile/Offering onboarding。
4. Durable jobs、progress 与 budget hard stop。
5. Site ownership verification 与 safe crawl baseline。
6. Evidence Source 与 Claim Ledger approval。
7. Prompt Set 与 Measurement Scenario approval。
8. Evidence-ready Content Plan 与 three asset briefs。
9. Artifact generation、lineage 与 exact-revision review。
10. Generic Channel Package、eligibility 与 idempotent publication core。
11. Git Pull Request publishing Adapter。
12. WordPress/WooCommerce Draft Adapter。
13. Shopify Draft Adapter。
14. Signed webhook Adapter。
15. Multi-Surface measurement baseline 与 evidence dashboard。
16. Remeasurement、Snapshot 与 Experiment comparison。
17. Audit、retention、Tenant export 与 deletion lifecycle。
18. AWS staging、observability、recovery 与 supply-chain promotion。

## Risks

- Tenant leakage：所有 Tenant-owned slice 默认使用双 Tenant fixtures + RLS integration test。
- External duplicate effect：先写 replay/ambiguous-response RED tests，再实现 idempotency/reconciliation。
- Measurement invalidity：用 property tests 固定 excluded status denominator 和 scenario compatibility。
- SSRF/prompt injection：crawler 使用恶意 URL/redirect/DNS fixture 与 untrusted-content boundary tests。
- Migration drift：每 slice 同时跑 from-empty 和 previous-version upgrade。
- Scope overload：每个 task 只实现其 user-visible behavior；未被该 task 验收需要的 adapter/optimization 延后。

## Rollback

- Task 内：回滚该 slice 的 route/handler/migration（仅未进入 shared environment 时），保留测试说明预期行为。
- Staging/production：回滚到上一 image digest，queue 暂停并保留，数据库优先 forward-fix；破坏性 down migration 禁止默认执行。
- External publish：停止 Adapter capability，reconcile 已有 intent，按 PublicationRecord/rollback handle 处理，历史不删除。
- Measurement：禁用受影响 Adapter/version，旧 raw evidence/snapshot 保持 immutable，必要时新建 baseline。
