import { describe, expect, test, vi } from 'vitest';

import { handleWebRuntimeBuildIdentityRequest } from './route.js';

const taskId = 'a'.repeat(32);
const containerId = 'b'.repeat(32);
const digest = `sha256:${'c'.repeat(64)}`;
const metadataUri = 'http://169.254.170.2/v4/opaque-web-runtime-token';

function authenticatedRequest(cookie = '__Host-aeo_session=opaque-session'): Request {
  return new Request('https://staging.example.test/runtime/build-identity', {
    headers: { cookie },
  });
}

describe('authenticated Web runtime build identity route', () => {
  test('returns the Web container identity read from ECS metadata v4, not a manifest environment value', async () => {
    const fetch = vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'http://api.internal:3200/api/v1/auth/session') {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { subject: 'opaque-subject' } }), {
            status: 200,
          }),
        );
      }
      if (url === `${metadataUri}/task`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              TaskARN: `arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/${taskId}`,
              Family: 'aeostudio-staging-web',
              Revision: '19',
              Containers: [
                {
                  Name: 'web',
                  ContainerARN: `arn:aws:ecs:ap-southeast-1:123456789012:container/aeostudio-staging/${taskId}/${containerId}`,
                  Image:
                    '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-web@' + digest,
                  ImageID: digest,
                },
              ],
            }),
          ),
        );
      }
      throw new Error(`UNEXPECTED_FETCH:${url}`);
    });

    const response = await handleWebRuntimeBuildIdentityRequest(authenticatedRequest(), {
      environment: {
        API_INTERNAL_ORIGIN: 'http://api.internal:3200',
        ECS_CONTAINER_METADATA_URI_V4: metadataUri,
        WEB_IMAGE_DIGEST: `sha256:${'f'.repeat(64)}`,
      },
      fetch,
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      data: {
        identity: {
          schemaVersion: 'aeostudio.runtime-build-identity.v1',
          source: 'ecs-container-metadata-v4',
          service: 'web',
          taskArn: `arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/${taskId}`,
          taskDefinitionArn:
            'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/aeostudio-staging-web:19',
          containerArn: `arn:aws:ecs:ap-southeast-1:123456789012:container/aeostudio-staging/${taskId}/${containerId}`,
          image: '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-web@' + digest,
          imageDigest: digest,
          imageId: digest,
          capturedAt: '2026-07-23T12:00:00.000Z',
        },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('fails closed before metadata access when the server session is absent or invalid', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));

    const missing = await handleWebRuntimeBuildIdentityRequest(
      authenticatedRequest('unrelated=value'),
      {
        environment: {
          API_INTERNAL_ORIGIN: 'http://api.internal:3200',
          ECS_CONTAINER_METADATA_URI_V4: metadataUri,
        },
        fetch,
      },
    );
    expect(missing.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();

    const invalid = await handleWebRuntimeBuildIdentityRequest(authenticatedRequest(), {
      environment: {
        API_INTERNAL_ORIGIN: 'http://api.internal:3200',
        ECS_CONTAINER_METADATA_URI_V4: metadataUri,
      },
      fetch,
    });
    expect(invalid.status).toBe(401);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(await invalid.json())).not.toContain('opaque-session');
  });
});
