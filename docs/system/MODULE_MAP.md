# Module Map

## Status

以下路径是目标 monorepo map；当前尚未创建生产代码。

| Path | Responsibility | Allowed Dependencies | Forbidden Responsibilities |
|---|---|---|---|
| `apps/web` | Next.js UI、SSR、BFF/session cookie、可访问性与 i18n | `contracts`, `ui`, generated API types | 长任务、直接数据库访问、Connector secret、Provider SDK |
| `apps/api` | REST/OpenAPI、membership/RBAC、tenant context、commands/queries、审批、预算、job submit | `application`, `domain`, `contracts`, `db`, Adapter ports | 长时 crawl/generation/measurement、直接渲染 Provider-specific UI |
| `apps/worker` | SQS consumer、heartbeat、retry、crawl/generation/audit/publish/measurement jobs | `application`, `domain`, `contracts`, `db`, `adapters` | 用户 session、HTTP UI、绕过 approval/budget |
| `packages/domain` | Entity/value object、状态机、不变量、policy interface | 无框架依赖；仅 TypeScript/Zod type boundary | AWS SDK、Nest/Next、SQL、HTTP、Provider SDK |
| `packages/application` | Use case、command/query handler、ports、transaction boundary | `domain`, `contracts` | UI、具体 AWS/Provider 实现 |
| `packages/contracts` | Zod runtime schema、OpenAPI/JSON Schema/job/event/Artifact contract | Zod | 数据库 entity、secret、Provider-specific mutable shape |
| `packages/db` | Kysely database types、SQL migration、RLS policy、repositories、outbox/inbox | `domain` ports, `contracts` IDs | 业务审批决定、外部网络调用 |
| `packages/adapters` | Crawl、AI/search、CMS/channel、S3/SQS/Secrets/Cognito/telemetry Adapter | SDK + `application` ports + `contracts` | 修改 domain state 绕过 application command |
| `packages/ui` | Design tokens、可访问组件、表单与 data-display primitives | React | 业务数据访问、授权决定 |
| `packages/testkit` | Fake clock/ID、tenant fixtures、Provider fixtures、Testcontainers harness | 所有测试所需 public contract | 被 production runtime 引用 |
| `infra` | OpenTofu modules、environment stacks、IAM、backup、alarms | OpenTofu/AWS provider | secret value、生产租户数据 |
| `.github/workflows` | PR verify、build/attest、staging/prod deploy、recovery checks | 固定 SHA Actions | 长期 AWS key、生产数据导出 |

## Domain Modules

| Domain Module | Owns | Key Public Operations |
|---|---|---|
| `identity-access` | User identity link、Membership、RoleBinding、break-glass grant | create tenant/workspace, invite, revoke, authorize |
| `profile-offering` | Company/Brand Profile、Offering、dynamic attributes、locale/market | onboard, revise, validate completeness |
| `site-crawl` | Site ownership、crawl policy、snapshot、technical baseline | verify ownership, enqueue crawl, record baseline |
| `evidence-claims` | EvidenceSource、Claim、ClaimEvidence、expiry、review | register evidence, propose/review/expire claim |
| `prompt-research` | PromptSet、Prompt taxonomy、scenario binding | generate, edit, approve prompt set |
| `content-planning` | Opportunity、ContentPlan、Brief | score, prioritize, bind approved claims |
| `artifacts` | Artifact envelope、revision、lineage、hash、review | create revision, submit/review, resolve lineage |
| `publishing` | Channel Registry、Authorization、PublicationRecord、rollback | check eligibility, preview, publish idempotently |
| `measurement` | MeasurementScenario、PromptRun、MetricSnapshot、Experiment | run baseline, classify result, compare snapshot |
| `jobs-budgets` | Job、heartbeat、retry、BudgetPolicy、UsageLedger | reserve budget, dispatch, retry, hard stop |
| `privacy-audit` | retention、export、delete、AuditEvent/digest、legal hold | export, freeze/delete, append audit, seal digest |

## Dependency Rule

依赖方向固定为 `apps/adapters/db → application → domain`，contract 可被各层读取但只能在 `packages/contracts` 修改。任何反向依赖、跨 package cycle、UI 直接访问数据库或 domain 直接依赖 SDK 都属于架构违规。
