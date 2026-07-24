import { spawn } from 'node:child_process';
import process from 'node:process';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command.toUpperCase()}_EXIT_${String(code)}`)),
    );
  });
}

if (required('AEO_ROLLBACK_CONFIRM') !== 'staging') {
  throw new Error('AEO_ROLLBACK_CONFIRM_MUST_EQUAL_STAGING');
}
if (required('AWS_REGION') !== 'ap-southeast-1')
  throw new Error('ROLLBACK_REGION_MUST_BE_SINGAPORE');

const cluster = required('AEO_ECS_CLUSTER');
const services = JSON.parse(required('AEO_ROLLBACK_SERVICES_JSON'));
if (!Array.isArray(services) || services.length !== 4) {
  throw new Error('AEO_ROLLBACK_SERVICES_JSON_MUST_HAVE_WEB_API_WORKER_TENANT_DATA_BROKER');
}

const expectedServices = new Set([
  'aeostudio-staging-api',
  'aeostudio-staging-web',
  'aeostudio-staging-worker',
  'aeostudio-staging-tenant-data-broker',
]);
for (const item of services) {
  if (
    typeof item?.service !== 'string' ||
    typeof item?.previousTaskDefinition !== 'string' ||
    !expectedServices.delete(item.service) ||
    !new RegExp(
      `^arn:aws:ecs:ap-southeast-1:[0-9]{12}:task-definition/${item.service}:[1-9][0-9]*$`,
      'u',
    ).test(item.previousTaskDefinition)
  ) {
    throw new Error('ROLLBACK_SERVICE_ENTRY_INVALID');
  }
  await run('aws', [
    'ecs',
    'update-service',
    '--region',
    'ap-southeast-1',
    '--cluster',
    cluster,
    '--service',
    item.service,
    '--task-definition',
    item.previousTaskDefinition,
    '--force-new-deployment',
  ]);
}
if (expectedServices.size !== 0) throw new Error('ROLLBACK_SERVICE_SET_INVALID');
await run('aws', [
  'ecs',
  'wait',
  'services-stable',
  '--region',
  'ap-southeast-1',
  '--cluster',
  cluster,
  '--services',
  ...services.map((item) => item.service),
]);

process.stdout.write(
  `${JSON.stringify({ outcome: 'ROLLED_BACK', environment: 'staging', services: services.length })}\n`,
);
