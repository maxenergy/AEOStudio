export interface SyntheticMetricAlarm {
  AlarmName?: string;
  StateValue?: string;
  ActionsEnabled?: boolean;
  AlarmActions?: string[];
}

export function expectedAlarmNames(environment: string): string[];
export interface SyntheticFaultMatrixEntry {
  alarmName: string;
  alarmConfigurationSha256: string | null;
  approvedInjector: string | null;
  expectedSignal: string;
  maxCausalLagSeconds: number;
  notCheckedReason: 'NO_REVIEWED_REAL_FAULT_INJECTOR' | 'CAUSAL_FAULT_EVIDENCE_MISSING';
  requiredEvidence: 'REAL_FAULT_CAUSAL_TRACE';
  type: string;
}
export function expectedSyntheticFaultMatrix(
  environment: string,
): readonly SyntheticFaultMatrixEntry[];
export function validateExactAlarmInventory(
  metricAlarms: SyntheticMetricAlarm[] | undefined,
  environment: string,
  accountId: string,
): string[];
