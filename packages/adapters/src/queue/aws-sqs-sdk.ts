import { AwsSqsJobQueue, AwsSqsJobQueueConsumer, type AwsSqsApi } from './aws-sqs-job-queue.js';

export async function createAwsSqsJobTransport(input: {
  queueUrl: string;
  visibilityTimeoutSeconds?: number;
  waitTimeSeconds?: number;
}) {
  const {
    ChangeMessageVisibilityCommand,
    DeleteMessageCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    SQSClient,
  } = await import('@aws-sdk/client-sqs');
  const client = new SQSClient({ region: 'ap-southeast-1' });
  const api: AwsSqsApi = {
    sendMessage: (command) => client.send(new SendMessageCommand(command)),
    receiveMessage: (command, signal) =>
      client.send(
        new ReceiveMessageCommand(command),
        signal === undefined ? undefined : { abortSignal: signal },
      ),
    deleteMessage: (command) => client.send(new DeleteMessageCommand(command)),
    changeMessageVisibility: (command) => client.send(new ChangeMessageVisibilityCommand(command)),
  };
  return {
    producer: new AwsSqsJobQueue(api, { queueUrl: input.queueUrl }),
    consumer: new AwsSqsJobQueueConsumer(api, {
      queueUrl: input.queueUrl,
      visibilityTimeoutSeconds: input.visibilityTimeoutSeconds ?? 60,
      waitTimeSeconds: input.waitTimeSeconds ?? 20,
    }),
    close() {
      client.destroy();
      return Promise.resolve();
    },
  };
}
