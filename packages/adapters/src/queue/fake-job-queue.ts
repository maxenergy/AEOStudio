import type { JobQueueMessage, JobQueuePort } from '@aeostudio/application/jobs-budgets';

export class FakeJobQueue implements JobQueuePort {
  private readonly messages: JobQueueMessage[] = [];

  send(message: JobQueueMessage): Promise<void> {
    this.messages.push(structuredClone(message));
    return Promise.resolve();
  }

  receive(): JobQueueMessage | undefined {
    const message = this.messages.shift();
    return message === undefined ? undefined : structuredClone(message);
  }

  redeliver(message: JobQueueMessage): void {
    this.messages.push(structuredClone(message));
  }

  size(): number {
    return this.messages.length;
  }
}
