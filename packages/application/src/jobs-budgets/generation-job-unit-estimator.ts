export type GenerationJobUnitEstimateInput =
  | {
      jobType: 'CONTENT_PLAN';
      methodVersion: string;
      boundedInput: {
        primaryClaimCount: number;
        comparisonClaimCount: number;
      };
    }
  | {
      jobType: 'ARTIFACT_GENERATION';
      methodVersion: string;
      boundedInput: {
        briefCount: number;
        localeLength: number;
        marketLength: number;
      };
    };

function requireBoundedInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`INVALID_JOB_ESTIMATE_INPUT:${name}`);
  }
}

export function estimateGenerationJobUnits(input: GenerationJobUnitEstimateInput): number {
  if (input.jobType === 'CONTENT_PLAN') {
    if (input.methodVersion !== 'content-plan-v1') {
      throw new Error('UNSUPPORTED_JOB_ESTIMATE_METHOD:CONTENT_PLAN');
    }
    requireBoundedInteger('primaryClaimCount', input.boundedInput.primaryClaimCount, 0, 50);
    requireBoundedInteger('comparisonClaimCount', input.boundedInput.comparisonClaimCount, 0, 50);

    return (
      1 +
      (input.boundedInput.primaryClaimCount > 0 ? 2 : 0) +
      (input.boundedInput.comparisonClaimCount > 0 ? 1 : 0)
    );
  }

  if (input.methodVersion !== 'artifact-fixture-v1') {
    throw new Error('UNSUPPORTED_JOB_ESTIMATE_METHOD:ARTIFACT_GENERATION');
  }
  requireBoundedInteger('briefCount', input.boundedInput.briefCount, 1, 1);
  requireBoundedInteger('localeLength', input.boundedInput.localeLength, 2, 35);
  requireBoundedInteger('marketLength', input.boundedInput.marketLength, 1, 120);
  return 5;
}
