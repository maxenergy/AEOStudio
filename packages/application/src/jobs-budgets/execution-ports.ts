import type { JobRecord, JobStatus, JobType } from '@aeostudio/domain/jobs-budgets';

export interface JobQueuePayload {
  jobId: string;
  tenantId: string;
  workspaceId: string;
  schemaVersion: '1.0.0';
}

export interface JobQueueMessage {
  messageId: string;
  payload: JobQueuePayload;
}

export interface JobTraceContext {
  traceparent: string;
  requestId: string;
}

export interface JobTraceContextProvider {
  capture(requestId: string): JobTraceContext | undefined;
}

export interface JobQueuePort {
  send(message: JobQueueMessage, traceContext?: JobTraceContext): Promise<void>;
}

export interface JobQueueRouterPort {
  route(jobType: JobType, message: JobQueueMessage, traceContext?: JobTraceContext): Promise<void>;
}

export interface PendingOutboxMessage extends JobQueueMessage {
  jobType: JobType;
  tenantId: string;
  traceContext?: JobTraceContext;
}

export interface JobTraceOperation {
  operation: 'OUTBOX_RELAY' | 'WORKER_PROCESS';
  traceContext: JobTraceContext;
  message: JobQueueMessage;
}

export interface JobTraceContextRunnerPort {
  run<T>(input: JobTraceOperation, operation: () => Promise<T>): Promise<T>;
}

export interface JobLease {
  job: JobRecord;
  leaseToken: string;
  messageId: string;
}

export type JobClaimResult =
  | { outcome: 'CLAIMED'; lease: JobLease }
  | { outcome: 'DUPLICATE' | 'CONCURRENCY_LIMIT' | 'BUSY' | 'NOT_AVAILABLE' };

export interface JobExecutionStore {
  listPendingOutbox(limit: number): Promise<PendingOutboxMessage[]>;
  markOutboxPublished(messageId: string, tenantId: string, publishedAt: Date): Promise<void>;
  claimJob(input: {
    message: JobQueueMessage;
    consumer: string;
    inboxId: string;
    leaseToken: string;
    eventId: string;
    now: Date;
    leaseDurationMs: number;
  }): Promise<JobClaimResult>;
  heartbeat(input: { lease: JobLease; now: Date; leaseDurationMs: number }): Promise<boolean>;
  reportProgress(input: { lease: JobLease; now: Date; progress: number }): Promise<boolean>;
  complete(input: {
    lease: JobLease;
    now: Date;
    result: Record<string, unknown>;
    actualUnits: number;
    usageLedgerId: string;
    eventId: string;
  }): Promise<boolean>;
  fail(input: {
    lease: JobLease;
    now: Date;
    classification: 'RETRYABLE' | 'TERMINAL';
    errorCode: string;
    retryAt: Date;
    eventId: string;
  }): Promise<JobStatus | false>;
}

export interface JobClock {
  now(): Date;
}
