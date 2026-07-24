import type { IdentityIdGenerator } from '../identity-access/index.js';
import type { JobStatus } from '@aeostudio/domain/jobs-budgets';
import type {
  JobClaimResult,
  JobClock,
  JobExecutionStore,
  JobLease,
  JobQueueMessage,
  JobQueuePort,
  JobQueueRouterPort,
  JobTraceContextRunnerPort,
} from './execution-ports.js';

const LEASE_DURATION_MS = 30_000;

export class OutboxRelay {
  constructor(
    private readonly store: JobExecutionStore,
    private readonly queue: JobQueuePort | JobQueueRouterPort,
    private readonly clock: JobClock,
    private readonly traces?: JobTraceContextRunnerPort,
  ) {}

  async relay(limit = 100): Promise<number> {
    const messages = await this.store.listPendingOutbox(limit);
    for (const message of messages) {
      const delivery = { messageId: message.messageId, payload: message.payload };
      const publish = async () => {
        if ('route' in this.queue) {
          if (message.traceContext === undefined) await this.queue.route(message.jobType, delivery);
          else await this.queue.route(message.jobType, delivery, message.traceContext);
        } else {
          if (message.traceContext === undefined) await this.queue.send(delivery);
          else await this.queue.send(delivery, message.traceContext);
        }
      };
      if (message.traceContext === undefined || this.traces === undefined) await publish();
      else {
        await this.traces.run(
          {
            operation: 'OUTBOX_RELAY',
            traceContext: message.traceContext,
            message: delivery,
          },
          publish,
        );
      }
      await this.store.markOutboxPublished(message.messageId, message.tenantId, this.clock.now());
    }
    return messages.length;
  }
}

export class JobWorkerCoordinator {
  static readonly heartbeatIntervalMs = 15_000;

  constructor(
    private readonly store: JobExecutionStore,
    private readonly clock: JobClock,
    private readonly ids: IdentityIdGenerator,
    private readonly consumer = 'profile-readiness-v1',
  ) {}

  claim(message: JobQueueMessage): Promise<JobClaimResult> {
    return this.store.claimJob({
      message,
      consumer: this.consumer,
      inboxId: this.ids.next(),
      leaseToken: this.ids.next(),
      eventId: this.ids.next(),
      now: this.clock.now(),
      leaseDurationMs: LEASE_DURATION_MS,
    });
  }

  heartbeat(lease: JobLease): Promise<boolean> {
    return this.store.heartbeat({
      lease,
      now: this.clock.now(),
      leaseDurationMs: LEASE_DURATION_MS,
    });
  }

  reportProgress(lease: JobLease, progress: number): Promise<boolean> {
    if (!Number.isInteger(progress) || progress <= 0 || progress >= 100) {
      throw new Error('JOB_PROGRESS_MUST_BE_AN_INTEGER_BETWEEN_1_AND_99');
    }
    return this.store.reportProgress({ lease, now: this.clock.now(), progress });
  }

  complete(
    lease: JobLease,
    result: Record<string, unknown>,
    actualUnits: number,
  ): Promise<boolean> {
    return this.store.complete({
      lease,
      now: this.clock.now(),
      result,
      actualUnits,
      usageLedgerId: this.ids.next(),
      eventId: this.ids.next(),
    });
  }

  fail(
    lease: JobLease,
    classification: 'RETRYABLE' | 'TERMINAL',
    errorCode: string,
  ): Promise<JobStatus | false> {
    const exponentialMs = Math.min(30_000, 1_000 * 2 ** Math.max(0, lease.job.attempt - 1));
    const jitterMs = lease.job.id.charCodeAt(0) % 251;
    const now = this.clock.now();
    return this.store.fail({
      lease,
      now,
      classification,
      errorCode,
      retryAt: new Date(now.getTime() + exponentialMs + jitterMs),
      eventId: this.ids.next(),
    });
  }
}
