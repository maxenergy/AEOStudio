# Task 18 staging load profile

只允许对批准的 AWS Singapore synthetic-data staging 执行：

```bash
k6 run tests/load/task-18-capacity.js
node scripts/load/finalize-task-18-load-evidence.mjs
```

## 必需运行身份

运行前必须同时提供以下环境变量；脚本会要求 base URL 与批准 origin/host 完全一致，并把账号、镜像和 build identity 写入证据：

- `AEO_LOAD_BASE_URL`
- `AEO_LOAD_APPROVED_ORIGIN`
- `AEO_LOAD_APPROVED_HOST`
- `AEO_LOAD_AWS_ACCOUNT_ID`
- `AEO_LOAD_ADOT_IMAGE_DIGEST`
- `AEO_LOAD_API_IMAGE_DIGEST`
- `AEO_LOAD_TENANT_DATA_BROKER_IMAGE_DIGEST`
- `AEO_LOAD_WEB_IMAGE_DIGEST`
- `AEO_LOAD_WORKER_IMAGE_DIGEST`
- `AEO_LOAD_BUILD_RUN_ID`
- `AEO_LOAD_BUILD_RUN_ATTEMPT`
- `AEO_LOAD_RUN_ID`
- `AEO_LOAD_TENANTS_JSON`

Base URL 与批准 origin 只接受小写 FQDN 的 HTTPS 根 origin；可输入尾随根 `/`，但会规范为无尾随 `/`，端口、userinfo、路径、query、fragment 与单标签 hostname 均会失败。五项 runtime image digest 必须是完整 `sha256:` digest，其中 Tenant Data Broker 必须与 Worker digest 完全相同；AWS account 必须是 12 位数字，build run 与 attempt 必须是正整数。`AEO_LOAD_RUN_ID` 必须是本次受保护 workflow 生成的唯一 UUID，并以 `0050` capacity marker 结尾；不得手工复用其他运行的 ID。

## Synthetic session 输入

`AEO_LOAD_TENANTS_JSON` 必须包含 10 个 Tenant，每个 Tenant 10 个 session，共 100 个全局唯一 identity 与 cookie：

```json
[
  {
    "tenantId": "synthetic-tenant-01",
    "workspaceId": "synthetic-workspace-01",
    "profileId": "synthetic-profile-01",
    "budgetProbeEstimatedUnits": 100000,
    "sessions": [
      {
        "identityId": "synthetic-tenant-01-session-01",
        "sessionCookie": "<opaque-cookie>"
      }
    ]
  }
]
```

实际输入中每个 `sessions` 数组必须有 10 项。`identityId` 和 `sessionCookie` 在全部 100 项中都不可重复。Cookie 是秘密：不得提交到仓库，也不得上传为 workflow artifact。

## Capacity 语义

- session profile 是 100 个独立并发 session。
- Job profile 提交 50 个 Job，固定映射为每 Tenant 5 个；并发容量结论只由后续同一轮 polling 中 50 个 Job **同时处于 `RUNNING`** 的精确响应证明，不能由 submission 并发数替代。
- 50 个 accepted response 必须包含 50 个 distinct Job ID。
- workflow 为每次运行生成唯一 UUID，并保留 `0050` capacity marker；只有 staging Worker 会对该标记启用 10 秒受控 hold，普通 Job 和 production 均不启用。
- 门禁在同一轮完整 polling snapshot 中统计状态：该轮每次查询都必须为 HTTP 200，且响应中的 Job/Tenant/Workspace 必须与 accepted scope 精确一致；要求 50 个唯一 Job 同时为 `RUNNING`、10 个 Tenant 各 5 个，且 `max_active_tenant <= 5`。terminal 不计入 active；累计“曾启动”指标仅用于证明 accepted Job 没有丢失，不能替代并发证明。
- 10 个 budget probes 必须全部返回 HTTP 202 且状态为 `BUDGET_BLOCKED`；任意 401、500、非 JSON 或其他状态都会通过专属 threshold 使运行失败。

## Evidence

k6 只写非权威 raw summary，默认路径为 `output/task-18-load-raw-summary.json`，可通过 `AEO_LOAD_RAW_SUMMARY_PATH` 修改。

只有 k6 全部 threshold 通过后，才运行 finalizer。它会再次核对批准 origin/host、AWS account、五项 runtime image digest（ADOT、API、Web、Worker、Tenant Data Broker）和 build run/attempt，然后以 private `0600`、**write-once** 方式写入 `output/task-18-load-evidence.json`。可通过 `AEO_LOAD_EVIDENCE_PATH` 指定新路径；目标已存在时 finalizer 必须失败，绝不会覆盖旧证据。
