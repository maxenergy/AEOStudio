import { createHash } from 'node:crypto';

import type { ManualMeasurementImportSlot, RawMeasurementEvidencePayload } from './types.js';

export const REVIEWED_MANUAL_IMPORT_ADAPTER_KEY = 'reviewed-manual-import';
export const REVIEWED_MANUAL_IMPORT_ADAPTER_VERSION = 'manual-import-v1';
export const REVIEWED_MANUAL_IMPORT_TERMS_VERSION = 'manual-import-terms-v1';
export const MANUAL_IMPORT_OBSERVATION_METHOD_VERSION = 'answer-observation-v1';
export const MAX_MANUAL_IMPORT_RAW_EVIDENCE_BYTES = 2_100_000;
export const MAX_MANUAL_IMPORT_TOTAL_EVIDENCE_BYTES = 10_000_000;

export function canonicalMeasurementImportJson(value: unknown): string {
  if (value === undefined) throw new Error('MANUAL_IMPORT_UNDEFINED_VALUE');
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('MANUAL_IMPORT_VALUE_NOT_SERIALIZABLE');
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalMeasurementImportJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalMeasurementImportJson(record[key])}`)
    .join(',')}}`;
}

export function manualMeasurementImportHash(value: unknown): string {
  return createHash('sha256').update(canonicalMeasurementImportJson(value), 'utf8').digest('hex');
}

export function rawEvidenceByteLength(payload: RawMeasurementEvidencePayload): number {
  return Buffer.byteLength(canonicalMeasurementImportJson(payload), 'utf8');
}

export function manualImportSlotContentHash(
  slot: Omit<ManualMeasurementImportSlot, 'contentHash'>,
): string {
  return manualMeasurementImportHash(slot);
}
