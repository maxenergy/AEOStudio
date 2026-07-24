import { setImmediate as waitForImmediate } from 'node:timers/promises';

import { describe, expect, test } from 'vitest';

import {
  runSerializedBootstrap,
  type BootstrapCriticalSection,
} from '../../packages/db/src/bootstrap-coordinator.js';

class Deferred {
  readonly promise: Promise<void>;
  resolve!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class SessionMutex {
  private tail = Promise.resolve();

  async lock<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.tail;
    const release = new Deferred();
    this.tail = predecessor.then(() => release.promise);
    await predecessor;
    try {
      return await operation();
    } finally {
      release.resolve();
    }
  }
}

describe('Task 18 database bootstrap coordination', () => {
  test('holds one session lock until credentials and their secret values agree', async () => {
    const mutex = new SessionMutex();
    const firstWriteReached = new Deferred();
    const allowFirstWrite = new Deferred();
    const events: string[] = [];
    const shared: { databaseCredential?: string; secretValue?: string } = {};

    function invocation(
      name: 'first' | 'second',
      generatedCredential: string,
    ): BootstrapCriticalSection<{ shouldWrite: boolean; value: string }> {
      return {
        withDatabaseSessionLock: (operation) => mutex.lock(operation),
        readTargetSecrets: () => {
          events.push(`${name}:read`);
          return Promise.resolve({
            shouldWrite: shared.secretValue === undefined,
            value: shared.secretValue ?? generatedCredential,
          });
        },
        reconcileDatabase: ({ value }) => {
          events.push(`${name}:database`);
          shared.databaseCredential = value;
          return Promise.resolve();
        },
        writeTargetSecrets: async ({ shouldWrite, value }) => {
          events.push(`${name}:write:start`);
          if (name === 'first') {
            firstWriteReached.resolve();
            await allowFirstWrite.promise;
          }
          if (shouldWrite) {
            shared.secretValue = value;
          }
          events.push(`${name}:write:end`);
        },
      };
    }

    const first = runSerializedBootstrap(invocation('first', 'credential-a'));
    await firstWriteReached.promise;
    const second = runSerializedBootstrap(invocation('second', 'credential-b'));
    await waitForImmediate();

    expect(events).not.toContain('second:read');
    allowFirstWrite.resolve();
    await Promise.all([first, second]);

    expect(events.indexOf('first:write:end')).toBeLessThan(events.indexOf('second:read'));
    expect(shared).toEqual({
      databaseCredential: 'credential-a',
      secretValue: 'credential-a',
    });
  });
});
