import { describe, expect, test } from 'vitest';

// @ts-expect-error The runtime verifier is a native ESM JavaScript module.
import * as untypedVerifier from '../../scripts/smoke/verify-tenant-data-broker-runtime.mjs';

type AwsRunner = (region: string, args: string[]) => unknown;

const verifier = untypedVerifier as {
  verifyTenantDataBrokerRuntime(input: {
    accountId: string;
    contractEnvelope: Record<string, unknown>;
    environment: string;
    manifest: Record<string, unknown>;
    region: string;
    runAws: AwsRunner;
  }): {
    adotRuntimeDigest: string;
    tasks: Array<{
      adotRuntimeDigest: string;
      brokerRuntimeDigest: string;
      taskArn: string;
    }>;
  };
};

const accountId = '123456789012';
const environment = 'staging';
const region = 'ap-southeast-1';
const workerDigest = `sha256:${'c'.repeat(64)}`;
const adotDigest = `sha256:${'d'.repeat(64)}`;
const adotAmd64Digest = `sha256:${'e'.repeat(64)}`;
const workerImage = `${accountId}.dkr.ecr.${region}.amazonaws.com/aeostudio-worker`;
const adotImage = `${accountId}.dkr.ecr.${region}.amazonaws.com/aeostudio-adot`;
const workerReference = `${workerImage}@${workerDigest}`;
const adotReference = `${adotImage}@${adotDigest}`;
const cluster = `aeostudio-${environment}`;
const serviceName = `${cluster}-tenant-data-broker`;
const taskDefinitionArn = `arn:aws:ecs:${region}:${accountId}:task-definition/${serviceName}:17`;
const targetGroupArn =
  `arn:aws:elasticloadbalancing:${region}:${accountId}:targetgroup/` +
  `aeostudio-${environment}-broker/${'a'.repeat(16)}`;
const taskArns = ['2'.repeat(32), '1'.repeat(32)].map(
  (taskId) => `arn:aws:ecs:${region}:${accountId}:task/${cluster}/${taskId}`,
);

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 'aeostudio.release.v1',
    images: {
      adot: { image: adotImage, digest: adotDigest },
      worker: { image: workerImage, digest: workerDigest },
    },
  };
}

function contractEnvelope(): Record<string, unknown> {
  return {
    contract: {
      Environment: environment,
      Region: region,
      AccountId: accountId,
      ReleaseId: 'staging-991-1',
      Images: {
        Adot: adotReference,
        TenantDataBroker: workerReference,
        Worker: workerReference,
      },
      TaskDefinitions: {
        TenantDataBroker: taskDefinitionArn,
      },
    },
  };
}

function task(taskArn: string, runtimeAdotDigest = adotAmd64Digest): Record<string, unknown> {
  return {
    taskArn,
    taskDefinitionArn,
    lastStatus: 'RUNNING',
    desiredStatus: 'RUNNING',
    containers: [
      {
        name: 'tenant-data-broker',
        image: workerReference,
        imageDigest: workerDigest,
        lastStatus: 'RUNNING',
      },
      {
        name: 'adot',
        image: adotReference,
        imageDigest: runtimeAdotDigest,
        lastStatus: 'RUNNING',
      },
    ],
  };
}

function awsFixture(
  runtimeAdotDigests = [adotAmd64Digest, adotAmd64Digest],
  describedTaskArns = taskArns,
): {
  calls: string[][];
  runAws: AwsRunner;
} {
  const calls: string[][] = [];
  return {
    calls,
    runAws(_region, args) {
      calls.push(args);
      const operation = `${args[0] ?? ''}:${args[1] ?? ''}`;
      switch (operation) {
        case 'ecs:describe-services':
          return {
            failures: [],
            services: [
              {
                serviceName,
                taskDefinition: taskDefinitionArn,
                desiredCount: 2,
                runningCount: 2,
                pendingCount: 0,
                deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
                loadBalancers: [{ targetGroupArn }],
              },
            ],
          };
        case 'ecs:describe-task-definition':
          return {
            taskDefinition: {
              taskDefinitionArn,
              family: serviceName,
              runtimePlatform: {
                cpuArchitecture: 'X86_64',
                operatingSystemFamily: 'LINUX',
              },
              containerDefinitions: [
                { name: 'tenant-data-broker', image: workerReference },
                { name: 'adot', image: adotReference },
              ],
            },
          };
        case 'ecr:batch-get-image':
          return {
            failures: [],
            images: [
              {
                imageId: { imageDigest: adotDigest },
                imageManifest: JSON.stringify({
                  manifests: [
                    {
                      digest: adotAmd64Digest,
                      platform: { architecture: 'amd64', os: 'linux' },
                    },
                  ],
                }),
              },
            ],
          };
        case 'ecs:list-tasks':
          return { taskArns };
        case 'ecs:describe-tasks':
          return {
            failures: [],
            tasks: [
              task(describedTaskArns[0] ?? '', runtimeAdotDigests[0]),
              task(describedTaskArns[1] ?? '', runtimeAdotDigests[1]),
            ],
          };
        case 'elbv2:describe-target-health':
          return {
            TargetHealthDescriptions: [
              { TargetHealth: { State: 'healthy' } },
              { TargetHealth: { State: 'healthy' } },
            ],
          };
        default:
          throw new Error(`UNEXPECTED_AWS_CALL:${operation}`);
      }
    },
  };
}

describe('Task 18 Tenant Data Broker runtime verifier', () => {
  test('requests the ADOT index/list and emits sorted per-task runtime digests', () => {
    const fixture = awsFixture();
    const evidence = verifier.verifyTenantDataBrokerRuntime({
      accountId,
      contractEnvelope: contractEnvelope(),
      environment,
      manifest: manifest(),
      region,
      runAws: fixture.runAws,
    });

    const ecrCall = fixture.calls.find(
      (args) => args[0] === 'ecr' && args[1] === 'batch-get-image',
    );
    expect(ecrCall).toContain('--accepted-media-types');
    expect(ecrCall).toContain('application/vnd.oci.image.index.v1+json');
    expect(ecrCall).toContain('application/vnd.docker.distribution.manifest.list.v2+json');
    expect(evidence.adotRuntimeDigest).toBe(adotAmd64Digest);
    expect(evidence.tasks).toEqual(
      [...taskArns].sort().map((taskArn) => ({
        taskArn,
        brokerRuntimeDigest: workerDigest,
        adotRuntimeDigest: adotAmd64Digest,
      })),
    );
  });

  test('blocks a running task whose ADOT digest is not an amd64 child of the exact index', () => {
    const fixture = awsFixture([adotAmd64Digest, `sha256:${'f'.repeat(64)}`]);
    expect(() =>
      verifier.verifyTenantDataBrokerRuntime({
        accountId,
        contractEnvelope: contractEnvelope(),
        environment,
        manifest: manifest(),
        region,
        runAws: fixture.runAws,
      }),
    ).toThrow('BROKER_RUNTIME_IMAGE_MISMATCH');
  });

  test('blocks a same-size describe-tasks response that substitutes a listed task ARN', () => {
    const substitutedTaskArns = [
      taskArns[0] ?? '',
      `arn:aws:ecs:${region}:${accountId}:task/${cluster}/${'3'.repeat(32)}`,
    ];
    const fixture = awsFixture([adotAmd64Digest, adotAmd64Digest], substitutedTaskArns);
    expect(() =>
      verifier.verifyTenantDataBrokerRuntime({
        accountId,
        contractEnvelope: contractEnvelope(),
        environment,
        manifest: manifest(),
        region,
        runAws: fixture.runAws,
      }),
    ).toThrow('BROKER_RUNTIME_TASK_INVALID');
  });
});
