import { describe, expect, test } from 'vitest';

import {
  ProblemDetailsSchema,
  RuntimeBuildIdentityEnvelopeSchema,
  SessionEnvelopeSchema,
} from './auth.contracts.js';

describe('Task 1 authentication contracts', () => {
  test('the browser session envelope rejects accidental token fields', () => {
    const result = SessionEnvelopeSchema.safeParse({
      data: {
        email: 'owner@example.test',
        expiresAt: '2026-07-20T18:00:00.000Z',
        sessionToken: 'must-never-reach-the-browser',
      },
      meta: {
        requestId: 'request-1',
        schemaVersion: '1.0.0',
      },
    });

    expect(result.success).toBe(false);
  });

  test('problem details preserve RFC extension members while validating the required core', () => {
    const result = ProblemDetailsSchema.parse({
      type: 'https://aeostudio.local/problems/validation-error',
      title: 'Request rejected',
      status: 400,
      code: 'VALIDATION_ERROR',
      detail: 'The request is invalid.',
      requestId: 'request-2',
      retryable: false,
      fieldErrors: [{ path: 'name', code: 'too_small', message: 'Required' }],
    });

    expect(result.fieldErrors).toEqual([{ path: 'name', code: 'too_small', message: 'Required' }]);
  });

  test('runtime build identity is a strict task-local response contract', () => {
    const response = {
      data: {
        identity: {
          schemaVersion: 'aeostudio.runtime-build-identity.v1',
          source: 'ecs-container-metadata-v4',
          service: 'api',
          taskArn: 'arn:aws:ecs:ap-southeast-1:123456789012:task/staging/' + 'a'.repeat(32),
          taskDefinitionArn:
            'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/aeostudio-api:17',
          containerArn:
            'arn:aws:ecs:ap-southeast-1:123456789012:container/staging/' +
            `${'a'.repeat(32)}/${'b'.repeat(32)}`,
          image:
            '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-api@' +
            `sha256:${'c'.repeat(64)}`,
          imageDigest: `sha256:${'c'.repeat(64)}`,
          imageId: `sha256:${'c'.repeat(64)}`,
          capturedAt: '2026-07-23T12:00:00.000Z',
        },
      },
      meta: { requestId: 'request-3', schemaVersion: '1.0.0' },
    };

    expect(RuntimeBuildIdentityEnvelopeSchema.parse(response)).toEqual(response);
    expect(() =>
      RuntimeBuildIdentityEnvelopeSchema.parse({
        ...response,
        data: { identity: { ...response.data.identity, accessToken: 'must-not-pass' } },
      }),
    ).toThrow();
  });
});
