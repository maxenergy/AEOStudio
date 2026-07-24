# Goal Contract: Multi-Tenant AEO/GEO/SEO Optimization Platform

## Objective

按严格 TDD 依次完成 18 个 vertical slices，交付一个部署在 AWS Singapore、行业中立、Tenant-isolated、evidence-first、approval-first、可发布且可复现测量的 AEO/GEO/SEO MVP。

## How To Trigger Implementation

两种触发方式任选其一：

- Codex：把 [`CODEX_START.md`](./CODEX_START.md) 内容贴进 Codex。
- Claude Code/其他支持 `@` 的 agent：把 [`CLAUDE_CODE_START.md`](./CLAUDE_CODE_START.md) 内容贴进对话。

## Source Of Truth

下游 agent 按以下顺序读取。后面的文件细化但不能削弱前面的 hard constraints。

### Umbrella

1. [`docs/goal/REQUIREMENTS.md`](./REQUIREMENTS.md) — 产品需求、角色、FR/NFR、边界与 release gate。
2. [`docs/goal/DESIGN.md`](./DESIGN.md) — 技术栈、架构、contracts、data/security/performance 设计。
3. [`docs/goal/TASKS.md`](./TASKS.md) — 18 个 ordered vertical slices 与每任务 13 项 TDD contract。

### Supporting Documents

4. [`docs/goal/PRD.md`](./PRD.md)
5. [`docs/goal/NON_GOALS.md`](./NON_GOALS.md)
6. [`docs/goal/ACCEPTANCE.md`](./ACCEPTANCE.md)
7. [`docs/goal/IMPACT.md`](./IMPACT.md)
8. [`docs/goal/PLAN.md`](./PLAN.md)
9. [`docs/goal/DECISIONS.md`](./DECISIONS.md)
10. [`docs/goal/ASSUMPTIONS.md`](./ASSUMPTIONS.md)
11. [`docs/goal/VERIFY.md`](./VERIFY.md)
12. [`docs/goal/UNKNOWN.md`](./UNKNOWN.md) — Blocking 必须保持 `None`。
13. [`../system/ARCHITECTURE.md`](../system/ARCHITECTURE.md)、[`MODULE_MAP.md`](../system/MODULE_MAP.md)、[`DATA_FLOW.md`](../system/DATA_FLOW.md)、[`RISK_AREAS.md`](../system/RISK_AREAS.md)

## Execution Rules

- 严格按 `TASKS.md` Task 1 → 18 顺序执行；一个 task 未绿不得开始下一个。
- 每个 task 先写 public-interface RED test，并确认 failure 与 `Expected Failure` 相符；环境/编译错误不是合格 RED。
- GREEN 只实现当前 task 的 `GREEN Boundary`；通过后才可在 `Refactor Allowance` 内清理。
- 每个 task 完成后，把 RED/GREEN/refactor 命令和证据追加到 `VERIFY.md`。
- 不重新解释需求，不静默换技术栈，不扩大 scope；`NON_GOALS.md` 与每个 `Do Not Touch` 是 hard constraints。
- 遇到 contract 冲突、blocking unknown、真实 Provider/Channel 授权缺失或需要 production apply 时立即停止，报告文件/锚点和一个最小问题。
- 工作区可能有用户文件；不得 destructive reset/checkout/clean，不修改原始 DOCX。

## TDD Rules

1. RED：写当前 task 指定测试并跑出指定失败。
2. GREEN：最小实现让 targeted verification 全绿。
3. REFACTOR：只在绿后清理，并重新验证。
4. EVIDENCE：追加 `VERIFY.md`，不以口头声称替代命令/trace/API/remote sandbox evidence。
5. ACCEPTANCE：当前 task criteria 全部可观察后再继续。

## Definition Of Done

- `TASKS.md` Task 1–18 全部完成且有 RED/GREEN evidence。
- `ACCEPTANCE.md` user-visible、technical、regression 与 manual checklist 全部通过。
- `pnpm verify`、`pnpm test:e2e`、`pnpm security:verify` 全绿。
- OpenTofu fmt/validate/plan、Singapore residency/IAM review 通过。
- Synthetic brand 走通完整闭环，双 Tenant isolation 与 publish replay tests 通过。
- Staging load/SLO、alerts、restore drill、SBOM/provenance 有真实证据。
- `git diff` 只包含预期文件，残余风险明确记录。
