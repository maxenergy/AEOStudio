import { createHash } from 'node:crypto';

export function canonicalPrivacyJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CANONICAL_JSON_NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalPrivacyJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        const entry = record[key];
        if (entry === undefined) throw new Error('CANONICAL_JSON_UNDEFINED_VALUE');
        return `${JSON.stringify(key)}:${canonicalPrivacyJson(entry)}`;
      })
      .join(',')}}`;
  }
  throw new Error('CANONICAL_JSON_UNSUPPORTED_VALUE');
}

export function privacySha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
