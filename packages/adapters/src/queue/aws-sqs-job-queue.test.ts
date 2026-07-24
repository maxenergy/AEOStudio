import type { JobQueueMessage } from '@aeostudio/application/jobs-budgets';
import { describe, expect, test, vi } from 'vitest';

import { AwsSqsJobQueue, AwsSqsJobQueueConsumer, type AwsSqsApi } from './aws-sqs-job-queue.js';

const QUEUE_URL = 'https://sqs.ap-southeast-1.amazonaws.com/123456789012/aeostudio-jobs';

describe('AWS SQS job transport', () => {
  test('publishes only the versioned opaque job envelope', async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ MessageId: 'aws-message-id' }),
      receiveMessage: vi.fn(),
      deleteMessage: vi.fn(),
      changeMessageVisibility: vi.fn(),
    };
    const queue = new AwsSqsJobQueue(api, { queueUrl: QUEUE_URL });
    const message = {
      messageId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
      payload: {
        jobId: '018f84b3-7eb8-7c75-9ca5-25278969d3f0',
        tenantId: '018f84b3-7eb8-7c75-9ca5-25278969d3f1',
        workspaceId: '018f84b3-7eb8-7c75-9ca5-25278969d3f2',
        schemaVersion: '1.0.0',
        prompt: 'never send prompt content',
        token: 'never-send-token',
      },
      rawResponse: 'never send provider content',
    } as unknown as JobQueueMessage;

    await queue.send(message);

    expect(api.sendMessage).toHaveBeenCalledOnce();
    const sent = api.sendMessage.mock.calls[0]?.[0] as { MessageBody: string } | undefined;
    const body = sent?.MessageBody ?? '';
    expect(JSON.parse(body)).toEqual({
      messageId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
      payload: {
        jobId: '018f84b3-7eb8-7c75-9ca5-25278969d3f0',
        tenantId: '018f84b3-7eb8-7c75-9ca5-25278969d3f1',
        workspaceId: '018f84b3-7eb8-7c75-9ca5-25278969d3f2',
        schemaVersion: '1.0.0',
      },
    });
    expect(body).not.toMatch(/prompt|token|rawResponse|provider content/iu);
  });

  test('receives one strict envelope and acknowledges it by receipt handle exactly once', async () => {
    const body = JSON.stringify({
      messageId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
      payload: {
        jobId: '018f84b3-7eb8-7c75-9ca5-25278969d3f0',
        tenantId: '018f84b3-7eb8-7c75-9ca5-25278969d3f1',
        workspaceId: '018f84b3-7eb8-7c75-9ca5-25278969d3f2',
        schemaVersion: '1.0.0',
      },
    });
    const api = {
      sendMessage: vi.fn(),
      receiveMessage: vi.fn().mockResolvedValue({
        Messages: [{ MessageId: 'aws-message-id', ReceiptHandle: 'opaque-receipt', Body: body }],
      }),
      deleteMessage: vi.fn().mockResolvedValue({}),
      changeMessageVisibility: vi.fn().mockResolvedValue({}),
    };
    const queue = new AwsSqsJobQueueConsumer(api, {
      queueUrl: QUEUE_URL,
      visibilityTimeoutSeconds: 60,
      waitTimeSeconds: 20,
    });

    const delivery = await queue.receive();
    expect(delivery?.message).toEqual(JSON.parse(body));
    await delivery?.acknowledge();
    await delivery?.acknowledge();

    expect(api.receiveMessage).toHaveBeenCalledWith(
      {
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: 60,
        MessageAttributeNames: ['traceparent', 'request_id'],
      },
      undefined,
    );
    expect(api.deleteMessage).toHaveBeenCalledOnce();
    expect(api.deleteMessage).toHaveBeenCalledWith({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: 'opaque-receipt',
    });
    expect(api.changeMessageVisibility).not.toHaveBeenCalled();
  });

  test('defers a retryable delivery with a non-zero bounded visibility timeout', async () => {
    const body = JSON.stringify({
      messageId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
      payload: {
        jobId: '018f84b3-7eb8-7c75-9ca5-25278969d3f0',
        tenantId: '018f84b3-7eb8-7c75-9ca5-25278969d3f1',
        workspaceId: '018f84b3-7eb8-7c75-9ca5-25278969d3f2',
        schemaVersion: '1.0.0',
      },
    });
    const api = {
      sendMessage: vi.fn(),
      receiveMessage: vi.fn().mockResolvedValue({
        Messages: [{ MessageId: 'aws-message-id', ReceiptHandle: 'opaque-receipt', Body: body }],
      }),
      deleteMessage: vi.fn(),
      changeMessageVisibility: vi.fn().mockResolvedValue({}),
    };
    const queue = new AwsSqsJobQueueConsumer(api, {
      queueUrl: QUEUE_URL,
      visibilityTimeoutSeconds: 60,
      waitTimeSeconds: 20,
    });

    const delivery = await queue.receive();
    await delivery?.release(30);

    expect(api.changeMessageVisibility).toHaveBeenCalledWith({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: 'opaque-receipt',
      VisibilityTimeout: 30,
    });
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  test('extends visibility without releasing the in-flight delivery', async () => {
    const body = JSON.stringify({
      messageId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
      payload: {
        jobId: '018f84b3-7eb8-7c75-9ca5-25278969d3f0',
        tenantId: '018f84b3-7eb8-7c75-9ca5-25278969d3f1',
        workspaceId: '018f84b3-7eb8-7c75-9ca5-25278969d3f2',
        schemaVersion: '1.0.0',
      },
    });
    const api = {
      sendMessage: vi.fn(),
      receiveMessage: vi.fn().mockResolvedValue({
        Messages: [{ MessageId: 'aws-message-id', ReceiptHandle: 'opaque-receipt', Body: body }],
      }),
      deleteMessage: vi.fn().mockResolvedValue({}),
      changeMessageVisibility: vi.fn().mockResolvedValue({}),
    };
    const queue = new AwsSqsJobQueueConsumer(api, {
      queueUrl: QUEUE_URL,
      visibilityTimeoutSeconds: 60,
      waitTimeSeconds: 20,
    });

    const delivery = await queue.receive();
    await delivery?.extendVisibility(60);
    await delivery?.acknowledge();

    expect(api.changeMessageVisibility).toHaveBeenCalledWith({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: 'opaque-receipt',
      VisibilityTimeout: 60,
    });
    expect(api.deleteMessage).toHaveBeenCalledOnce();
  });

  test('carries validated trace context in SQS attributes and never in the body', async () => {
    const sendMessage = vi.fn<AwsSqsApi['sendMessage']>(() =>
      Promise.resolve({ MessageId: 'aws-message-id' }),
    );
    const api = {
      sendMessage,
      receiveMessage: vi.fn(),
      deleteMessage: vi.fn(),
      changeMessageVisibility: vi.fn(),
    };
    const queue = new AwsSqsJobQueue(api, { queueUrl: QUEUE_URL });
    const message = {
      messageId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
      payload: {
        jobId: '018f84b3-7eb8-7c75-9ca5-25278969d3f0',
        tenantId: '018f84b3-7eb8-7c75-9ca5-25278969d3f1',
        workspaceId: '018f84b3-7eb8-7c75-9ca5-25278969d3f2',
        schemaVersion: '1.0.0' as const,
      },
    };
    const traceContext = {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      requestId: '018f84b3-7eb8-7c75-9ca5-25278969d3f3',
    };

    await queue.send(message, traceContext);

    const sent = sendMessage.mock.calls[0]?.[0];
    expect(sent?.MessageAttributes).toEqual({
      traceparent: { DataType: 'String', StringValue: traceContext.traceparent },
      request_id: { DataType: 'String', StringValue: traceContext.requestId },
    });
    expect(JSON.parse(sent?.MessageBody ?? '{}')).toEqual(message);
    expect(sent?.MessageBody).not.toContain('traceparent');
    expect(sent?.MessageBody).not.toContain('requestId');
  });

  test('extracts only a complete valid trace context from SQS message attributes', async () => {
    const body = JSON.stringify({
      messageId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
      payload: {
        jobId: '018f84b3-7eb8-7c75-9ca5-25278969d3f0',
        tenantId: '018f84b3-7eb8-7c75-9ca5-25278969d3f1',
        workspaceId: '018f84b3-7eb8-7c75-9ca5-25278969d3f2',
        schemaVersion: '1.0.0',
      },
    });
    const traceContext = {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      requestId: '018f84b3-7eb8-7c75-9ca5-25278969d3f3',
    };
    const api = {
      sendMessage: vi.fn(),
      receiveMessage: vi.fn().mockResolvedValue({
        Messages: [
          {
            ReceiptHandle: 'opaque-receipt',
            Body: body,
            MessageAttributes: {
              traceparent: { DataType: 'String', StringValue: traceContext.traceparent },
              request_id: { DataType: 'String', StringValue: traceContext.requestId },
            },
          },
        ],
      }),
      deleteMessage: vi.fn(),
      changeMessageVisibility: vi.fn(),
    };
    const queue = new AwsSqsJobQueueConsumer(api, {
      queueUrl: QUEUE_URL,
      visibilityTimeoutSeconds: 60,
      waitTimeSeconds: 20,
    });

    await expect(queue.receive()).resolves.toMatchObject({ traceContext });

    api.receiveMessage.mockResolvedValueOnce({
      Messages: [
        {
          ReceiptHandle: 'opaque-receipt',
          Body: body,
          MessageAttributes: {
            traceparent: { DataType: 'String', StringValue: traceContext.traceparent },
          },
        },
      ],
    });
    await expect(queue.receive()).rejects.toThrow('INVALID_SQS_TRACE_CONTEXT');
  });
});
