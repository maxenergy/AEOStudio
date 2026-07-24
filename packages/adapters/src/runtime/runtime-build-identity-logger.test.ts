import { describe, expect, test, vi } from 'vitest';

import { bindRuntimeBuildIdentity } from './runtime-build-identity-logger.js';

describe('runtime build identity logger binding', () => {
  test('attaches immutable runtime fields to every event without allowing caller override', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const identity = {
      schemaVersion: 'aeostudio.runtime-build-identity.v1',
      source: 'ecs-container-metadata-v4',
      service: 'worker',
      taskArn: 'arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/' + 'a'.repeat(32),
      taskDefinitionArn:
        'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/aeostudio-staging-worker:9',
      containerArn:
        'arn:aws:ecs:ap-southeast-1:123456789012:container/aeostudio-staging/' +
        `${'a'.repeat(32)}/${'b'.repeat(32)}`,
      image:
        '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-worker@' +
        `sha256:${'c'.repeat(64)}`,
      imageDigest: `sha256:${'c'.repeat(64)}`,
      imageId: `sha256:${'c'.repeat(64)}`,
      capturedAt: '2026-07-23T12:00:00.000Z',
    } as const;
    const bound = bindRuntimeBuildIdentity(logger, identity);

    bound.info('WORKER_JOB_RECEIVED', {
      attributes: { outcome: 'SUCCEEDED', runtimeImageDigest: `sha256:${'f'.repeat(64)}` },
    });

    expect(logger.info).toHaveBeenCalledWith('WORKER_JOB_RECEIVED', {
      attributes: {
        outcome: 'SUCCEEDED',
        runtimeTaskArn: identity.taskArn,
        runtimeTaskDefinitionArn: identity.taskDefinitionArn,
        runtimeImageDigest: identity.imageDigest,
        runtimeImageId: identity.imageId,
      },
    });
  });
});
