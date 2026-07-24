import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const WORKER_POOL_BUDGET = {
  WORKLOAD_DATABASE_POOL_MAX: 29,
  MEASUREMENT_DATABASE_POOL_MAX: 3,
  OUTBOX_DATABASE_POOL_MAX: 2,
  PRIVACY_DATABASE_POOL_MAX: 2,
  RUNTIME_ISSUER_DATABASE_POOL_MAX: 2,
  LIFECYCLE_ISSUER_DATABASE_POOL_MAX: 2,
} as const;

describe('Task 18 production Worker capacity', () => {
  test('parses the exact Worker task, service and release registration blocks', async () => {
    const compute = await source('infra/modules/platform/compute.tf');
    const release = await source('infra/modules/platform/release-control.tf');
    const workerTask = hclBlock(compute, 'resource "aws_ecs_task_definition" "worker"');
    const workerService = hclBlock(compute, 'resource "aws_ecs_service" "worker"');
    const releaseWorker = hclBlock(release, 'release_worker_container =');
    const registerWorker = hclBlock(release, '"Register fixed Worker revision" =');

    expect(attributeNumber(workerTask, 'cpu')).toBe(4096);
    expect(attributeNumber(workerTask, 'memory')).toBe(8192);
    expect(environmentInteger(workerTask, 'GENERATION_CONSUMER_CONCURRENCY', 'lower')).toBe(25);
    expect(environmentInteger(workerTask, 'WORKER_MAX_CONCURRENT_JOBS', 'lower')).toBe(32);
    expect(desiredCount(workerService)).toBe(2);
    expect(attributeNumber(workerService, 'deployment_maximum_percent')).toBe(150);

    expect(environmentInteger(releaseWorker, 'GENERATION_CONSUMER_CONCURRENCY', 'upper')).toBe(25);
    expect(environmentInteger(releaseWorker, 'WORKER_MAX_CONCURRENT_JOBS', 'upper')).toBe(32);
    expect(registerWorker).toContain('Cpu                     = "4096"');
    expect(registerWorker).toContain('Memory                  = "8192"');
    expect(registerWorker).toContain('merge(local.release_worker_container,');
  });

  test('budgets every steady and rolling PostgreSQL pool below the 160 connection line', async () => {
    const compute = await source('infra/modules/platform/compute.tf');
    const release = await source('infra/modules/platform/release-control.tf');
    const observability = await source('infra/modules/platform/observability.tf');
    const workerTask = hclBlock(compute, 'resource "aws_ecs_task_definition" "worker"');
    const apiTask = hclBlock(compute, 'resource "aws_ecs_task_definition" "api"');
    const brokerTask = hclBlock(compute, 'resource "aws_ecs_task_definition" "tenant_data_broker"');
    const migrationTask = hclBlock(compute, 'resource "aws_ecs_task_definition" "migration"');
    const releaseWorker = hclBlock(release, 'release_worker_container =');
    const releaseApi = hclBlock(release, 'release_api_container =');
    const releaseBroker = hclBlock(release, 'release_tenant_data_broker_container =');
    const releaseMigration = hclBlock(release, 'release_migration_container =');

    for (const [name, value] of Object.entries(WORKER_POOL_BUDGET)) {
      expect(environmentInteger(workerTask, name, 'lower')).toBe(value);
      expect(environmentInteger(releaseWorker, name, 'upper')).toBe(value);
    }
    const apiPool = environmentInteger(apiTask, 'API_DATABASE_POOL_MAX', 'lower');
    const brokerPool = environmentInteger(
      brokerTask,
      'TENANT_DATA_BROKER_DATABASE_POOL_MAX',
      'lower',
    );
    const migrationPool = environmentInteger(migrationTask, 'MIGRATION_DATABASE_POOL_MAX', 'lower');
    expect(apiPool).toBe(5);
    expect(brokerPool).toBe(5);
    expect(migrationPool).toBe(1);
    expect(environmentInteger(releaseApi, 'API_DATABASE_POOL_MAX', 'upper')).toBe(apiPool);
    expect(environmentInteger(releaseBroker, 'TENANT_DATA_BROKER_DATABASE_POOL_MAX', 'upper')).toBe(
      brokerPool,
    );
    expect(environmentInteger(releaseMigration, 'MIGRATION_DATABASE_POOL_MAX', 'upper')).toBe(
      migrationPool,
    );

    const workerPool = Object.values(WORKER_POOL_BUDGET).reduce((total, value) => total + value, 0);
    expect(workerPool).toBe(40);
    const services = [
      {
        block: hclBlock(compute, 'resource "aws_ecs_service" "worker"'),
        pool: workerPool,
      },
      { block: hclBlock(compute, 'resource "aws_ecs_service" "api"'), pool: apiPool },
      {
        block: hclBlock(compute, 'resource "aws_ecs_service" "tenant_data_broker"'),
        pool: brokerPool,
      },
    ];
    const steadyConnections = services.reduce(
      (total, service) => total + desiredCount(service.block) * service.pool,
      0,
    );
    const rollingConnections =
      services.reduce(
        (total, service) =>
          total +
          Math.floor(
            (desiredCount(service.block) *
              attributeNumber(service.block, 'deployment_maximum_percent')) /
              100,
          ) *
            service.pool,
        0,
      ) + migrationPool;
    const databaseAlarm = hclBlock(
      observability,
      'resource "aws_cloudwatch_metric_alarm" "database_connections"',
    );
    const safeLine = attributeNumber(databaseAlarm, 'threshold');

    expect(steadyConnections).toBe(100);
    expect(rollingConnections).toBe(151);
    expect(steadyConnections).toBeLessThan(safeLine);
    expect(rollingConnections).toBeLessThan(safeLine);
  });

  test('binds the staging probe only inside the exact Worker container definitions', async () => {
    const compute = await source('infra/modules/platform/compute.tf');
    const release = await source('infra/modules/platform/release-control.tf');
    const workerTask = hclBlock(compute, 'resource "aws_ecs_task_definition" "worker"');
    const apiTask = hclBlock(compute, 'resource "aws_ecs_task_definition" "api"');
    const brokerTask = hclBlock(compute, 'resource "aws_ecs_task_definition" "tenant_data_broker"');
    const releaseWorker = hclBlock(release, 'release_worker_container =');
    const releaseApi = hclBlock(release, 'release_api_container =');
    const releaseBroker = hclBlock(release, 'release_tenant_data_broker_container =');
    const registerWorker = hclBlock(release, '"Register fixed Worker revision" =');

    for (const [block, style] of [
      [workerTask, 'lower'],
      [releaseWorker, 'upper'],
    ] as const) {
      expect(exactStagingProbeConditional(block, style)).toEqual([
        ['GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX', '0050'],
        ['GENERATION_CAPACITY_PROBE_HOLD_MS', '10000'],
      ]);
    }
    for (const block of [apiTask, brokerTask, releaseApi, releaseBroker]) {
      expect(block).not.toContain('GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX');
      expect(block).not.toContain('GENERATION_CAPACITY_PROBE_HOLD_MS');
    }
    expect(registerWorker).toContain('merge(local.release_worker_container,');
  });

  test('rejects a Worker definition when probe entries move outside the staging conditional', async () => {
    const compute = await source('infra/modules/platform/compute.tf');
    const workerTask = hclBlock(compute, 'resource "aws_ecs_task_definition" "worker"');
    const mutatedWorkerTask = moveConditionalEntriesIntoBaseList(workerTask);

    expect(mutatedWorkerTask).toContain('GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX');
    expect(mutatedWorkerTask).toContain('GENERATION_CAPACITY_PROBE_HOLD_MS');
    expect(() => exactStagingProbeConditional(mutatedWorkerTask, 'lower')).toThrow(
      'HCL_STAGING_PROBE_ENTRIES_NOT_EXACT',
    );
  });
});

async function source(path: string): Promise<string> {
  return readFile(join(process.cwd(), path), 'utf8');
}

function hclBlock(sourceText: string, signature: string): string {
  const signatureIndex = sourceText.indexOf(signature);
  if (signatureIndex < 0) throw new Error(`HCL_SIGNATURE_NOT_FOUND:${signature}`);
  const openIndex = sourceText.indexOf('{', signatureIndex + signature.length);
  if (openIndex < 0) throw new Error(`HCL_BLOCK_OPEN_NOT_FOUND:${signature}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < sourceText.length; index += 1) {
    const character = sourceText[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character !== '}') continue;
    depth -= 1;
    if (depth === 0) return sourceText.slice(signatureIndex, index + 1);
  }
  throw new Error(`HCL_BLOCK_UNCLOSED:${signature}`);
}

function attributeNumber(block: string, name: string): number {
  const matches = [...block.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*([0-9]+)\\s*$`, 'gmu'))];
  if (matches.length !== 1) throw new Error(`HCL_ATTRIBUTE_NOT_EXACT:${name}`);
  return Number(matches[0]![1]);
}

function desiredCount(serviceBlock: string): number {
  const match = serviceBlock.match(
    /^\s*desired_count\s*=\s*var\.bootstrap_complete\s*\?\s*([0-9]+)\s*:\s*0\s*$/mu,
  );
  if (match === null) throw new Error('HCL_DESIRED_COUNT_NOT_EXACT');
  return Number(match[1]);
}

function exactStagingProbeConditional(
  block: string,
  style: 'lower' | 'upper',
): ReadonlyArray<readonly [string, string]> {
  const span = stagingConditionalSpan(block);
  const entries = environmentEntries(block.slice(span.bodyStart, span.bodyEnd), style);
  const expected = [
    ['GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX', '0050'],
    ['GENERATION_CAPACITY_PROBE_HOLD_MS', '10000'],
  ] as const;
  const occurrencesAreExclusive = expected.every(([name]) => block.split(`"${name}"`).length === 2);
  if (!occurrencesAreExclusive || JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error('HCL_STAGING_PROBE_ENTRIES_NOT_EXACT');
  }
  return entries;
}

function moveConditionalEntriesIntoBaseList(block: string): string {
  const span = stagingConditionalSpan(block);
  const conditionalEntries = block.slice(span.bodyStart, span.bodyEnd);
  return (
    block.slice(0, span.prefixStart) +
    conditionalEntries +
    block.slice(span.prefixStart, span.bodyStart) +
    block.slice(span.bodyEnd)
  );
}

function stagingConditionalSpan(block: string): {
  prefixStart: number;
  bodyStart: number;
  bodyEnd: number;
} {
  const prefixPattern = /\],\s*var\.environment\s*==\s*"staging"\s*\?\s*\[/gmu;
  const matches = [...block.matchAll(prefixPattern)];
  if (matches.length !== 1 || matches[0]!.index === undefined) {
    throw new Error('HCL_STAGING_CONDITIONAL_NOT_EXACT');
  }
  const match = matches[0]!;
  const prefixStart = match.index;
  const bodyStart = prefixStart + match[0].length;
  const bodyEnd = matchingSquareBracket(block, bodyStart - 1);
  if (!/^\]\s*:\s*\[\s*\]\s*\)/u.test(block.slice(bodyEnd))) {
    throw new Error('HCL_STAGING_CONDITIONAL_NOT_EXACT');
  }
  return { prefixStart, bodyStart, bodyEnd };
}

function matchingSquareBracket(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '[') depth += 1;
    if (character !== ']') continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error('HCL_STAGING_CONDITIONAL_UNCLOSED');
}

function environmentEntries(
  listBody: string,
  style: 'lower' | 'upper',
): ReadonlyArray<readonly [string, string]> {
  const nameField = style === 'lower' ? 'name' : 'Name';
  const valueField = style === 'lower' ? 'value' : 'Value';
  const entryPattern = new RegExp(
    `\\{\\s*${nameField}\\s*=\\s*"([A-Z0-9_]+)"\\s*,\\s*${valueField}\\s*=\\s*"([^"]*)"\\s*\\}`,
    'gmu',
  );
  const entries: Array<readonly [string, string]> = [];
  let cursor = 0;
  for (const match of listBody.matchAll(entryPattern)) {
    if (match.index === undefined || !/^[\s,]*$/u.test(listBody.slice(cursor, match.index))) {
      throw new Error('HCL_STAGING_PROBE_LIST_MALFORMED');
    }
    entries.push([match[1]!, match[2]!]);
    cursor = match.index + match[0].length;
  }
  if (!/^[\s,]*$/u.test(listBody.slice(cursor))) {
    throw new Error('HCL_STAGING_PROBE_LIST_MALFORMED');
  }
  return entries;
}

function environmentInteger(block: string, name: string, style: 'lower' | 'upper'): number {
  const value = environmentString(block, name, style);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`HCL_ENVIRONMENT_INTEGER_INVALID:${name}`);
  }
  return Number(value);
}

function environmentString(block: string, name: string, style: 'lower' | 'upper'): string {
  const nameField = style === 'lower' ? 'name' : 'Name';
  const valueField = style === 'lower' ? 'value' : 'Value';
  const matches = [
    ...block.matchAll(
      new RegExp(
        `\\{\\s*${nameField}\\s*=\\s*"${name}"\\s*,\\s*${valueField}\\s*=\\s*"([0-9]+)"\\s*\\}`,
        'gmu',
      ),
    ),
  ];
  if (matches.length !== 1) throw new Error(`HCL_ENVIRONMENT_VALUE_NOT_EXACT:${name}`);
  return matches[0]![1]!;
}
