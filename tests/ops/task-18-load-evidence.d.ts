declare module '*scripts/load/task-18-load-contract.mjs' {
  export const REQUIRED_LOAD_THRESHOLD_METRICS: readonly string[];
  export const REQUIRED_ACCEPTED_JOB_COUNT: 50;
  export const ACCEPTED_JOB_ID_CANONICALIZATION: string;

  export function acceptedJobIdsCanonicalPayload(ids: readonly string[]): string;
  export function canonicalAcceptedJobIds(ids: readonly string[]): readonly string[];
  export function jobSubmissionScopes(configuration: unknown): readonly unknown[];
  export function loadConfigurationFromEnvironment(
    environment: Record<string, string | undefined>,
  ): unknown;
  export function loadRunIdentityFromEnvironment(
    environment: Record<string, string | undefined>,
  ): unknown;
  export function sessionScopeForVu(configuration: unknown, vu: number): unknown;
}

declare module '*scripts/load/finalize-task-18-load-evidence.mjs' {
  export function finalizeTask18LoadEvidence(input: {
    environment: Record<string, string | undefined>;
    now?: () => Date;
  }): Promise<unknown>;
}
