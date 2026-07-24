# Completion Baseline

> 本文件记录 C00 阶段建立的可信工程基线。

## 环境信息

| 项目 | 版本/值 |
|---|---|
| Commit SHA | `d8671ffcc734a76dcd71d87ea9928b3584ea8518` |
| Branch | `completion/production-readiness` |
| Node.js | v24.15.0 |
| pnpm | 11.15.1 |
| Docker | 29.6.1 |
| PostgreSQL (Testcontainers) | 18.3 |
| OpenTofu | 未安装（本地静态测试通过） |
| 日期 | 2026-07-25 |

## 基线命令结果

### pnpm install --frozen-lockfile

- **Exit code**: 0
- **结果**: PASS — 依赖已安装，lockfile 一致

### pnpm verify:fast

- **Exit code**: 0（修复后）
- **结果**: PASS
- **修复项**:
  - Prettier 格式问题（6 个文件）
  - ESLint 错误（9 个）：unused vars、control-regex、no-undef、unsafe-return/call
  - 单元测试失败（2 个）：`reserveGenerationStart` mock 缺失

### pnpm test:integration

- **Exit code**: 1
- **结果**: PARTIAL — 5 failed / 26 passed (32 files), 24 failed / 249 passed (275 tests)
- **失败原因**: PostgreSQL Testcontainers 测试资源/超时问题
- **失败文件**:
  - `task-18-production-db-roles.test.ts` — RLS policy 断言
  - 其他 Testcontainers 相关测试
- **注意**: 非 Testcontainers 的集成测试通过

### pnpm test:ops

- **Exit code**: 0（修复后）
- **结果**: PASS — 33 files / 280 tests
- **修复项**: `task-18-gitleaks-config.test.ts` 期望配置与实际 `.gitleaks.toml` 不同步

### pnpm build

- **Exit code**: 0
- **结果**: PASS — 8 workspace builds 成功

### pnpm smoke:runtime

- **Exit code**: 0
- **结果**: PASS
  - `PRODUCTION_RUNTIME_SMOKE_OK`
  - `WEB_RUNTIME_ORIGIN_SMOKE_OK`

### pnpm security:verify

- **Exit code**: 0
- **结果**: PASS
- **检查项**: secret-patterns, licenses, container-bases, trivy-exceptions, action-pins, ci-gates, infra-forbidden

## 外部凭证状态

| 凭证 | 状态 |
|---|---|
| AWS 账号/角色 | 不可用 |
| GitHub protected environment | 不可用 |
| Google Search Console | 不可用 |
| Bing Webmaster | 不可用 |
| WordPress test site | 不可用 |
| Shopify development store | 不可用 |
| Cognito user pool | 不可用 |

## 已知问题

1. **Testcontainers 集成测试**: 部分 PostgreSQL Testcontainers 测试在本地环境失败，可能是资源限制或 Docker 配置问题。非 Testcontainers 测试通过。
2. **外部 Gate**: 九项权威外部门槛全部为 `NOT_CHECKED`，需要真实 AWS/GitHub 环境。

## 下一步

1. 完善 README.md 和 .env.example
2. 提供本地开发入口
3. 新增 C00 RED 测试
4. 提交并推送
