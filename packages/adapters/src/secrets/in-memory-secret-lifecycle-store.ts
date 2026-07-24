import type { SecretValueProvider } from '@aeostudio/application/channels-publishing';
import type {
  SecretLifecycleMetadata,
  SecretLifecycleStore,
} from '@aeostudio/application/privacy-audit';

const DAY_MS = 24 * 60 * 60 * 1_000;

interface SecretRecord extends SecretLifecycleMetadata {
  value: string | null;
}

type Clock = { now(): Date };

/**
 * Test/dev substitute for a worker-only secret manager. Lifecycle methods
 * expose metadata only; plaintext is available solely through SecretValueProvider.
 */
export class InMemorySecretLifecycleStore implements SecretLifecycleStore, SecretValueProvider {
  private readonly secrets = new Map<string, SecretRecord>();
  private readonly clock: Clock;

  public constructor(input: Clock | { clock: Clock }) {
    this.clock = 'clock' in input ? input.clock : input;
  }

  public configure(input: {
    tenantId: string;
    secretReference: string;
    value: string;
  }): Promise<SecretLifecycleMetadata> {
    if (
      input.tenantId.trim().length === 0 ||
      input.secretReference.trim().length === 0 ||
      input.value.length === 0
    ) {
      return Promise.reject(new Error('INVALID_SECRET_CONFIGURATION'));
    }
    if (this.secrets.has(input.secretReference)) {
      return Promise.reject(new Error('SECRET_REFERENCE_CONFLICT'));
    }
    const record: SecretRecord = {
      tenantId: input.tenantId,
      secretReference: input.secretReference,
      state: 'ACTIVE',
      readable: true,
      revokedAt: null,
      forceDeleteAt: null,
      value: input.value,
    };
    this.secrets.set(input.secretReference, record);
    return Promise.resolve(metadata(record));
  }

  public seed(input: {
    tenantId: string;
    secretReference: string;
    value: string;
  }): Promise<SecretLifecycleMetadata> {
    return this.configure(input);
  }

  public getSecretValue(secretReference: string): Promise<string> {
    const record = this.secrets.get(secretReference);
    if (record === undefined) return Promise.reject(new Error('SECRET_NOT_FOUND'));
    const now = safeClock(this.clock);
    if (now === null) return Promise.reject(new Error('INVALID_SECRET_CLOCK'));
    forceDeleteIfDue(record, now.getTime());
    if (record.state === 'FORCE_DELETED' || record.value === null) {
      return Promise.reject(new Error('SECRET_FORCE_DELETED'));
    }
    if (record.state !== 'ACTIVE' || !record.readable) {
      return Promise.reject(new Error('SECRET_REVOKED'));
    }
    return Promise.resolve(record.value);
  }

  /** Fake-runtime atomic effect boundary; plaintext never leaves the boolean comparison. */
  public isActiveValue(input: {
    tenantId: string;
    secretReference: string;
    value: string;
  }): boolean {
    const record = this.findOwned(input.tenantId, input.secretReference);
    const now = safeClock(this.clock);
    if (record === null || now === null) return false;
    forceDeleteIfDue(record, now.getTime());
    return (
      record.state === 'ACTIVE' &&
      record.readable &&
      record.value !== null &&
      record.value === input.value
    );
  }

  public revoke(
    input: Parameters<SecretLifecycleStore['revoke']>[0],
  ): Promise<SecretLifecycleMetadata> {
    const record = this.findOwned(input.tenantId, input.secretReference);
    if (record === null) return Promise.reject(new Error('SECRET_NOT_FOUND'));
    const now = safeClock(this.clock);
    const revokedAt = readInstant(input.revokedAt);
    const forceDeleteAt = readInstant(input.forceDeleteAt);
    if (
      now === null ||
      revokedAt === null ||
      forceDeleteAt === null ||
      revokedAt > now.getTime() ||
      forceDeleteAt !== revokedAt + DAY_MS
    ) {
      return Promise.reject(new Error('INVALID_SECRET_LIFECYCLE_TIMELINE'));
    }
    if (record.state === 'ACTIVE') {
      record.state = 'REVOKED_PENDING_FORCE_DELETE';
      record.readable = false;
      record.revokedAt = new Date(revokedAt).toISOString();
      record.forceDeleteAt = new Date(forceDeleteAt).toISOString();
    } else if (
      record.revokedAt !== new Date(revokedAt).toISOString() ||
      record.forceDeleteAt !== new Date(forceDeleteAt).toISOString()
    ) {
      return Promise.reject(new Error('SECRET_LIFECYCLE_CONFLICT'));
    }
    forceDeleteIfDue(record, now.getTime());
    return Promise.resolve(metadata(record));
  }

  public describe(
    input: Parameters<SecretLifecycleStore['describe']>[0],
  ): Promise<SecretLifecycleMetadata | null> {
    const at = readInstant(input.at);
    if (at === null) return Promise.reject(new Error('INVALID_SECRET_LIFECYCLE_TIMELINE'));
    const record = this.findOwned(input.tenantId, input.secretReference);
    if (record === null) return Promise.resolve(null);
    forceDeleteIfDue(record, at);
    return Promise.resolve(metadata(record));
  }

  public forceDeleteDue(
    input: Parameters<SecretLifecycleStore['forceDeleteDue']>[0],
  ): Promise<number> {
    const at = readInstant(input.at);
    if (at === null) return Promise.reject(new Error('INVALID_SECRET_LIFECYCLE_TIMELINE'));
    let deleted = 0;
    for (const record of this.secrets.values()) {
      if (record.tenantId !== input.tenantId || record.state !== 'REVOKED_PENDING_FORCE_DELETE') {
        continue;
      }
      if (forceDeleteIfDue(record, at)) deleted += 1;
    }
    return Promise.resolve(deleted);
  }

  private findOwned(tenantId: string, secretReference: string): SecretRecord | null {
    const record = this.secrets.get(secretReference);
    return record === undefined || record.tenantId !== tenantId ? null : record;
  }
}

function forceDeleteIfDue(record: SecretRecord, at: number): boolean {
  if (
    record.state !== 'REVOKED_PENDING_FORCE_DELETE' ||
    record.forceDeleteAt === null ||
    at < Date.parse(record.forceDeleteAt)
  ) {
    return false;
  }
  record.value = null;
  record.state = 'FORCE_DELETED';
  record.readable = false;
  return true;
}

function metadata(record: SecretRecord): SecretLifecycleMetadata {
  return {
    tenantId: record.tenantId,
    secretReference: record.secretReference,
    state: record.state,
    readable: record.readable,
    revokedAt: record.revokedAt,
    forceDeleteAt: record.forceDeleteAt,
  };
}

function safeClock(clock: Clock): Date | null {
  try {
    const value = clock.now();
    return readInstant(value) === null ? null : new Date(value);
  } catch {
    return null;
  }
}

function readInstant(value: Date): number | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}
