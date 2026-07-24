import {
  readJobTraceContext,
  type JobQueueMessage,
  type JobQueuePort,
  type JobTraceContext,
} from '@aeostudio/application/jobs-budgets';

interface SqsMessageAttributeValue {
  DataType?: string | undefined;
  StringValue?: string | undefined;
}

interface SqsOutboundMessageAttributeValue {
  DataType: string;
  StringValue?: string | undefined;
}

export interface AwsSqsApi {
  sendMessage(input: {
    QueueUrl: string;
    MessageBody: string;
    MessageAttributes?: Record<string, SqsOutboundMessageAttributeValue> | undefined;
  }): Promise<{
    MessageId?: string | undefined;
  }>;
  receiveMessage(
    input: {
      QueueUrl: string;
      MaxNumberOfMessages: 1;
      WaitTimeSeconds: number;
      VisibilityTimeout: number;
      MessageAttributeNames: ['traceparent', 'request_id'];
    },
    signal?: AbortSignal,
  ): Promise<{
    Messages?:
      | Array<{
          MessageId?: string | undefined;
          ReceiptHandle?: string | undefined;
          Body?: string | undefined;
          MessageAttributes?: Record<string, SqsMessageAttributeValue> | undefined;
        }>
      | undefined;
  }>;
  deleteMessage(input: { QueueUrl: string; ReceiptHandle: string }): Promise<unknown>;
  changeMessageVisibility(input: {
    QueueUrl: string;
    ReceiptHandle: string;
    VisibilityTimeout: number;
  }): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class AwsSqsJobQueue implements JobQueuePort {
  private readonly queueUrl: string;

  public constructor(
    private readonly api: AwsSqsApi,
    input: { queueUrl: string },
  ) {
    this.queueUrl = readSingaporeQueueUrl(input.queueUrl);
  }

  public async send(message: JobQueueMessage, traceContext?: JobTraceContext): Promise<void> {
    const body = JSON.stringify(readJobMessage(message));
    const validatedTraceContext =
      traceContext === undefined ? undefined : readJobTraceContext(traceContext);
    const result = await this.api.sendMessage({
      QueueUrl: this.queueUrl,
      MessageBody: body,
      ...(validatedTraceContext === undefined
        ? {}
        : {
            MessageAttributes: {
              traceparent: {
                DataType: 'String',
                StringValue: validatedTraceContext.traceparent,
              },
              request_id: {
                DataType: 'String',
                StringValue: validatedTraceContext.requestId,
              },
            },
          }),
    });
    if (typeof result.MessageId !== 'string' || result.MessageId.length === 0) {
      throw new Error('SQS_SEND_NOT_ACKNOWLEDGED');
    }
  }
}

export interface AwsSqsJobDelivery {
  message: JobQueueMessage;
  traceContext?: JobTraceContext;
  acknowledge(): Promise<void>;
  extendVisibility(visibilityTimeoutSeconds: number): Promise<void>;
  release(visibilityTimeoutSeconds: number): Promise<void>;
}

export class AwsSqsJobQueueConsumer {
  private readonly queueUrl: string;
  private readonly visibilityTimeoutSeconds: number;
  private readonly waitTimeSeconds: number;

  public constructor(
    private readonly api: AwsSqsApi,
    input: {
      queueUrl: string;
      visibilityTimeoutSeconds: number;
      waitTimeSeconds: number;
    },
  ) {
    this.queueUrl = readSingaporeQueueUrl(input.queueUrl);
    this.visibilityTimeoutSeconds = readBoundedInteger(
      input.visibilityTimeoutSeconds,
      1,
      43_200,
      'INVALID_SQS_VISIBILITY_TIMEOUT',
    );
    this.waitTimeSeconds = readBoundedInteger(
      input.waitTimeSeconds,
      1,
      20,
      'INVALID_SQS_WAIT_TIME',
    );
  }

  public async receive(signal?: AbortSignal): Promise<AwsSqsJobDelivery | null> {
    if (signal?.aborted) return null;
    const result = await this.api.receiveMessage(
      {
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.waitTimeSeconds,
        VisibilityTimeout: this.visibilityTimeoutSeconds,
        MessageAttributeNames: ['traceparent', 'request_id'],
      },
      signal,
    );
    const raw = result.Messages?.[0];
    if (raw === undefined) return null;
    if (
      result.Messages?.length !== 1 ||
      typeof raw.ReceiptHandle !== 'string' ||
      raw.ReceiptHandle.length < 1 ||
      raw.ReceiptHandle.length > 4_096 ||
      typeof raw.Body !== 'string' ||
      raw.Body.length < 2 ||
      Buffer.byteLength(raw.Body, 'utf8') > 16_384
    ) {
      throw new Error('INVALID_SQS_DELIVERY');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.Body);
    } catch {
      throw new Error('INVALID_SQS_JOB_JSON');
    }
    const message = readInboundJobMessage(parsed);
    const traceContext = readSqsTraceContext(raw.MessageAttributes);
    const receiptHandle = raw.ReceiptHandle;
    let state: 'PENDING' | 'ACKNOWLEDGED' | 'RELEASED' = 'PENDING';
    return {
      message,
      ...(traceContext === undefined ? {} : { traceContext }),
      extendVisibility: async (visibilityTimeoutSeconds: number) => {
        if (state !== 'PENDING') throw new Error('SQS_DELIVERY_NOT_IN_FLIGHT');
        const boundedVisibilityTimeout = readBoundedInteger(
          visibilityTimeoutSeconds,
          1,
          43_200,
          'INVALID_SQS_VISIBILITY_EXTENSION',
        );
        await this.api.changeMessageVisibility({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: boundedVisibilityTimeout,
        });
      },
      acknowledge: async () => {
        if (state === 'ACKNOWLEDGED') return;
        if (state === 'RELEASED') throw new Error('SQS_DELIVERY_ALREADY_RELEASED');
        await this.api.deleteMessage({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle });
        state = 'ACKNOWLEDGED';
      },
      release: async (visibilityTimeoutSeconds: number) => {
        if (state === 'RELEASED') return;
        if (state === 'ACKNOWLEDGED') throw new Error('SQS_DELIVERY_ALREADY_ACKNOWLEDGED');
        const boundedVisibilityTimeout = readBoundedInteger(
          visibilityTimeoutSeconds,
          1,
          43_200,
          'INVALID_SQS_RELEASE_VISIBILITY_TIMEOUT',
        );
        await this.api.changeMessageVisibility({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: boundedVisibilityTimeout,
        });
        state = 'RELEASED';
      },
    };
  }
}

function readSqsTraceContext(
  attributes: Record<string, SqsMessageAttributeValue> | undefined,
): JobTraceContext | undefined {
  if (attributes === undefined) return undefined;
  const traceparent = readStringMessageAttribute(attributes.traceparent);
  const requestId = readStringMessageAttribute(attributes.request_id);
  if (traceparent === undefined && requestId === undefined) return undefined;
  if (traceparent === undefined || requestId === undefined) {
    throw new Error('INVALID_SQS_TRACE_CONTEXT');
  }
  try {
    return readJobTraceContext({ traceparent, requestId });
  } catch {
    throw new Error('INVALID_SQS_TRACE_CONTEXT');
  }
}

function readStringMessageAttribute(
  value: SqsMessageAttributeValue | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.DataType !== 'String' || typeof value.StringValue !== 'string') {
    throw new Error('INVALID_SQS_TRACE_CONTEXT');
  }
  return value.StringValue;
}

export function readJobMessage(value: unknown): JobQueueMessage {
  if (!isRecord(value)) throw new Error('INVALID_SQS_JOB_ENVELOPE');
  if (!isUuid(value.messageId) || !isRecord(value.payload)) {
    throw new Error('INVALID_SQS_JOB_ENVELOPE');
  }
  const payload = value.payload;
  // Outbound callers may be structurally over-wide; serialize only the frozen allowlist.
  if (!isUuid(payload.jobId) || !isUuid(payload.tenantId) || !isUuid(payload.workspaceId)) {
    throw new Error('INVALID_SQS_JOB_SCOPE');
  }
  if (payload.schemaVersion !== '1.0.0') throw new Error('UNSUPPORTED_SQS_JOB_SCHEMA');
  return {
    messageId: value.messageId.toLowerCase(),
    payload: {
      jobId: payload.jobId.toLowerCase(),
      tenantId: payload.tenantId.toLowerCase(),
      workspaceId: payload.workspaceId.toLowerCase(),
      schemaVersion: '1.0.0',
    },
  };
}

export function readInboundJobMessage(value: unknown): JobQueueMessage {
  if (!isRecord(value) || !hasExactKeys(value, ['messageId', 'payload'])) {
    throw new Error('INVALID_SQS_JOB_ENVELOPE');
  }
  if (
    !isRecord(value.payload) ||
    !hasExactKeys(value.payload, ['jobId', 'tenantId', 'workspaceId', 'schemaVersion'])
  ) {
    throw new Error('INVALID_SQS_JOB_ENVELOPE');
  }
  return readJobMessage(value);
}

export function readSingaporeQueueUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_SQS_QUEUE_URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'sqs.ap-southeast-1.amazonaws.com' ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !/^\/\d{12}\/[A-Za-z0-9_-]{1,80}(?:\.fifo)?$/u.test(url.pathname)
  ) {
    throw new Error('SQS_QUEUE_OUTSIDE_SINGAPORE_SCOPE');
  }
  return url.toString();
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readBoundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
