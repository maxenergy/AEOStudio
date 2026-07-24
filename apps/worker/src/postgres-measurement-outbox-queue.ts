import type { JobExecutionStore, JobQueueMessage } from '@aeostudio/application/jobs-budgets';
import type { Pool } from 'pg';

import type {
  LocalMeasurementQueueDelivery,
  MeasurementQueueConsumer,
} from './measurement-worker-runtime.js';

interface MeasurementOutboxRow {
  message_id: string;
  tenant_id: string;
  payload: JobQueueMessage['payload'];
}

export class PostgresMeasurementOutboxQueue implements MeasurementQueueConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly jobs: Pick<JobExecutionStore, 'markOutboxPublished'>,
    private readonly clock: { now(): Date },
  ) {}

  async receive(signal?: AbortSignal): Promise<LocalMeasurementQueueDelivery | null> {
    if (signal?.aborted) return null;
    const pending = await this.pool.query<MeasurementOutboxRow>(
      'SELECT * FROM list_pending_measurement_job_outbox($1)',
      [1],
    );
    const row = pending.rows[0];
    if (row === undefined) return null;
    return {
      message: { messageId: row.message_id, payload: row.payload },
      acknowledge: () =>
        this.jobs.markOutboxPublished(row.message_id, row.tenant_id, this.clock.now()),
      release: () => Promise.resolve(),
    };
  }
}
