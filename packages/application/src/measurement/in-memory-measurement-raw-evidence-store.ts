import { createHash } from 'node:crypto';

import type { MeasurementRawEvidenceStore } from './ports.js';
import type { RawMeasurementEvidencePayload } from './types.js';

interface StoredPayload {
  tenantId: string;
  workspaceId: string;
  contentHash: string;
  payload: RawMeasurementEvidencePayload;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export class InMemoryMeasurementRawEvidenceStore implements MeasurementRawEvidenceStore {
  private readonly payloads = new Map<string, StoredPayload>();

  put(input: Parameters<MeasurementRawEvidenceStore['put']>[0]) {
    const payload = structuredClone(input.payload);
    const contentHash = createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
    const objectRef =
      `measurement-evidence://${input.tenantId}/${input.workspaceId}/` +
      `${input.measurementRunId}/${input.promptRunId}`;
    this.payloads.set(objectRef, {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      contentHash,
      payload,
    });
    return Promise.resolve({
      outcome: 'SUCCEEDED' as const,
      reference: { objectRef, contentHash },
    });
  }

  get(input: Parameters<MeasurementRawEvidenceStore['get']>[0]) {
    const stored = this.payloads.get(input.objectRef);
    if (
      stored === undefined ||
      stored.tenantId !== input.tenantId ||
      stored.workspaceId !== input.workspaceId ||
      stored.contentHash !== input.contentHash
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(structuredClone(stored.payload));
  }
}
