import { describe, expect, test, vi } from 'vitest';

import { RuntimeBuildIdentityController } from './runtime-build-identity.controller.js';

const identity = {
  schemaVersion: 'aeostudio.runtime-build-identity.v1',
  source: 'ecs-container-metadata-v4',
  service: 'api',
  taskArn: 'arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/' + 'a'.repeat(32),
  taskDefinitionArn:
    'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/aeostudio-staging-api:17',
  containerArn:
    'arn:aws:ecs:ap-southeast-1:123456789012:container/aeostudio-staging/' +
    `${'a'.repeat(32)}/${'b'.repeat(32)}`,
  image:
    '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-api@' + `sha256:${'c'.repeat(64)}`,
  imageDigest: `sha256:${'c'.repeat(64)}`,
  imageId: `sha256:${'c'.repeat(64)}`,
  capturedAt: '2026-07-23T12:00:00.000Z',
} as const;

describe('runtime build identity controller', () => {
  test('returns only task-local build identity to an authenticated session', async () => {
    const auth = { getSession: vi.fn().mockResolvedValue({ subject: 'opaque-subject' }) };
    const controller = new RuntimeBuildIdentityController(auth as never, identity);
    const reply = { code: vi.fn() };

    const result = await controller.get(
      {
        id: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
        cookies: { '__Host-aeo_session': 'opaque-session' },
      } as never,
      reply as never,
    );
    expect(result).toMatchObject({ data: { identity } });
    expect(auth.getSession).toHaveBeenCalledWith('opaque-session');
    expect(JSON.stringify(result)).not.toContain('opaque-session');
  });

  test('fails closed without a valid session or task-local ECS metadata', async () => {
    const auth = { getSession: vi.fn().mockResolvedValue(null) };
    const unauthenticated = new RuntimeBuildIdentityController(auth as never, identity);
    const unauthenticatedReply = { code: vi.fn() };
    await expect(
      unauthenticated.get(
        {
          id: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
          cookies: { '__Host-aeo_session': 'opaque-session' },
        } as never,
        unauthenticatedReply as never,
      ),
    ).resolves.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(unauthenticatedReply.code).toHaveBeenCalledWith(401);

    auth.getSession.mockResolvedValue({ subject: 'opaque-subject' });
    const unavailable = new RuntimeBuildIdentityController(auth as never, null);
    const unavailableReply = { code: vi.fn() };
    await expect(
      unavailable.get(
        {
          id: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
          cookies: { '__Host-aeo_session': 'opaque-session' },
        } as never,
        unavailableReply as never,
      ),
    ).resolves.toMatchObject({ status: 503, code: 'RUNTIME_BUILD_IDENTITY_UNAVAILABLE' });
    expect(unavailableReply.code).toHaveBeenCalledWith(503);
  });
});
