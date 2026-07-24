import { describe, expect, test, vi } from 'vitest';

import { resolveEcsRuntimeBuildIdentity } from './ecs-runtime-build-identity.js';

const taskId = 'a'.repeat(32);
const containerId = 'b'.repeat(32);
const digest = `sha256:${'c'.repeat(64)}`;
const imageId = digest;
const metadataUri = 'http://169.254.170.2/v4/opaque-runtime-token';

describe('ECS runtime build identity', () => {
  test('derives the running task and image digest from ECS metadata instead of release input', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          TaskARN: `arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/${taskId}`,
          Family: 'aeostudio-staging-api',
          Revision: '17',
          Containers: [
            {
              Name: 'sidecar',
              ContainerARN: `arn:aws:ecs:ap-southeast-1:123456789012:container/aeostudio-staging/${taskId}/${'e'.repeat(32)}`,
              Image:
                '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-sidecar@' +
                `sha256:${'e'.repeat(64)}`,
              ImageID: `sha256:${'f'.repeat(64)}`,
            },
            {
              Name: 'api',
              ContainerARN: `arn:aws:ecs:ap-southeast-1:123456789012:container/aeostudio-staging/${taskId}/${containerId}`,
              Image: '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-api@' + digest,
              ImageID: imageId,
            },
          ],
        }),
      ),
    );

    await expect(
      resolveEcsRuntimeBuildIdentity({
        service: 'api',
        environment: { ECS_CONTAINER_METADATA_URI_V4: metadataUri },
        fetch,
        now: () => new Date('2026-07-23T12:00:00.000Z'),
      }),
    ).resolves.toEqual({
      schemaVersion: 'aeostudio.runtime-build-identity.v1',
      source: 'ecs-container-metadata-v4',
      service: 'api',
      taskArn: `arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/${taskId}`,
      taskDefinitionArn:
        'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/aeostudio-staging-api:17',
      containerArn: `arn:aws:ecs:ap-southeast-1:123456789012:container/aeostudio-staging/${taskId}/${containerId}`,
      image: '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-api@' + digest,
      imageDigest: digest,
      imageId,
      capturedAt: '2026-07-23T12:00:00.000Z',
    });
    expect(fetch).toHaveBeenCalledWith(`${metadataUri}/task`, expect.any(Object));
  });

  test('is unavailable outside ECS and rejects a metadata URI that could be used for SSRF', async () => {
    await expect(
      resolveEcsRuntimeBuildIdentity({
        service: 'worker',
        environment: {},
      }),
    ).resolves.toBeNull();

    await expect(
      resolveEcsRuntimeBuildIdentity({
        service: 'worker',
        environment: { ECS_CONTAINER_METADATA_URI_V4: 'https://attacker.example/task' },
      }),
    ).rejects.toThrow('ECS_METADATA_URI_INVALID');
  });

  test('fails closed when the running container image is not digest-pinned', async () => {
    await expect(
      resolveEcsRuntimeBuildIdentity({
        service: 'api',
        environment: { ECS_CONTAINER_METADATA_URI_V4: metadataUri },
        fetch: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              TaskARN: `arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/${taskId}`,
              Family: 'aeostudio-staging-api',
              Revision: '17',
              Containers: [
                {
                  Name: 'api',
                  ContainerARN: `arn:aws:ecs:ap-southeast-1:123456789012:container/aeostudio-staging/${taskId}/${containerId}`,
                  Image: '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-api:latest',
                  ImageID: imageId,
                },
              ],
            }),
          ),
        ),
      }),
    ).rejects.toThrow('ECS_RUNTIME_IMAGE_NOT_DIGEST_PINNED');
  });

  test('fails closed when ECS ImageID differs from the digest-pinned Image URI', async () => {
    await expect(
      resolveEcsRuntimeBuildIdentity({
        service: 'web',
        environment: { ECS_CONTAINER_METADATA_URI_V4: metadataUri },
        fetch: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              TaskARN: `arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/${taskId}`,
              Family: 'aeostudio-staging-web',
              Revision: '17',
              Containers: [
                {
                  Name: 'web',
                  ContainerARN: `arn:aws:ecs:ap-southeast-1:123456789012:container/aeostudio-staging/${taskId}/${containerId}`,
                  Image:
                    '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-web@' + digest,
                  ImageID: `sha256:${'d'.repeat(64)}`,
                },
              ],
            }),
          ),
        ),
      }),
    ).rejects.toThrow('ECS_RUNTIME_IMAGE_DIGEST_MISMATCH');
  });
});
