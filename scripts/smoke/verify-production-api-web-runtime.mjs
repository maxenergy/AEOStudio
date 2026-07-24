/* global process */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const allowedOptions = new Set([
  'contract',
  'environment',
  'expected-account-id',
  'manifest',
  'origin',
  'output',
  'region',
]);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function fail(code) {
  throw new Error(code);
}

export function verifyProductionApiWebRuntime({
  accountId,
  contractEnvelope,
  manifest,
  origin,
  region,
  runAws,
}) {
  if (
    region !== 'ap-southeast-1' ||
    !/^[0-9]{12}$/u.test(accountId) ||
    typeof runAws !== 'function'
  ) {
    fail('PRODUCTION_RUNTIME_ARGUMENTS_INVALID');
  }
  const contract = contractEnvelope?.contract;
  const endpoint = exactRootHttpsOrigin(origin);
  const clusterName = 'aeostudio-production';
  const clusterArn = `arn:aws:ecs:${region}:${accountId}:cluster/${clusterName}`;
  const expectedAdotImage = `${accountId}.dkr.ecr.${region}.amazonaws.com/aeostudio-adot`;
  const adot = manifest?.images?.adot;
  const adotReference = `${expectedAdotImage}@${adot?.digest ?? ''}`;
  if (
    manifest?.schemaVersion !== 'aeostudio.release.v1' ||
    contract?.Environment !== 'production' ||
    contract?.Region !== region ||
    contract?.AccountId !== accountId ||
    adot?.image !== expectedAdotImage ||
    !digestPattern.test(adot?.digest) ||
    contract?.Images?.Adot !== adotReference
  ) {
    fail('PRODUCTION_RUNTIME_CONTRACT_INVALID');
  }

  const services = {};
  for (const service of ['api', 'web']) {
    services[service] = verifyService({
      accountId,
      clusterArn,
      clusterName,
      contract,
      manifest,
      region,
      runAws,
      service,
      adotReference,
    });
  }
  const routeBinding = verifyNetworkRoute({
    accountId,
    clusterArn,
    clusterName,
    endpoint,
    region,
    runAws,
    services,
  });
  return {
    schemaVersion: 'aeostudio.production-api-web-runtime.v1',
    environment: 'production',
    region,
    accountId,
    clusterName,
    clusterArn,
    releaseId: contract.ReleaseId,
    routeBinding,
    services,
  };
}

function verifyService(input) {
  const serviceTitle = input.service === 'api' ? 'Api' : 'Web';
  const serviceName = `${input.clusterName}-${input.service}`;
  const expectedImage = `${input.accountId}.dkr.ecr.${input.region}.amazonaws.com/aeostudio-${input.service}`;
  const manifestImage = input.manifest?.images?.[input.service];
  const imageReference = `${expectedImage}@${manifestImage?.digest ?? ''}`;
  const taskDefinitionArn = input.contract?.TaskDefinitions?.[serviceTitle];
  if (
    manifestImage?.image !== expectedImage ||
    !digestPattern.test(manifestImage?.digest) ||
    input.contract?.Images?.[serviceTitle] !== imageReference ||
    typeof taskDefinitionArn !== 'string' ||
    !new RegExp(
      `^arn:aws:ecs:${input.region}:${input.accountId}:task-definition/${serviceName}:[1-9][0-9]*$`,
      'u',
    ).test(taskDefinitionArn)
  ) {
    fail('PRODUCTION_RUNTIME_CONTRACT_INVALID');
  }

  const serviceResponse = input.runAws(input.region, [
    'ecs',
    'describe-services',
    '--cluster',
    input.clusterName,
    '--services',
    serviceName,
  ]);
  const service = serviceResponse?.services?.[0];
  if (
    !Array.isArray(serviceResponse?.failures) ||
    serviceResponse.failures.length !== 0 ||
    !Array.isArray(serviceResponse?.services) ||
    serviceResponse.services.length !== 1 ||
    service?.clusterArn !== input.clusterArn ||
    service?.serviceName !== serviceName ||
    service?.taskDefinition !== taskDefinitionArn ||
    service?.desiredCount !== 2 ||
    service?.runningCount !== 2 ||
    service?.pendingCount !== 0 ||
    !Array.isArray(service?.deployments) ||
    service.deployments.length !== 1 ||
    service.deployments[0]?.status !== 'PRIMARY' ||
    service.deployments[0]?.rolloutState !== 'COMPLETED'
  ) {
    fail('PRODUCTION_RUNTIME_SERVICE_UNHEALTHY');
  }

  const definitionResponse = input.runAws(input.region, [
    'ecs',
    'describe-task-definition',
    '--task-definition',
    taskDefinitionArn,
  ]);
  const definition = definitionResponse?.taskDefinition;
  const definitionContainers = exactContainerMap(
    definition?.containerDefinitions,
    input.service,
    'PRODUCTION_RUNTIME_TASK_DEFINITION_INVALID',
  );
  if (
    definition?.taskDefinitionArn !== taskDefinitionArn ||
    definition?.family !== serviceName ||
    definition?.runtimePlatform?.cpuArchitecture !== 'X86_64' ||
    definition?.runtimePlatform?.operatingSystemFamily !== 'LINUX' ||
    definitionContainers.get(input.service)?.image !== imageReference ||
    definitionContainers.get('adot')?.image !== input.adotReference
  ) {
    fail('PRODUCTION_RUNTIME_TASK_DEFINITION_INVALID');
  }

  const listResponse = input.runAws(input.region, [
    'ecs',
    'list-tasks',
    '--cluster',
    input.clusterName,
    '--service-name',
    serviceName,
    '--desired-status',
    'RUNNING',
  ]);
  const taskArns = listResponse?.taskArns;
  if (
    !Array.isArray(taskArns) ||
    taskArns.length !== service.desiredCount ||
    new Set(taskArns).size !== taskArns.length ||
    taskArns.some(
      (taskArn) =>
        typeof taskArn !== 'string' ||
        !new RegExp(
          `^arn:aws:ecs:${input.region}:${input.accountId}:task/${input.clusterName}/[0-9a-f]{32}$`,
          'u',
        ).test(taskArn),
    )
  ) {
    fail('PRODUCTION_RUNTIME_TASK_COUNT_INVALID');
  }
  const taskResponse = input.runAws(input.region, [
    'ecs',
    'describe-tasks',
    '--cluster',
    input.clusterName,
    '--tasks',
    ...taskArns,
  ]);
  if (
    !Array.isArray(taskResponse?.failures) ||
    taskResponse.failures.length !== 0 ||
    !Array.isArray(taskResponse?.tasks) ||
    taskResponse.tasks.length !== taskArns.length
  ) {
    fail('PRODUCTION_RUNTIME_TASK_INVALID');
  }
  const tasks = taskResponse.tasks
    .map((task) =>
      validateRuntimeTask(task, {
        clusterArn: input.clusterArn,
        imageDigest: manifestImage.digest,
        imageReference,
        service: input.service,
        taskDefinitionArn,
        adotReference: input.adotReference,
      }),
    )
    .sort((left, right) => left.taskArn.localeCompare(right.taskArn));
  if (
    new Set(tasks.map((task) => task.taskArn)).size !== taskArns.length ||
    tasks.map((task) => task.taskArn).join('\n') !== [...taskArns].sort().join('\n')
  ) {
    fail('PRODUCTION_RUNTIME_TASK_INVALID');
  }
  return {
    taskDefinitionArn,
    image: imageReference,
    imageDigest: manifestImage.digest,
    desiredCount: service.desiredCount,
    runningCount: service.runningCount,
    pendingCount: service.pendingCount,
    tasks,
  };
}

function validateRuntimeTask(task, expected) {
  if (
    task?.clusterArn !== expected.clusterArn ||
    task?.taskDefinitionArn !== expected.taskDefinitionArn ||
    task?.lastStatus !== 'RUNNING' ||
    task?.desiredStatus !== 'RUNNING' ||
    typeof task?.taskArn !== 'string'
  ) {
    fail('PRODUCTION_RUNTIME_TASK_INVALID');
  }
  const containers = exactContainerMap(
    task.containers,
    expected.service,
    'PRODUCTION_RUNTIME_TASK_INVALID',
  );
  const workload = containers.get(expected.service);
  const adot = containers.get('adot');
  if (
    workload?.image !== expected.imageReference ||
    workload?.imageDigest !== expected.imageDigest ||
    workload?.lastStatus !== 'RUNNING' ||
    adot?.image !== expected.adotReference ||
    !digestPattern.test(adot?.imageDigest) ||
    adot?.lastStatus !== 'RUNNING'
  ) {
    fail('PRODUCTION_RUNTIME_IMAGE_MISMATCH');
  }
  const privateIp = taskPrivateIp(task);
  return { taskArn: task.taskArn, imageDigest: workload.imageDigest, privateIp };
}

function verifyNetworkRoute(input) {
  const loadBalancers = input.runAws(input.region, [
    'elbv2',
    'describe-load-balancers',
    '--names',
    input.clusterName,
  ]);
  const loadBalancer = loadBalancers?.LoadBalancers?.[0];
  const expectedAlbArn =
    `arn:aws:elasticloadbalancing:${input.region}:${input.accountId}:` +
    `loadbalancer/app/${input.clusterName}/`;
  if (
    !Array.isArray(loadBalancers?.LoadBalancers) ||
    loadBalancers.LoadBalancers.length !== 1 ||
    typeof loadBalancer?.LoadBalancerArn !== 'string' ||
    !loadBalancer.LoadBalancerArn.startsWith(expectedAlbArn) ||
    loadBalancer?.LoadBalancerName !== input.clusterName ||
    loadBalancer?.Scheme !== 'internet-facing' ||
    loadBalancer?.Type !== 'application' ||
    loadBalancer?.IpAddressType !== 'ipv4' ||
    loadBalancer?.State?.Code !== 'active' ||
    typeof loadBalancer?.DNSName !== 'string' ||
    typeof loadBalancer?.CanonicalHostedZoneId !== 'string' ||
    !/^vpc-[0-9a-f]+$/u.test(loadBalancer?.VpcId ?? '')
  ) {
    fail('PRODUCTION_RUNTIME_LOAD_BALANCER_INVALID');
  }

  const zone = exactRoute53Alias({
    hostname: input.endpoint.hostname,
    loadBalancer,
    region: input.region,
    runAws: input.runAws,
  });

  const listenerResponse = input.runAws(input.region, [
    'elbv2',
    'describe-listeners',
    '--load-balancer-arn',
    loadBalancer.LoadBalancerArn,
  ]);
  const httpsListeners = Array.isArray(listenerResponse?.Listeners)
    ? listenerResponse.Listeners.filter(
        (listener) => listener?.Port === 443 && listener?.Protocol === 'HTTPS',
      )
    : [];
  if (httpsListeners.length !== 1) {
    fail('PRODUCTION_RUNTIME_HTTPS_LISTENER_INVALID');
  }
  const listener = httpsListeners[0];
  const targetGroupResponse = input.runAws(input.region, [
    'elbv2',
    'describe-target-groups',
    '--names',
    `${input.clusterName}-api`,
    `${input.clusterName}-web`,
  ]);
  const targetGroups = exactTargetGroups({
    input,
    loadBalancer,
    response: targetGroupResponse,
  });
  if (
    listener?.LoadBalancerArn !== loadBalancer.LoadBalancerArn ||
    typeof listener?.ListenerArn !== 'string' ||
    !listener.ListenerArn.includes(`:${input.accountId}:listener/app/${input.clusterName}/`) ||
    listener?.SslPolicy !== 'ELBSecurityPolicy-TLS13-1-2-2021-06' ||
    !exactForward(listener?.DefaultActions, targetGroups.web.arn)
  ) {
    fail('PRODUCTION_RUNTIME_HTTPS_LISTENER_INVALID');
  }
  const rulesResponse = input.runAws(input.region, [
    'elbv2',
    'describe-rules',
    '--listener-arn',
    listener.ListenerArn,
  ]);
  if (!Array.isArray(rulesResponse?.Rules)) {
    fail('PRODUCTION_RUNTIME_LISTENER_RULES_INVALID');
  }
  const apiRules = rulesResponse.Rules.filter(
    (rule) =>
      rule?.IsDefault === false &&
      rule?.Priority === '10' &&
      exactForward(rule?.Actions, targetGroups.api.arn) &&
      exactApiPathCondition(rule?.Conditions),
  );
  const defaultRules = rulesResponse.Rules.filter(
    (rule) =>
      rule?.IsDefault === true &&
      rule?.Priority === 'default' &&
      exactForward(rule?.Actions, targetGroups.web.arn),
  );
  const denyRules = rulesResponse.Rules.filter(
    (rule) =>
      rule?.IsDefault === false &&
      rule?.Priority === '1' &&
      exactInternalDenyAction(rule?.Actions) &&
      exactPathCondition(rule?.Conditions, ['/internal/*']),
  );
  if (
    rulesResponse.Rules.length !== 3 ||
    apiRules.length !== 1 ||
    defaultRules.length !== 1 ||
    denyRules.length !== 1
  ) {
    fail('PRODUCTION_RUNTIME_LISTENER_RULES_INVALID');
  }

  const routeServices = {};
  for (const service of ['api', 'web']) {
    const targetGroup = targetGroups[service];
    const targetHealth = input.runAws(input.region, [
      'elbv2',
      'describe-target-health',
      '--target-group-arn',
      targetGroup.arn,
    ]);
    const descriptions = targetHealth?.TargetHealthDescriptions;
    if (
      !Array.isArray(descriptions) ||
      descriptions.length !== 2 ||
      descriptions.some(
        (entry) =>
          entry?.TargetHealth?.State !== 'healthy' ||
          entry?.Target?.Port !== targetGroup.port ||
          !privateIpv4(entry?.Target?.Id),
      )
    ) {
      fail('PRODUCTION_RUNTIME_TARGET_HEALTH_INVALID');
    }
    const healthyTargetIps = descriptions
      .map((entry) => entry.Target.Id)
      .sort((left, right) => left.localeCompare(right));
    const taskIps = input.services[service].tasks
      .map((task) => task.privateIp)
      .sort((left, right) => left.localeCompare(right));
    if (
      new Set(healthyTargetIps).size !== 2 ||
      healthyTargetIps.join('\n') !== taskIps.join('\n')
    ) {
      fail('PRODUCTION_RUNTIME_TARGET_TASK_BINDING_MISMATCH');
    }
    routeServices[service] = {
      targetGroupArn: targetGroup.arn,
      targetPort: targetGroup.port,
      healthyTargetIps,
    };
  }
  return {
    origin: input.endpoint.origin,
    hostname: input.endpoint.hostname,
    hostedZoneId: zone.id,
    aliasDnsName: loadBalancer.DNSName,
    loadBalancerArn: loadBalancer.LoadBalancerArn,
    listenerArn: listener.ListenerArn,
    ipAddressType: loadBalancer.IpAddressType,
    routeRecordTypes: ['A'],
    vpcId: loadBalancer.VpcId,
    services: routeServices,
  };
}

function exactTargetGroups({ input, loadBalancer, response }) {
  if (!Array.isArray(response?.TargetGroups) || response.TargetGroups.length !== 2) {
    fail('PRODUCTION_RUNTIME_TARGET_GROUPS_INVALID');
  }
  const result = {};
  for (const service of ['api', 'web']) {
    const name = `${input.clusterName}-${service}`;
    const matches = response.TargetGroups.filter(
      (candidate) => candidate?.TargetGroupName === name,
    );
    const target = matches[0];
    const port = service === 'api' ? 3200 : 3100;
    if (
      matches.length !== 1 ||
      typeof target?.TargetGroupArn !== 'string' ||
      !target.TargetGroupArn.startsWith(
        `arn:aws:elasticloadbalancing:${input.region}:${input.accountId}:targetgroup/${name}/`,
      ) ||
      target?.Protocol !== 'HTTP' ||
      target?.Port !== port ||
      target?.TargetType !== 'ip' ||
      target?.VpcId !== loadBalancer.VpcId ||
      !Array.isArray(target?.LoadBalancerArns) ||
      target.LoadBalancerArns.length !== 1 ||
      target.LoadBalancerArns[0] !== loadBalancer.LoadBalancerArn
    ) {
      fail('PRODUCTION_RUNTIME_TARGET_GROUPS_INVALID');
    }
    result[service] = { arn: target.TargetGroupArn, port };
  }
  return result;
}

function exactRoute53Alias({ hostname, loadBalancer, region, runAws }) {
  const response = runAws(region, ['route53', 'list-hosted-zones']);
  if (!Array.isArray(response?.HostedZones) || response?.IsTruncated === true) {
    fail('PRODUCTION_RUNTIME_HOSTED_ZONE_INVALID');
  }
  const candidates = response.HostedZones.flatMap((candidate) => {
    const name = typeof candidate?.Name === 'string' ? candidate.Name.replace(/\.$/u, '') : '';
    if (
      candidate?.Config?.PrivateZone !== false ||
      (hostname !== name && !hostname.endsWith(`.${name}`))
    ) {
      return [];
    }
    const id = String(candidate?.Id ?? '').replace(/^\/hostedzone\//u, '');
    if (!/^[A-Z0-9]+$/u.test(id)) {
      fail('PRODUCTION_RUNTIME_HOSTED_ZONE_INVALID');
    }
    return [{ id, name }];
  });
  if (candidates.length === 0) {
    fail('PRODUCTION_RUNTIME_HOSTED_ZONE_INVALID');
  }
  const longestLength = Math.max(...candidates.map((candidate) => candidate.name.length));
  const longest = candidates.filter((candidate) => candidate.name.length === longestLength);
  if (longest.length !== 1) {
    fail('PRODUCTION_RUNTIME_ROUTE53_ALIAS_INVALID');
  }
  const candidate = longest[0];
  const recordSets = runAws(region, [
    'route53',
    'list-resource-record-sets',
    '--hosted-zone-id',
    candidate.id,
    '--start-record-name',
    hostname,
    '--start-record-type',
    'A',
  ]);
  if (!Array.isArray(recordSets?.ResourceRecordSets) || recordSets?.IsTruncated === true) {
    fail('PRODUCTION_RUNTIME_ROUTE53_ALIAS_INVALID');
  }
  const exactNameRecords = recordSets.ResourceRecordSets.filter(
    (record) => record?.Name === `${hostname}.`,
  );
  const record = exactNameRecords[0];
  if (
    exactNameRecords.length !== 1 ||
    record?.Type !== 'A' ||
    record?.SetIdentifier !== undefined ||
    record?.Weight !== undefined ||
    record?.Region !== undefined ||
    record?.GeoLocation !== undefined ||
    record?.GeoProximityLocation !== undefined ||
    record?.Failover !== undefined ||
    record?.CidrRoutingConfig !== undefined ||
    record?.TrafficPolicyInstanceId !== undefined ||
    record?.HealthCheckId !== undefined ||
    (record?.MultiValueAnswer !== undefined && record.MultiValueAnswer !== false) ||
    record?.AliasTarget?.DNSName !== `${loadBalancer.DNSName}.` ||
    record?.AliasTarget?.HostedZoneId !== loadBalancer.CanonicalHostedZoneId ||
    record?.AliasTarget?.EvaluateTargetHealth !== true
  ) {
    fail('PRODUCTION_RUNTIME_ROUTE53_ALIAS_INVALID');
  }
  return { id: candidate.id };
}

function exactForward(actions, targetGroupArn) {
  return (
    Array.isArray(actions) &&
    actions.length === 1 &&
    actions[0]?.Type === 'forward' &&
    actions[0]?.TargetGroupArn === targetGroupArn
  );
}

function exactApiPathCondition(conditions) {
  return exactPathCondition(conditions, ['/api/*', '/health', '/ready']);
}

function exactPathCondition(conditions, expectedValues) {
  if (!Array.isArray(conditions) || conditions.length !== 1) return false;
  const condition = conditions[0];
  const values = condition?.PathPatternConfig?.Values;
  return (
    condition?.Field === 'path-pattern' &&
    Array.isArray(values) &&
    values.length === expectedValues.length &&
    [...values].sort().join('\n') === [...expectedValues].sort().join('\n')
  );
}

function exactInternalDenyAction(actions) {
  if (!Array.isArray(actions) || actions.length !== 1) return false;
  const action = actions[0];
  return (
    action?.Type === 'fixed-response' &&
    action?.FixedResponseConfig?.ContentType === 'application/json' &&
    action?.FixedResponseConfig?.MessageBody === '{"error":"NOT_FOUND"}' &&
    action?.FixedResponseConfig?.StatusCode === '404'
  );
}

function taskPrivateIp(task) {
  const eni = Array.isArray(task?.attachments)
    ? task.attachments.filter(
        (attachment) =>
          attachment?.type === 'ElasticNetworkInterface' && attachment?.status === 'ATTACHED',
      )
    : [];
  const addresses =
    eni.length === 1 && Array.isArray(eni[0]?.details)
      ? eni[0].details.filter((detail) => detail?.name === 'privateIPv4Address')
      : [];
  const address = addresses[0]?.value;
  if (addresses.length !== 1 || !privateIpv4(address)) {
    fail('PRODUCTION_RUNTIME_TASK_NETWORK_INVALID');
  }
  return address;
}

function privateIpv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const octets = value.split('.').map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function exactRootHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.endsWith('/')) {
    fail('PRODUCTION_RUNTIME_ORIGIN_INVALID');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('PRODUCTION_RUNTIME_ORIGIN_INVALID');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.pathname !== '/' ||
    parsed.port !== '' ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      parsed.hostname,
    ) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail('PRODUCTION_RUNTIME_ORIGIN_INVALID');
  }
  return { origin: value, hostname: parsed.hostname };
}

function exactContainerMap(containers, service, code) {
  if (!Array.isArray(containers) || containers.length !== 2) fail(code);
  const map = new Map(
    containers.map((container) => [
      typeof container?.name === 'string' ? container.name : '',
      container,
    ]),
  );
  if (map.size !== 2 || !map.has(service) || !map.has('adot')) fail(code);
  return map;
}

function parseOptions(argv) {
  const options = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith('--') ||
      value.startsWith('--')
    ) {
      fail('PRODUCTION_RUNTIME_ARGUMENTS_INVALID');
    }
    const name = flag.slice(2);
    if (!allowedOptions.has(name) || options.has(name)) {
      fail('PRODUCTION_RUNTIME_ARGUMENTS_INVALID');
    }
    options.set(name, value);
  }
  if (options.size !== allowedOptions.size) {
    fail('PRODUCTION_RUNTIME_ARGUMENTS_INVALID');
  }
  return options;
}

function option(options, name) {
  const value = options.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    fail('PRODUCTION_RUNTIME_ARGUMENTS_INVALID');
  }
  return value;
}

function jsonFile(path, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(code);
  }
}

function awsJson(region, args) {
  const result = spawnSync(
    'aws',
    ['--region', region, '--no-cli-pager', ...args, '--output', 'json'],
    {
      encoding: 'utf8',
      env: { ...process.env, AWS_PAGER: '' },
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    fail(`PRODUCTION_RUNTIME_AWS_FAILED:${args[0] ?? 'unknown'}:${args[1] ?? 'unknown'}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('PRODUCTION_RUNTIME_AWS_RESPONSE_INVALID');
  }
}

function main() {
  const options = parseOptions(process.argv);
  if (option(options, 'environment') !== 'production') {
    fail('PRODUCTION_RUNTIME_ARGUMENTS_INVALID');
  }
  const evidence = verifyProductionApiWebRuntime({
    accountId: option(options, 'expected-account-id'),
    contractEnvelope: jsonFile(option(options, 'contract'), 'PRODUCTION_RUNTIME_CONTRACT_INVALID'),
    manifest: jsonFile(option(options, 'manifest'), 'PRODUCTION_RUNTIME_MANIFEST_INVALID'),
    origin: option(options, 'origin'),
    region: option(options, 'region'),
    runAws: awsJson,
  });
  const output = resolve(option(options, 'output'));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write('PRODUCTION_API_WEB_RUNTIME_VERIFIED\n');
}

const entrypoint =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entrypoint) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'PRODUCTION_RUNTIME_VERIFICATION_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
