import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedVerifier from '../../scripts/smoke/verify-production-api-web-runtime.mjs';

type AwsRunner = (region: string, args: string[]) => unknown;

const verifier = untypedVerifier as {
  verifyProductionApiWebRuntime(input: {
    accountId: string;
    contractEnvelope: Record<string, unknown>;
    manifest: Record<string, unknown>;
    origin: string;
    region: string;
    runAws: AwsRunner;
  }): {
    accountId: string;
    clusterArn: string;
    clusterName: string;
    environment: string;
    region: string;
    schemaVersion: string;
    services: Record<
      'api' | 'web',
      {
        desiredCount: number;
        image: string;
        imageDigest: string;
        runningCount: number;
        taskDefinitionArn: string;
        tasks: { imageDigest: string; taskArn: string }[];
      }
    >;
  };
};

const accountId = '123456789012';
const region = 'ap-southeast-1';
const environment = 'production';
const clusterName = `aeostudio-${environment}`;
const clusterArn = `arn:aws:ecs:${region}:${accountId}:cluster/${clusterName}`;
const origin = 'https://app.example.com';
const hostname = 'app.example.com';
const vpcId = 'vpc-0123456789abcdef0';
const albArn =
  `arn:aws:elasticloadbalancing:${region}:${accountId}:loadbalancer/app/` +
  `${clusterName}/${'a'.repeat(16)}`;
const albDnsName = `${clusterName}-${'1'.repeat(10)}.${region}.elb.amazonaws.com`;
const albZoneId = 'Z35SXDOTRQ7X7K';
const listenerArn =
  `arn:aws:elasticloadbalancing:${region}:${accountId}:listener/app/` +
  `${clusterName}/${'a'.repeat(16)}/${'b'.repeat(16)}`;
const adotDigest = `sha256:${'a'.repeat(64)}`;
const digests = {
  api: `sha256:${'b'.repeat(64)}`,
  web: `sha256:${'c'.repeat(64)}`,
};
const images = {
  adot: `${accountId}.dkr.ecr.${region}.amazonaws.com/aeostudio-adot`,
  api: `${accountId}.dkr.ecr.${region}.amazonaws.com/aeostudio-api`,
  web: `${accountId}.dkr.ecr.${region}.amazonaws.com/aeostudio-web`,
};
const taskDefinitions = {
  api: `arn:aws:ecs:${region}:${accountId}:task-definition/${clusterName}-api:17`,
  web: `arn:aws:ecs:${region}:${accountId}:task-definition/${clusterName}-web:19`,
};
const targetGroups = {
  api:
    `arn:aws:elasticloadbalancing:${region}:${accountId}:targetgroup/` +
    `${clusterName}-api/${'c'.repeat(16)}`,
  web:
    `arn:aws:elasticloadbalancing:${region}:${accountId}:targetgroup/` +
    `${clusterName}-web/${'d'.repeat(16)}`,
};
const taskIps = {
  api: ['10.0.1.11', '10.0.1.12'],
  web: ['10.0.2.11', '10.0.2.12'],
};

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 'aeostudio.release.v1',
    images: {
      adot: { image: images.adot, digest: adotDigest },
      api: { image: images.api, digest: digests.api },
      web: { image: images.web, digest: digests.web },
    },
  };
}

function contractEnvelope(): Record<string, unknown> {
  return {
    contract: {
      Environment: environment,
      Region: region,
      AccountId: accountId,
      ReleaseId: 'production-991-1',
      Images: {
        Adot: `${images.adot}@${adotDigest}`,
        Api: `${images.api}@${digests.api}`,
        Web: `${images.web}@${digests.web}`,
      },
      TaskDefinitions: {
        Api: taskDefinitions.api,
        Web: taskDefinitions.web,
      },
    },
  };
}

function taskArns(service: 'api' | 'web'): string[] {
  const prefix = service === 'api' ? '1' : '2';
  return ['1', '2'].map(
    (suffix) =>
      `arn:aws:ecs:${region}:${accountId}:task/${clusterName}/${prefix.repeat(31)}${suffix}`,
  );
}

function awsFixture(): { calls: string[][]; runAws: AwsRunner } {
  const calls: string[][] = [];
  return {
    calls,
    runAws(_region, args) {
      calls.push(args);
      const operation = `${args[0] ?? ''}:${args[1] ?? ''}`;
      const service =
        args.includes(`${clusterName}-api`) ||
        args.includes(taskDefinitions.api) ||
        args.includes(targetGroups.api) ||
        args.some((value) => taskArns('api').includes(value))
          ? 'api'
          : 'web';
      const serviceName = `${clusterName}-${service}`;
      const imageReference = `${images[service]}@${digests[service]}`;
      switch (operation) {
        case 'ecs:describe-services':
          return {
            failures: [],
            services: [
              {
                clusterArn,
                serviceName,
                taskDefinition: taskDefinitions[service],
                desiredCount: 2,
                runningCount: 2,
                pendingCount: 0,
                deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
              },
            ],
          };
        case 'ecs:describe-task-definition':
          return {
            taskDefinition: {
              taskDefinitionArn: taskDefinitions[service],
              family: serviceName,
              runtimePlatform: {
                cpuArchitecture: 'X86_64',
                operatingSystemFamily: 'LINUX',
              },
              containerDefinitions: [
                { name: service, image: imageReference },
                { name: 'adot', image: `${images.adot}@${adotDigest}` },
              ],
            },
          };
        case 'ecs:list-tasks':
          return { taskArns: taskArns(service) };
        case 'ecs:describe-tasks':
          return {
            failures: [],
            tasks: taskArns(service).map((taskArn, index) => ({
              clusterArn,
              taskArn,
              taskDefinitionArn: taskDefinitions[service],
              lastStatus: 'RUNNING',
              desiredStatus: 'RUNNING',
              containers: [
                {
                  name: service,
                  image: imageReference,
                  imageDigest: digests[service],
                  lastStatus: 'RUNNING',
                },
                {
                  name: 'adot',
                  image: `${images.adot}@${adotDigest}`,
                  imageDigest: `sha256:${'d'.repeat(64)}`,
                  lastStatus: 'RUNNING',
                },
              ],
              attachments: [
                {
                  type: 'ElasticNetworkInterface',
                  status: 'ATTACHED',
                  details: [
                    {
                      name: 'privateIPv4Address',
                      value: taskIps[service][index],
                    },
                  ],
                },
              ],
            })),
          };
        case 'elbv2:describe-load-balancers':
          return {
            LoadBalancers: [
              {
                LoadBalancerArn: albArn,
                DNSName: albDnsName,
                CanonicalHostedZoneId: albZoneId,
                LoadBalancerName: clusterName,
                Scheme: 'internet-facing',
                Type: 'application',
                IpAddressType: 'ipv4',
                State: { Code: 'active' },
                VpcId: vpcId,
              },
            ],
          };
        case 'route53:list-hosted-zones':
          return {
            IsTruncated: false,
            HostedZones: [
              {
                Id: '/hostedzone/ZPRIVATE123',
                Name: 'example.com.',
                Config: { PrivateZone: true },
              },
              {
                Id: '/hostedzone/Z0123456789ABC',
                Name: 'example.com.',
                Config: { PrivateZone: false },
              },
            ],
          };
        case 'route53:list-resource-record-sets':
          return {
            IsTruncated: false,
            ResourceRecordSets: [
              {
                Name: `${hostname}.`,
                Type: 'A',
                AliasTarget: {
                  DNSName: `${albDnsName}.`,
                  HostedZoneId: albZoneId,
                  EvaluateTargetHealth: true,
                },
              },
            ],
          };
        case 'elbv2:describe-listeners':
          return {
            Listeners: [
              {
                ListenerArn: listenerArn,
                LoadBalancerArn: albArn,
                Port: 443,
                Protocol: 'HTTPS',
                SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
                DefaultActions: [
                  {
                    Type: 'forward',
                    TargetGroupArn: targetGroups.web,
                  },
                ],
              },
            ],
          };
        case 'elbv2:describe-rules':
          return {
            Rules: [
              {
                RuleArn: `${listenerArn}/${'f'.repeat(16)}`,
                Priority: '1',
                IsDefault: false,
                Actions: [
                  {
                    Type: 'fixed-response',
                    FixedResponseConfig: {
                      ContentType: 'application/json',
                      MessageBody: '{"error":"NOT_FOUND"}',
                      StatusCode: '404',
                    },
                  },
                ],
                Conditions: [
                  {
                    Field: 'path-pattern',
                    PathPatternConfig: { Values: ['/internal/*'] },
                  },
                ],
              },
              {
                RuleArn: `${listenerArn}/default`,
                Priority: 'default',
                IsDefault: true,
                Actions: [{ Type: 'forward', TargetGroupArn: targetGroups.web }],
                Conditions: [],
              },
              {
                RuleArn: `${listenerArn}/${'e'.repeat(16)}`,
                Priority: '10',
                IsDefault: false,
                Actions: [{ Type: 'forward', TargetGroupArn: targetGroups.api }],
                Conditions: [
                  {
                    Field: 'path-pattern',
                    PathPatternConfig: {
                      Values: ['/api/*', '/health', '/ready'],
                    },
                  },
                ],
              },
            ],
          };
        case 'elbv2:describe-target-groups':
          return {
            TargetGroups: (['api', 'web'] as const).map((targetService) => ({
              TargetGroupArn: targetGroups[targetService],
              TargetGroupName: `${clusterName}-${targetService}`,
              Protocol: 'HTTP',
              Port: targetService === 'api' ? 3200 : 3100,
              TargetType: 'ip',
              VpcId: vpcId,
              LoadBalancerArns: [albArn],
            })),
          };
        case 'elbv2:describe-target-health':
          return {
            TargetHealthDescriptions: taskIps[service].map((ip) => ({
              Target: { Id: ip, Port: service === 'api' ? 3200 : 3100 },
              TargetHealth: { State: 'healthy' },
            })),
          };
        default:
          throw new Error(`UNEXPECTED_AWS_CALL:${operation}`);
      }
    },
  };
}

describe('Task 18 production API and Web runtime identity', () => {
  test('probes both ECS services and binds every running task to the exact release', () => {
    const fixture = awsFixture();
    const result = verifier.verifyProductionApiWebRuntime({
      accountId,
      contractEnvelope: contractEnvelope(),
      manifest: manifest(),
      origin,
      region,
      runAws: fixture.runAws,
    });

    expect(result).toMatchObject({
      schemaVersion: 'aeostudio.production-api-web-runtime.v1',
      environment,
      region,
      accountId,
      clusterName,
      clusterArn,
      routeBinding: {
        origin,
        hostname,
        hostedZoneId: 'Z0123456789ABC',
        aliasDnsName: albDnsName,
        loadBalancerArn: albArn,
        listenerArn,
        ipAddressType: 'ipv4',
        routeRecordTypes: ['A'],
        vpcId,
        services: {
          api: {
            targetGroupArn: targetGroups.api,
            targetPort: 3200,
            healthyTargetIps: taskIps.api,
          },
          web: {
            targetGroupArn: targetGroups.web,
            targetPort: 3100,
            healthyTargetIps: taskIps.web,
          },
        },
      },
      services: {
        api: {
          taskDefinitionArn: taskDefinitions.api,
          image: `${images.api}@${digests.api}`,
          imageDigest: digests.api,
          desiredCount: 2,
          runningCount: 2,
        },
        web: {
          taskDefinitionArn: taskDefinitions.web,
          image: `${images.web}@${digests.web}`,
          imageDigest: digests.web,
          desiredCount: 2,
          runningCount: 2,
        },
      },
    });
    expect(result.services.api.tasks).toEqual(
      taskArns('api').map((taskArn, index) => ({
        taskArn,
        imageDigest: digests.api,
        privateIp: taskIps.api[index],
      })),
    );
    expect(result.services.web.tasks).toEqual(
      taskArns('web').map((taskArn, index) => ({
        taskArn,
        imageDigest: digests.web,
        privateIp: taskIps.web[index],
      })),
    );
    expect(
      fixture.calls.filter((args) => args[0] === 'ecs' && args[1] === 'describe-services'),
    ).toHaveLength(2);
    expect(
      fixture.calls
        .filter((args) => args[0] === 'route53' && args[1] === 'list-hosted-zones')
        .map((args) => args.join(':')),
    ).toEqual(['route53:list-hosted-zones']);
  });

  test('fails closed on cluster, task definition, or runtime digest drift', () => {
    const wrongCluster = awsFixture();
    expect(() =>
      verifier.verifyProductionApiWebRuntime({
        accountId,
        contractEnvelope: contractEnvelope(),
        manifest: manifest(),
        origin,
        region,
        runAws(runtimeRegion, args) {
          const response = wrongCluster.runAws(runtimeRegion, args) as Record<string, unknown>;
          if (args[0] === 'ecs' && args[1] === 'describe-services') {
            (response.services as Record<string, unknown>[])[0]!.clusterArn =
              `arn:aws:ecs:${region}:${accountId}:cluster/other`;
          }
          return response;
        },
      }),
    ).toThrow('PRODUCTION_RUNTIME_SERVICE_UNHEALTHY');

    const wrongDigest = awsFixture();
    expect(() =>
      verifier.verifyProductionApiWebRuntime({
        accountId,
        contractEnvelope: contractEnvelope(),
        manifest: manifest(),
        origin,
        region,
        runAws(runtimeRegion, args) {
          const response = wrongDigest.runAws(runtimeRegion, args) as Record<string, unknown>;
          if (
            args[0] === 'ecs' &&
            args[1] === 'describe-tasks' &&
            args.some((value) => taskArns('web').includes(value))
          ) {
            const tasks = response.tasks as Record<string, unknown>[];
            (tasks[0]!.containers as Record<string, unknown>[])[0]!.imageDigest =
              `sha256:${'e'.repeat(64)}`;
          }
          return response;
        },
      }),
    ).toThrow('PRODUCTION_RUNTIME_IMAGE_MISMATCH');

    const wrongDefinition = contractEnvelope();
    (
      (wrongDefinition.contract as Record<string, unknown>).TaskDefinitions as Record<
        string,
        unknown
      >
    ).Api = `arn:aws:ecs:${region}:999999999999:task-definition/${clusterName}-api:17`;
    expect(() =>
      verifier.verifyProductionApiWebRuntime({
        accountId,
        contractEnvelope: wrongDefinition,
        manifest: manifest(),
        origin,
        region,
        runAws: awsFixture().runAws,
      }),
    ).toThrow('PRODUCTION_RUNTIME_CONTRACT_INVALID');
  });

  test('rejects a healthy URL routed to another ALB or another task IP set', () => {
    const wrongAlias = awsFixture();
    expect(() =>
      verifier.verifyProductionApiWebRuntime({
        accountId,
        contractEnvelope: contractEnvelope(),
        manifest: manifest(),
        origin,
        region,
        runAws(runtimeRegion, args) {
          const response = wrongAlias.runAws(runtimeRegion, args) as Record<string, unknown>;
          if (args[0] === 'route53' && args[1] === 'list-resource-record-sets') {
            const record = (response.ResourceRecordSets as Record<string, unknown>[])[0]!;
            (record.AliasTarget as Record<string, unknown>).DNSName =
              'other-alb.ap-southeast-1.elb.amazonaws.com.';
          }
          return response;
        },
      }),
    ).toThrow('PRODUCTION_RUNTIME_ROUTE53_ALIAS_INVALID');

    const weightedAlternate = awsFixture();
    expect(() =>
      verifier.verifyProductionApiWebRuntime({
        accountId,
        contractEnvelope: contractEnvelope(),
        manifest: manifest(),
        origin,
        region,
        runAws(runtimeRegion, args) {
          const response = weightedAlternate.runAws(runtimeRegion, args) as Record<string, unknown>;
          if (args[0] === 'route53' && args[1] === 'list-resource-record-sets') {
            (response.ResourceRecordSets as Record<string, unknown>[]).push({
              Name: `${hostname}.`,
              Type: 'A',
              SetIdentifier: 'alternate',
              Weight: 1,
              AliasTarget: {
                DNSName: 'other-alb.ap-southeast-1.elb.amazonaws.com.',
                HostedZoneId: albZoneId,
                EvaluateTargetHealth: true,
              },
            });
          }
          return response;
        },
      }),
    ).toThrow('PRODUCTION_RUNTIME_ROUTE53_ALIAS_INVALID');

    const substitutedTarget = awsFixture();
    expect(() =>
      verifier.verifyProductionApiWebRuntime({
        accountId,
        contractEnvelope: contractEnvelope(),
        manifest: manifest(),
        origin,
        region,
        runAws(runtimeRegion, args) {
          const response = substitutedTarget.runAws(runtimeRegion, args) as Record<string, unknown>;
          if (
            args[0] === 'elbv2' &&
            args[1] === 'describe-target-health' &&
            args.includes(targetGroups.api)
          ) {
            const descriptions = response.TargetHealthDescriptions as Record<string, unknown>[];
            (descriptions[0]!.Target as Record<string, unknown>).Id = '10.0.9.99';
          }
          return response;
        },
      }),
    ).toThrow('PRODUCTION_RUNTIME_TARGET_TASK_BINDING_MISMATCH');

    const shadowRule = awsFixture();
    expect(() =>
      verifier.verifyProductionApiWebRuntime({
        accountId,
        contractEnvelope: contractEnvelope(),
        manifest: manifest(),
        origin,
        region,
        runAws(runtimeRegion, args) {
          const response = shadowRule.runAws(runtimeRegion, args) as Record<string, unknown>;
          if (args[0] === 'elbv2' && args[1] === 'describe-rules') {
            (response.Rules as Record<string, unknown>[]).push({
              RuleArn: `${listenerArn}/${'9'.repeat(16)}`,
              Priority: '5',
              IsDefault: false,
              Actions: [{ Type: 'forward', TargetGroupArn: targetGroups.web }],
              Conditions: [
                {
                  Field: 'path-pattern',
                  PathPatternConfig: { Values: ['/*'] },
                },
              ],
            });
          }
          return response;
        },
      }),
    ).toThrow('PRODUCTION_RUNTIME_LISTENER_RULES_INVALID');

    const noCalls = awsFixture();
    expect(() =>
      verifier.verifyProductionApiWebRuntime({
        accountId,
        contractEnvelope: contractEnvelope(),
        manifest: manifest(),
        origin: 'https://app.example.com:8443',
        region,
        runAws: noCalls.runAws,
      }),
    ).toThrow('PRODUCTION_RUNTIME_ORIGIN_INVALID');
    expect(noCalls.calls).toHaveLength(0);

    const duplicatePublicZone = awsFixture();
    expect(() =>
      verifier.verifyProductionApiWebRuntime({
        accountId,
        contractEnvelope: contractEnvelope(),
        manifest: manifest(),
        origin,
        region,
        runAws(runtimeRegion, args) {
          const response = duplicatePublicZone.runAws(runtimeRegion, args) as Record<
            string,
            unknown
          >;
          if (args[0] === 'route53' && args[1] === 'list-hosted-zones') {
            (response.HostedZones as Record<string, unknown>[]).push({
              Id: '/hostedzone/ZDUPLICATE123',
              Name: 'example.com.',
              Config: { PrivateZone: false },
            });
          }
          return response;
        },
      }),
    ).toThrow('PRODUCTION_RUNTIME_ROUTE53_ALIAS_INVALID');

    for (const extraRecord of [
      {
        Name: `${hostname}.`,
        Type: 'AAAA',
        AliasTarget: {
          DNSName: 'other-alb.ap-southeast-1.elb.amazonaws.com.',
          HostedZoneId: albZoneId,
          EvaluateTargetHealth: true,
        },
      },
      {
        Name: `${hostname}.`,
        Type: 'CNAME',
        TTL: 60,
        ResourceRecords: [{ Value: 'other.example.com.' }],
      },
    ]) {
      const splitRoute = awsFixture();
      expect(() =>
        verifier.verifyProductionApiWebRuntime({
          accountId,
          contractEnvelope: contractEnvelope(),
          manifest: manifest(),
          origin,
          region,
          runAws(runtimeRegion, args) {
            const response = splitRoute.runAws(runtimeRegion, args) as Record<string, unknown>;
            if (args[0] === 'route53' && args[1] === 'list-resource-record-sets') {
              (response.ResourceRecordSets as Record<string, unknown>[]).push(extraRecord);
            }
            return response;
          },
        }),
      ).toThrow('PRODUCTION_RUNTIME_ROUTE53_ALIAS_INVALID');
    }

    const dualStackAlb = awsFixture();
    expect(() =>
      verifier.verifyProductionApiWebRuntime({
        accountId,
        contractEnvelope: contractEnvelope(),
        manifest: manifest(),
        origin,
        region,
        runAws(runtimeRegion, args) {
          const response = dualStackAlb.runAws(runtimeRegion, args) as Record<string, unknown>;
          if (args[0] === 'elbv2' && args[1] === 'describe-load-balancers') {
            (response.LoadBalancers as Record<string, unknown>[])[0]!.IpAddressType = 'dualstack';
          }
          return response;
        },
      }),
    ).toThrow('PRODUCTION_RUNTIME_LOAD_BALANCER_INVALID');
  });

  test('grants the production deploy role only the reads required by the exact route proof', async () => {
    const iam = await readFile(
      join(process.cwd(), 'infra', 'modules', 'platform', 'iam.tf'),
      'utf8',
    );
    expect(iam).toMatch(
      /for_each\s*=\s*var\.environment == "production"[\s\S]*?ReadExactApiAndWebServices[\s\S]*?ecs:DescribeServices[\s\S]*?aws_ecs_service\.api\.id[\s\S]*?aws_ecs_service\.web\.id/u,
    );
    expect(iam).toMatch(
      /ReadExactApiAndWebTargetHealth[\s\S]*?elasticloadbalancing:DescribeTargetHealth[\s\S]*?aws_lb_target_group\.api\.arn[\s\S]*?aws_lb_target_group\.web\.arn/u,
    );
    expect(iam).toMatch(
      /DiscoverProductionPublicRoute[\s\S]*?elasticloadbalancing:DescribeLoadBalancers[\s\S]*?elasticloadbalancing:DescribeListeners[\s\S]*?elasticloadbalancing:DescribeRules[\s\S]*?elasticloadbalancing:DescribeTargetGroups[\s\S]*?resources\s*=\s*\["\*"\][\s\S]*?aws:RequestedRegion[\s\S]*?values\s*=\s*\[var\.region\]/u,
    );
    expect(iam).toMatch(
      /DiscoverProductionHostedZones[\s\S]*?route53:ListHostedZones[\s\S]*?resources\s*=\s*\["\*"\]/u,
    );
    expect(iam).toMatch(
      /ReadExactProductionRoute53Records[\s\S]*?route53:ListResourceRecordSets[\s\S]*?arn:aws:route53:::hostedzone\/\$\{var\.route53_zone_id\}/u,
    );
    expect(iam).not.toMatch(/ReadExactProductionRoute53Records[\s\S]*?resources\s*=\s*\["\*"\]/u);
  });

  test('pins the public ALB to the IPv4 route proved by production smoke', async () => {
    const compute = await readFile(
      join(process.cwd(), 'infra', 'modules', 'platform', 'compute.tf'),
      'utf8',
    );
    expect(compute).toMatch(/resource "aws_lb" "main" \{[\s\S]*?ip_address_type\s*=\s*"ipv4"/u);
  });
});
