import { describe, expect, test } from 'vitest';

import { createStructuredApplicationLogger } from './structured-logger.js';

describe('structured application logger', () => {
  test('serializes bounded operational counts and low-cardinality error codes', () => {
    const lines: string[] = [];
    const logger = createStructuredApplicationLogger({
      serviceName: 'aeostudio-worker',
      destination: { write: (line: string) => lines.push(line) },
    });

    logger.warn('PROVIDER_FAILED', {
      attributes: {
        outcome: 'SUCCEEDED',
        errorCode: 'MEASUREMENT_PROVIDER_SLOT_ERROR',
        count: 2,
        failureCount: 2,
        failureDetail: 'provider response text must not be serialized',
      },
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      service: 'aeostudio-worker',
      event: 'PROVIDER_FAILED',
      outcome: 'SUCCEEDED',
      error_code: 'MEASUREMENT_PROVIDER_SLOT_ERROR',
      count: 2,
    });
    expect(lines[0]).not.toMatch(/failureCount|failureDetail|provider response/iu);
  });

  test('redacts sensitive and high-cardinality application data before stdout serialization', () => {
    const lines: string[] = [];
    const logger = createStructuredApplicationLogger({
      serviceName: 'aeostudio-api',
      destination: { write: (line: string) => lines.push(line) },
    });

    logger.info('HTTP_REQUEST_COMPLETED', {
      correlation: {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        requestId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
        jobId: '018f84b3-7eb8-7c75-9ca5-25278969d3f0',
      },
      attributes: {
        tenantId: '018f84b3-7eb8-7c75-9ca5-25278969d3f1',
        workspaceId: '018f84b3-7eb8-7c75-9ca5-25278969d3f2',
        outcome: 'SUCCEEDED',
        authorization: 'Bearer super-secret-token',
        cookie: 'session=private-cookie',
        token: 'private-token',
        password: 'private-password',
        secretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:private',
        prompt: 'write about a confidential roadmap',
        content: 'customer-owned product content',
        rawResponse: 'provider raw response',
        query: 'select * from users where email = owner@example.test',
        url: 'https://api.example.test/jobs?token=query-secret',
        email: 'owner@example.test',
        phone: '+65 6123 4567',
        arbitraryText: 'must never become a log label or field',
      },
    });

    expect(lines).toHaveLength(1);
    const serialized = lines[0] ?? '';
    expect(serialized).not.toMatch(
      /super-secret|private-cookie|private-token|private-password|confidential roadmap|customer-owned|provider raw|owner@example|6123 4567|select \*|query-secret|arbitraryText/iu,
    );
    expect(JSON.parse(serialized)).toMatchObject({
      service: 'aeostudio-api',
      event: 'HTTP_REQUEST_COMPLETED',
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
      request_id: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
      job_id: '018f84b3-7eb8-7c75-9ca5-25278969d3f0',
      tenant_id: '018f84b3-7eb8-7c75-9ca5-25278969d3f1',
      workspace_id: '018f84b3-7eb8-7c75-9ca5-25278969d3f2',
      outcome: 'SUCCEEDED',
    });
  });

  test('serializes only validated task-local runtime build identity fields', () => {
    const lines: string[] = [];
    const logger = createStructuredApplicationLogger({
      serviceName: 'aeostudio-worker',
      destination: { write: (line: string) => lines.push(line) },
    });
    const taskArn =
      'arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/' + 'a'.repeat(32);
    const taskDefinitionArn =
      'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/aeostudio-staging-worker:9';
    const imageDigest = `sha256:${'b'.repeat(64)}`;
    const imageId = `sha256:${'c'.repeat(64)}`;

    logger.info('WORKER_JOB_RECEIVED', {
      attributes: {
        runtimeTaskArn: taskArn,
        runtimeTaskDefinitionArn: taskDefinitionArn,
        runtimeImageDigest: imageDigest,
        runtimeImageId: imageId,
        runtimeImage: 'registry.example/private/repository',
      },
    });

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      runtime_task_arn: taskArn,
      runtime_task_definition_arn: taskDefinitionArn,
      runtime_image_digest: imageDigest,
      runtime_image_id: imageId,
    });
    expect(lines[0]).not.toContain('registry.example');
  });
});
