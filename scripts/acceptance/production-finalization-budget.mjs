import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const productionJobDeadlineWindowMilliseconds = 21_000_000;
export const releaseExecutionObservationMilliseconds = 4_260_000;
export const smokeLeaseMilliseconds = 900_000;
export const postTerminalEvidenceMilliseconds = 1_500_000;
export const finalizationSafetyMarginMilliseconds = 720_000;
export const minimumRecoveryRemainingMilliseconds =
  2 * releaseExecutionObservationMilliseconds +
  postTerminalEvidenceMilliseconds +
  finalizationSafetyMarginMilliseconds;
export const minimumFinalizationRemainingMilliseconds =
  Math.max(releaseExecutionObservationMilliseconds, smokeLeaseMilliseconds) +
  2 * releaseExecutionObservationMilliseconds +
  postTerminalEvidenceMilliseconds +
  finalizationSafetyMarginMilliseconds;

function fail(code) {
  throw new Error(code);
}

function epochMilliseconds(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('PRODUCTION_FINALIZATION_BUDGET_INVALID');
  }
  return value;
}

export function evaluateProductionFinalizationBudget(input) {
  const nowEpochMilliseconds = epochMilliseconds(input?.nowEpochMilliseconds);
  const deadlineEpochMilliseconds = epochMilliseconds(input?.deadlineEpochMilliseconds);
  const remainingMilliseconds = deadlineEpochMilliseconds - nowEpochMilliseconds;
  return {
    schemaVersion: 'aeostudio.production-finalization-budget.v1',
    deadlineEpochMilliseconds,
    minimumRemainingMilliseconds: minimumFinalizationRemainingMilliseconds,
    nowEpochMilliseconds,
    remainingMilliseconds,
    finalizeAuthorized: remainingMilliseconds >= minimumFinalizationRemainingMilliseconds,
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    fail('PRODUCTION_FINALIZATION_BUDGET_INVALID');
  }
  const parsed = Number(value);
  return epochMilliseconds(parsed);
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const result = evaluateProductionFinalizationBudget({
      nowEpochMilliseconds: Date.now(),
      deadlineEpochMilliseconds: requiredEnvironment(
        'AEO_PRODUCTION_JOB_DEADLINE_EPOCH_MILLISECONDS',
      ),
    });
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (typeof githubOutput !== 'string' || githubOutput.length === 0) {
      fail('PRODUCTION_FINALIZATION_BUDGET_OUTPUT_INVALID');
    }
    appendFileSync(
      githubOutput,
      [
        `finalize_authorized=${result.finalizeAuthorized}`,
        `remaining_milliseconds=${result.remainingMilliseconds}`,
        '',
      ].join('\n'),
      'utf8',
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.finalizeAuthorized) {
      fail('PRODUCTION_FINALIZATION_BUDGET_INSUFFICIENT');
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'PRODUCTION_FINALIZATION_BUDGET_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
