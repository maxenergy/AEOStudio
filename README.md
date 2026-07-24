# AEOStudio

多租户 AEO/GEO/SEO 优化平台 — 将企业事实与证据结构化，研究真实用户问题，生成 evidence-backed 内容，经 exact-revision 人工审批后发布到合规渠道，再以可复现的 Search/AI answer scenario 测量结果并持续实验。

## 产品目标

- **Evidence-first**: 所有对外事实必须追溯到 Approved Claim 与 Evidence Source
- **Approval-first**: 生成 Agent 不能审批自己的产物；Publisher 只能发布 Reviewer 批准的 exact revision/hash
- **Failure transparency**: `ERROR`、`NOT_CHECKED`、`INCONCLUSIVE` 不伪装成零分或成功
- **No guarantee**: 平台不保证搜索收录、排名、AI 引用或推荐

## 架构概览

```
Browser → ALB → apps/web (Next.js SSR/BFF)
                    ↓
              apps/api (NestJS + Fastify)
                    ↓
         ┌──────────┼──────────┐
         ↓          ↓          ↓
    PostgreSQL    S3      Secrets Manager
         ↓
    SQS + DLQ → apps/worker (NestJS Worker)
                    ↓
         External Providers/Channels
```

- **apps/web**: Next.js App Router，UI、SSR、BFF/session boundary
- **apps/api**: NestJS + Fastify，REST/OpenAPI、RBAC、审批、预算、job orchestration
- **apps/worker**: 异步 job — 抓取、生成、发布、measurement、retention
- **packages/**: domain、application、contracts、db、adapters、ui、testkit

## Fake Runtime 与 Production Runtime 的区别

| 维度          | Fake Runtime                   | Production Runtime    |
| ------------- | ------------------------------ | --------------------- |
| 用途          | 本地开发、E2E 测试、CI         | 真实部署              |
| 身份          | Deterministic fake OIDC issuer | Amazon Cognito        |
| 数据库        | In-memory / Testcontainers     | Amazon RDS PostgreSQL |
| 队列          | In-memory fake                 | Amazon SQS            |
| 存储          | In-memory / local              | Amazon S3             |
| Secrets       | 测试固定值                     | AWS Secrets Manager   |
| 外部 Provider | Fixture / manual import        | 官方 API (GSC/Bing)   |
| 启用方式      | `FAKE_AUTH_MODE=true`          | 完整环境变量配置      |

**重要**: Production 构建 (`NODE_ENV=production`) 不会自动启用 fake mode。缺少必要配置时，production runtime 会 fail closed。

## 本地开发

### 前置要求

- Node.js 24.x
- pnpm 11.15.1 (`corepack enable`)
- Docker (用于 Testcontainers 集成测试)

### 快速开始

```bash
# 安装依赖
corepack enable
pnpm install --frozen-lockfile

# 复制环境变量模板
cp .env.example .env

# 启动开发服务器（fake mode）
pnpm dev

# 运行快速验证
pnpm verify:fast

# 运行完整验证（包括集成测试）
pnpm verify
```

### 常用命令

| 命令                    | 说明                                            |
| ----------------------- | ----------------------------------------------- |
| `pnpm dev`              | 启动所有 apps 的开发服务器                      |
| `pnpm build`            | 构建所有 workspace                              |
| `pnpm verify:fast`      | format + lint + typecheck + unit + contracts    |
| `pnpm verify`           | verify:fast + integration + ops + build + smoke |
| `pnpm test:unit`        | 运行单元测试                                    |
| `pnpm test:integration` | 运行集成测试（需要 Docker）                     |
| `pnpm test:e2e`         | 运行 Playwright E2E 测试                        |
| `pnpm test:ops`         | 运行运维/静态测试                               |
| `pnpm security:verify`  | 运行安全检查                                    |
| `pnpm format`           | 格式化代码                                      |
| `pnpm lint`             | 运行 ESLint                                     |

## 测试

- **Unit**: Vitest，快速隔离测试
- **Integration**: Testcontainers + PostgreSQL，真实数据库行为
- **E2E**: Playwright，真实浏览器流程
- **Ops**: 静态分析、IaC 契约、供应链检查

## 部署

- **IaC**: OpenTofu，`infra/` 目录
- **CI/CD**: GitHub Actions，`.github/workflows/`
- **目标**: AWS Singapore (`ap-southeast-1`)，ECS Fargate

## 当前状态

- Tasks 1–17: 本地验证完成
- Task 18 (AWS staging): 本地/静态测试通过，九项外部门槛 `NOT_CHECKED`
- 详见 `docs/goal/VERIFY.md` 和 `docs/operations/task-18-evidence-status.md`

## 不保证声明

本平台不提供任何保证，包括但不限于：

- 搜索引擎收录或排名
- AI 系统的 mention、citation 或 recommendation
- 流量、转化或收入提升

所有测量结果均披露样本、时间、Provider/Surface、错误与不确定性。

## 许可

私有项目，保留所有权利。
