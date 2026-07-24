# Staging synthetic fault evidence

`run-synthetic-alarm-drill.mjs` is a fail-closed readiness collector for the frozen
25-alarm matrix. It verifies the exact staging account and alarm inventory, then writes
`aeostudio.synthetic-fault-evidence.v2` with every fault that lacks complete causal
evidence marked `NOT_CHECKED`.

It does not call `cloudwatch:SetAlarmState`. An alarm-state override proves only that
CloudWatch can record a manual state update; it is never accepted as evidence that an
ALB, queue, database, Provider, publication, backup, or restore fault occurred.

Run the collector only from the protected staging-acceptance workflow:

```text
AEO_ENVIRONMENT=staging
AWS_REGION=ap-southeast-1
AEO_EXPECTED_ACCOUNT_ID=<12-digit account>
AEO_SYNTHETIC_FAULT_APPROVED=true
AEO_SYNTHETIC_DRILL_ID=<unique incident-safe id>
AEO_SYNTHETIC_ALARM_EVIDENCE_PATH=output/<unique>.json
pnpm alarms:staging
```

The output is opened with `wx` and mode `0600`, so an existing file is never
overwritten. The workflow requires `outcome == PASSED`; the current matrix deliberately
returns `NOT_CHECKED`, so neither the staging acceptance finalizer nor production
promotion can continue.

## Frozen v2 causal contract

Every matrix row must remain in exact alarm-name/type order. A future `PASSED` row is
accepted only after its `approvedInjector` is reviewed and the evidence contains:

- a `drillId` exactly bound to the current acceptance workflow run ID and attempt, so
  an older v2 artifact cannot be replayed into a new envelope;
- `injection.kind == REAL_FAULT`, the exact injector name, `injectedAt`, and a UUID
  `correlationId`;
- the exact operational signal with the same correlation ID and trace ID;
- the reviewed alarm's exact metric/configuration plus its frozen SHA-256, and raw
  unpaginated CloudWatch `GetMetricData` output containing enough
  threshold-breaching datapoints, no `NextToken`, and no operation/result messages;
  each datapoint period must overlap the injection-to-alarm causal window, using the
  reviewed positive CloudWatch alarm period rather than treating the period start as
  the event time;
- authoritative CloudWatch `StateUpdate` history from `OK` to `ALARM` and back to `OK`
  for the exact alarm, including the original `HistoryData` for both transitions;
- a complete raw CloudTrail `LookupEvents` result covering the full evidence start
  through alarm recovery, with zero `monitoring.amazonaws.com:SetAlarmState` events;
- the same trace ID and correlation ID returned by X-Ray.

No injector or alarm-configuration hash is currently approved for any of the 25 rows.
Therefore every row remains `NO_REVIEWED_REAL_FAULT_INJECTOR`, and any attempted
`PASSED` row fails with `SYNTHETIC_FAULT_INJECTOR_NOT_APPROVED`. The future schema
above is frozen for collector review, but does not itself approve a collector or
injector. These states are diagnostic evidence only; they cannot become a staging
acceptance `PASS`.

Do not change `docs/operations/task-18-evidence-status.md` from `NOT_CHECKED` until an
approved AWS run produces full v2 causal coverage for all 25 rows and the immutable
acceptance/promotion validators accept the exact artifact.
