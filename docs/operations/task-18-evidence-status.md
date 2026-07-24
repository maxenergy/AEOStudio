# Task 18 external evidence status

| Gate | Current state | Required authoritative evidence |
|---|---|---|
| Backend-bound OpenTofu plan | NOT_CHECKED | Protected `staging-plan` workflow artifact produced with the reviewed Singapore backend and variable inputs |
| Singapore staging deploy | NOT_CHECKED | GitHub deployment URL, ECS task-definition ARNs and one immutable image digest |
| Synthetic smoke | NOT_CHECKED | `aeostudio-staging-smoke.v1` JSON from the public staging URL |
| Load/SLO | NOT_CHECKED | k6 summary for 100 sessions, 50 jobs and 5 jobs per Tenant |
| RDS/S3 restore drill | NOT_CHECKED | `aeostudio-restore-drill.v1` JSON with measured RPO at most 15 minutes and RTO at most 4 hours |
| CloudWatch/X-Ray fault alarms | NOT_CHECKED | Full `aeostudio.synthetic-fault-evidence.v2` coverage for the frozen 25-alarm matrix; every row requires a reviewed `REAL_FAULT` injector and alarm-configuration SHA-256, raw threshold-breaching CloudWatch metric data, original `HistoryData` for exact `OK` to `ALARM` to `OK` transitions, a complete causal-window CloudTrail result with zero `SetAlarmState` events, and the matching X-Ray trace |
| Remote supply-chain attestations | NOT_CHECKED | Successful GitHub build/security jobs plus exact-digest CycloneDX and provenance attestations from the main-branch workflow |
| GitHub environment protections | NOT_CHECKED | Repository settings showing named reviewers, main-only deployment branches and no self-review for protected environments |
| Production promotion | NOT_CHECKED | Protected-environment approval and promotion of the exact staging image digest |

No fault injector is currently reviewed for any of the 25 alarm rows, so every row
must remain `NO_REVIEWED_REAL_FAULT_INJECTOR` and the external gate remains
`NOT_CHECKED`. These states must not be changed to PASS from static configuration,
local mocks, `SetAlarmState`, a successful backup job, or an OpenTofu plan. They
require an approved, named AWS environment and live evidence.
