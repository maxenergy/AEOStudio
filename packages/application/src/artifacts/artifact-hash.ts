import { createHash } from 'node:crypto';
import type {
  ArtifactClaimBinding,
  ArtifactLineage,
  ArtifactPayload,
  ArtifactType,
} from '@aeostudio/domain/artifacts';

export function hashArtifactRevision(input: {
  schemaVersion: '1.0.0';
  artifactId: string;
  revision: number;
  type: ArtifactType;
  locale: string;
  market: string;
  sourceArtifactIds: string[];
  lineage: ArtifactLineage;
  claimBindings: ArtifactClaimBinding[];
  methodPolicyVersion: string;
  payload: ArtifactPayload;
}): string {
  return createHash('sha256').update(canonicalArtifactJson(input), 'utf8').digest('hex');
}

export function canonicalArtifactJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalArtifactJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalArtifactJson(record[key])}`)
    .join(',')}}`;
}
