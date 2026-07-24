import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';

export interface OutboxRelayPort {
  relay(limit?: number): Promise<number>;
}

export function createOutboxRelayRuntime(input: {
  relay: OutboxRelayPort;
  logger: StructuredApplicationLogger;
  pollIntervalMs: number;
}) {
  const pollIntervalMs = Math.max(1, Math.min(input.pollIntervalMs, 60_000));

  async function runOnce(): Promise<number> {
    const count = await input.relay.relay(100);
    if (count > 0) {
      input.logger.info('OUTBOX_MESSAGES_RELAYED', {
        attributes: { outcome: 'SUCCEEDED', count },
      });
    }
    return count;
  }

  async function wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(done, pollIntervalMs);
      function done() {
        clearTimeout(timeout);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  return {
    runOnce,
    async run(signal: AbortSignal): Promise<void> {
      while (!signal.aborted) {
        try {
          const count = await runOnce();
          if (count === 0) await wait(signal);
        } catch {
          input.logger.warn('OUTBOX_RELAY_RETRY');
          await wait(signal);
        }
      }
    },
    close: () => Promise.resolve(),
  };
}
