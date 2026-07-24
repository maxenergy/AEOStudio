import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();

function source(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

describe('Task 18 observability hardening', () => {
  test('defines every frozen alarm family and derives application signals from redacted logs', async () => {
    const observability = await source('infra/modules/platform/observability.tf');

    for (const resource of [
      'alb_target_5xx',
      'slo_fast_burn',
      'budget_warning',
      'budget_blocked',
      'authentication_denied',
      'job_heartbeat_failed',
      'provider_failed',
      'publication_failed',
      'restore_failures',
    ]) {
      expect(observability).toContain(`aws_cloudwatch_metric_alarm" "${resource}`);
    }

    for (const event of [
      'BUDGET_WARNING',
      'BUDGET_BLOCKED',
      'AUTHENTICATION_DENIED',
      'JOB_HEARTBEAT_FAILED',
      'PROVIDER_FAILED',
      'PUBLICATION_FAILED',
    ]) {
      expect(observability).toContain(`$.event = ${'\\'}"${event}${'\\'}"`);
    }
    expect(observability).toContain('resource "aws_cloudwatch_log_metric_filter"');
    expect(observability).toContain('HTTPCode_Target_5XX_Count');
    expect(observability).toContain('RequestCount');
    expect(observability).toMatch(/expression\s*=\s*"[^"]*errors[^"]*requests/iu);
  });

  test('emits only low-cardinality operational events at the real API and Worker decisions', async () => {
    const jobs = await source('apps/api/src/jobs/jobs.controller.ts');
    const requests = await source('apps/api/src/observability/request-correlation.ts');
    const worker = await source('apps/worker/src/measurement-worker-runtime.ts');

    expect(jobs).toContain("warn('BUDGET_WARNING'");
    expect(jobs).toContain("warn('BUDGET_BLOCKED'");
    expect(requests).toContain("warn('AUTHENTICATION_DENIED'");
    expect(worker).toContain("warn('JOB_HEARTBEAT_FAILED'");
    expect(worker).toContain("warn('PROVIDER_FAILED'");
    expect(worker).toContain("warn('PUBLICATION_FAILED'");

    for (const contents of [jobs, requests, worker]) {
      expect(contents).not.toMatch(/metric.*(?:userId|prompt|url)|dimension.*tenant/iu);
    }
  });

  test('provides a staging-only fail-closed causal fault matrix with immutable evidence', async () => {
    const runner = await source('scripts/observability/run-synthetic-alarm-drill.mjs');
    const drill =
      `${runner}\n${await source('scripts/observability/synthetic-alarm-contract.mjs')}\n` +
      (await source('scripts/acceptance/finalize-staging-acceptance-evidence.mjs'));

    expect(drill).toContain("environment !== 'staging'");
    expect(drill).toContain('AEO_SYNTHETIC_FAULT_APPROVED');
    expect(drill).toContain("['sts', 'get-caller-identity']");
    expect(drill).toContain("'cloudwatch',\n  'describe-alarms'");
    expect(runner).not.toContain('set-alarm-state');
    expect(drill).toContain('aeostudio.synthetic-fault-evidence.v2');
    expect(drill).toContain('aeostudio.synthetic-fault-matrix.v1');
    expect(drill).toContain('REAL_FAULT_CAUSAL_TRACE');
    expect(drill).toContain("outcome: 'NOT_CHECKED'");
    expect(drill).toContain('injectedAt');
    expect(drill).toContain('correlationId');
    expect(drill).toContain('alarmHistory');
    expect(drill).toContain('xrayTraceId');
    expect(drill).toContain("flag: 'wx'");
    for (const family of [
      'slo-fast-burn',
      'alb-target-latency',
      'alb-target-5xx',
      'queue-age',
      'dlq-visible',
      'budget-warning',
      'budget-blocked',
      'database-connections',
      'backup-jobs-failed',
    ]) {
      expect(drill).toContain(family);
    }
  });
});

describe('Task 18 capacity hard-stop evidence', () => {
  test('requires all ten budget probes to return 202 with BUDGET_BLOCKED on dedicated hard gates', async () => {
    const load = await source('tests/load/task-18-capacity.js');
    const budgetProbe = load.split('export function verifyBudgetHardStop')[1] ?? '';

    expect(load).toContain("exec: 'verifyBudgetHardStop'");
    expect(load).toContain('budgetProbeEstimatedUnits');
    expect(load).toContain("new Counter('aeo_budget_probe_attempts')");
    expect(load).toContain("new Counter('aeo_budget_probe_blocked')");
    expect(load).toContain("new Counter('aeo_budget_probe_failures')");
    expect(load).toContain("new Rate('aeo_budget_probe_success')");
    expect(load).toContain("aeo_budget_probe_attempts: ['count==10']");
    expect(load).toContain("aeo_budget_probe_blocked: ['count==10']");
    expect(load).toContain("aeo_budget_probe_failures: ['count==0']");
    expect(load).toContain("aeo_budget_probe_success: ['rate==1']");
    expect(budgetProbe).toMatch(
      /check\([\s\S]*status\s*===\s*202[\s\S]*status\s*===\s*'BUDGET_BLOCKED'/u,
    );
    expect(budgetProbe).toContain('budgetProbeAttempts.add(1)');
    expect(budgetProbe).toContain('budgetProbeBlocked.add(0)');
    expect(budgetProbe).toContain('budgetProbeFailures.add(0)');
    expect(budgetProbe).toContain('budgetProbeBlocked.add(1)');
    expect(budgetProbe).toContain('budgetProbeFailures.add(1)');
    expect(budgetProbe).toContain('budgetProbeSuccess.add(blocked)');
    expect(budgetProbe).not.toMatch(/if\s*\(!accepted\)\s*return/u);
  });
});
