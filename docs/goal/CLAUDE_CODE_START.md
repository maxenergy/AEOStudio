请按 TDD 模式实现 @docs/goal/REQUIREMENTS.md @docs/goal/DESIGN.md @docs/goal/TASKS.md 中描述的全部 18 个 vertical slices。

## 强制约束

1. 三个 umbrella 文档是 source of truth；按其链接读取 PRD、NON_GOALS、ACCEPTANCE、IMPACT、PLAN、VERIFY、DECISIONS 和 system docs。
2. 严格按 `TASKS.md` Task 1 → 18 顺序。当前任务未绿，不得开始下一任务。
3. 每个生产代码任务必须完整执行：
   - RED：先写任务指定的 public-interface test。
   - Expected Failure：跑 Verification Command，确认是任务指定失败，而非环境/编译错误。
   - GREEN：只在 GREEN Boundary 内实现到测试通过。
   - Verify：重新运行命令并确认全绿。
   - Refactor：仅在绿后按 Refactor Allowance 清理，再次验证。
   - Evidence：把命令、关键输出、验收证据和残余风险追加到 `docs/goal/VERIFY.md`。
4. `docs/goal/NON_GOALS.md` 和每个任务的 Do Not Touch 都是 hard constraints；不得修改 `GEO_Agent_Implementation_Playbook_v1.0.docx`。
5. 严格遵守 `DESIGN.md` Tech Stack/version/license/residency 约束，不静默引入替代方案。
6. 遇到需求冲突、BLOCKING unknown、真实 Provider/Channel 授权缺失或 production AWS apply 时立即停止，报告文件/锚点、已运行命令，并只提出一个可解决阻塞的最小问题。
7. 完工必须满足 `GOAL.md` Definition Of Done 和 `ACCEPTANCE.md` 全部 release gates。
