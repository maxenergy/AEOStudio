import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();

function workflow(path: string): Promise<string> {
  return readFile(join(root, '.github', 'workflows', path), 'utf8');
}

function section(source: string, start: string, end: string): string {
  return source.split(start)[1]?.split(end)[0] ?? '';
}

function topLevelStateGraph(source: string): {
  start: string;
  states: Set<string>;
  missing: string[];
  unreachable: string[];
  predecessors: Map<string, Set<string>>;
} {
  const headers = [...source.matchAll(/^ {6}"([^"]+)"\s*=\s*\{/gmu)];
  const start = source.match(/^ {4}StartAt\s*=\s*"([^"]+)"/mu)?.[1] ?? '';
  const bodies = new Map<string, string>();

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (header?.index === undefined) continue;
    const next = headers[index + 1];
    const end = next?.index ?? source.length;
    bodies.set(header[1] ?? '', source.slice(header.index, end));
  }

  const edges = new Map<string, Set<string>>();
  const predecessors = new Map<string, Set<string>>();
  const missing: string[] = [];
  for (const [state, body] of bodies) {
    const targets = new Set<string>();
    for (const line of body.split(/\r?\n/u)) {
      const indentation = line.match(/^ */u)?.[0].length ?? 0;
      if (indentation > 12) continue;
      for (const match of line.matchAll(/\b(?:Next|Default)\s*=\s*"([^"]+)"/gu)) {
        const target = match[1] ?? '';
        targets.add(target);
        const incoming = predecessors.get(target) ?? new Set<string>();
        incoming.add(state);
        predecessors.set(target, incoming);
      }
    }
    edges.set(state, targets);
  }

  for (const [state, targets] of edges) {
    for (const target of targets) {
      if (!bodies.has(target)) missing.push(`${state} -> ${target}`);
    }
  }

  const visited = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const state = queue.shift();
    if (state === undefined || visited.has(state) || !bodies.has(state)) continue;
    visited.add(state);
    for (const target of edges.get(state) ?? []) queue.push(target);
  }

  return {
    start,
    states: new Set(bodies.keys()),
    missing,
    unreachable: [...bodies.keys()].filter((state) => !visited.has(state)).sort(),
    predecessors,
  };
}

describe('Task 18 release gates', () => {
  test('documents the generation-fenced DynamoDB coordination item instead of retired SSM locks', async () => {
    const runbook = await readFile(join(root, 'docs', 'operations', 'supply-chain.md'), 'utf8');

    expect(runbook).toContain('aeostudio-<env>-release-control');
    expect(runbook).toContain('CoordinationKey=ENVIRONMENT');
    expect(runbook).toContain('Generation');
    expect(runbook).toContain('LockOwner');
    expect(runbook).toContain('ClaimOwner');
    expect(runbook).toContain('exactly four immutable private-ECR references');
    expect(runbook).toContain('registers five statically defined task definitions');
    expect(runbook).toContain('updates the four exact services');
    expect(runbook).toContain('failed DEPLOY compensation');
    expect(runbook).not.toContain('/aeostudio/<env>/release-lock');
    expect(runbook).not.toContain('/aeostudio/<env>/release-lifecycle-claim');
    expect(runbook).not.toContain('exactly three immutable private-ECR references');
  });

  test('every service description validates one exact response before indexing it', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const descriptions = [
      ...releaseControl.matchAll(
        /Resource\s*=\s*"arn:aws:states:::aws-sdk:ecs:describeServices"/gu,
      ),
    ];

    expect(descriptions).toHaveLength(16);
    for (const description of descriptions) {
      const taskTail = releaseControl.slice(description.index, description.index + 1_800);
      const selector = taskTail.match(/ResultSelector\s*=\s*\{([\s\S]*?)\n\s*\}/u)?.[1] ?? '';
      const requestedServices = taskTail.match(/Services\s*=\s*\[([^\]]+)\]/u)?.[1] ?? '';

      expect(requestedServices).not.toContain(',');
      expect(selector).toContain('"FailureCount.$" = "States.ArrayLength($.Failures)"');
      expect(selector).toContain('"ServiceCount.$" = "States.ArrayLength($.Services)"');
      expect(selector).toContain('"Services.$"');
      expect(selector).not.toContain('Services[0]');
      expect(taskTail).toMatch(
        /Next\s*=\s*"[^"]+response count"[\s\S]*?NumericEquals\s*=\s*0[\s\S]*?NumericEquals\s*=\s*1[\s\S]*?Next\s*=\s*"Select exact [^"]+ service"/u,
      );
    }
  });

  test('starts and verifies the deterministic watchdog before acquiring the environment lock', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const broker = section(
      releaseControl,
      'resource "aws_sfn_state_machine" "release"',
      'resource "aws_iam_role" "release_watchdog"',
    );

    expect(broker).toMatch(
      /"Build exact environment release lock"[\s\S]*?Next\s*=\s*"Build exact release watchdog launch"/u,
    );
    expect(broker).toMatch(
      /"Exact release watchdog started"[\s\S]*?Next\s*=\s*"Acquire exact environment release lock"/u,
    );
    expect(broker).toMatch(
      /"Possibly started release watchdog matches"[\s\S]*?Next\s*=\s*"Acquire exact environment release lock"/u,
    );
    expect(broker).toContain('"Inspect possibly started release watchdog"');
    expect(broker).toContain('StringEqualsPath = "$.watchdogLaunch.ExecutionArn"');
    expect(broker).toContain('Error = "ReleaseWatchdogUnavailable"');
  });

  test('uses one generation-fenced DynamoDB coordination item instead of non-CAS SSM locks', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const orchestratorPolicy = section(
      releaseControl,
      'data "aws_iam_policy_document" "release_orchestrator"',
      'resource "aws_iam_role_policy" "release_orchestrator"',
    );

    expect(releaseControl).toContain('resource "aws_dynamodb_table" "release_control"');
    expect(releaseControl).toContain('hash_key     = "CoordinationKey"');
    expect(releaseControl).toContain('ADD Generation :one');
    expect(releaseControl).toContain('Phase = :preparing');
    expect(releaseControl).toContain('Phase = :ready');
    expect(releaseControl).toContain('StringEquals = "CONTRACT_READY"');
    expect(releaseControl).not.toContain('release-lock');
    expect(releaseControl).not.toContain('release-lifecycle-claim');
    expect(orchestratorPolicy).toContain('dynamodb:GetItem');
    expect(orchestratorPolicy).toContain('dynamodb:UpdateItem');
    expect(orchestratorPolicy).toContain('aws_dynamodb_table.release_control.arn');
  });

  test('the durable watchdog is read-only over reconciliation state and waits for exact child success', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const policy = section(
      releaseControl,
      'data "aws_iam_policy_document" "release_watchdog"',
      'resource "aws_iam_role_policy" "release_watchdog"',
    );
    const watchdog = section(
      releaseControl,
      'resource "aws_sfn_state_machine" "release_watchdog"',
      'resource "aws_iam_role" "bootstrap_orchestrator"',
    );

    expect(policy).toContain('ssm:GetParameter');
    expect(policy).toContain('dynamodb:GetItem');
    expect(policy).not.toMatch(/ssm:(?:PutParameter|DeleteParameter)|dynamodb:UpdateItem/u);
    expect(watchdog).toContain('TimeoutSeconds = 10800');
    expect(watchdog).toMatch(
      /"Wait for smoke lease"[\s\S]*?Seconds\s*=\s*900[\s\S]*?Next\s*=\s*"Load exact watched release lock"/u,
    );
    expect(watchdog).toContain('"Select watched release coordination phase"');
    expect(watchdog).toContain('"Wait for active lifecycle operation"');
    expect(watchdog).toContain('"Wait for reconciliation execution"');
    expect(watchdog).toMatch(
      /StringEquals\s*=\s*"SUCCEEDED"[\s\S]*?Next\s*=\s*"Watchdog reconciliation succeeded"/u,
    );
    expect(watchdog).not.toMatch(
      /"Wait for smoke lease"[\s\S]{0,180}?Next\s*=\s*"(?:Build|Start) exact [^"]*rollback/u,
    );
    const watchedOutcome = section(
      watchdog,
      '"Select exact watched release outcome" = {',
      '"Record exact smoke-timeout recovery" = {',
    );
    const lifecycleOutcome = section(
      watchdog,
      '"Select watched lifecycle outcome" = {',
      '"Wait for active lifecycle operation" = {',
    );
    const exactLockMatch = section(
      watchdog,
      '"Exact watched release lock matches" = {',
      '"Select watched release coordination phase" = {',
    );
    expect(exactLockMatch).toContain('Default = "Watchdog reconciliation rejected"');
    expect(exactLockMatch).not.toContain('Default = "Watched release already compensated"');
    expect(watchedOutcome).not.toContain('Next = "Watchdog reconciliation succeeded"');
    expect(watchedOutcome).toContain('Next = "Record exact terminal recovery"');
    for (const status of ['FAILED', 'TIMED_OUT', 'ABORTED', 'SUCCEEDED']) {
      expect(lifecycleOutcome).toContain(
        `{ Variable = "$.lifecycleExecution.Status", StringEquals = "${status}", Next = "Record exact lifecycle recovery" }`,
      );
    }
  });

  test('shares one deterministic RECOVER child and adopts a lost StartExecution response by exact ARN and input', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const watchdog = section(
      releaseControl,
      'resource "aws_sfn_state_machine" "release_watchdog"',
      'resource "aws_iam_role" "bootstrap_orchestrator"',
    );
    const start = section(
      watchdog,
      '"Start exact reconciliation execution" = {',
      '"Exact reconciliation start response matches" = {',
    );

    expect(watchdog).not.toContain('States.UUID()');
    expect(watchdog).not.toContain('"Freeze exact reconciliation execution name"');
    expect(watchdog).not.toContain('"Build exact rolled-back cleanup input"');
    expect(watchdog).not.toMatch(/reconciliationLaunch[\s\S]*?Mode\s*=\s*"ROLLBACK"/u);
    expect(watchdog).toContain(`"Name.$"         = "States.Format('reconcile-{}', $.ReleaseId)"`);
    expect(watchdog).toContain(`execution:\${local.name}-release:reconcile-{}', $.ReleaseId`);
    expect(start).toMatch(/"Name\.\$"\s*=\s*"\$\.reconciliationExecution\.Name"/u);
    expect(start).toMatch(/"Input\.\$"\s*=\s*"\$\.reconciliationExecution\.Input"/u);
    expect(start).not.toContain('States.UUID()');
    expect(start).toMatch(/Catch[\s\S]*?Next\s*=\s*"Wait for reconciliation execution"/u);
    expect(watchdog).toContain('"Exact reconciliation execution matches"');
    expect(watchdog).toContain('"Input.$"  = "States.StringToJson($.Input)"');
    const inputShape = section(
      watchdog,
      '"Validate exact reconciliation input shape" = {',
      '"Select reconciliation execution outcome" = {',
    );
    expect(inputShape).toContain('QueryLanguage = "JSONata"');
    expect(inputShape).toContain('$count($keys($states.input.reconciliationStatus.Input)) = 3');
  });

  test('bounds every ASL entry that can derive the shared reconciliation execution name', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const deployBound = section(
      releaseControl,
      '"Validate bounded deploy execution name" = {',
      '"Release request invalid" = {',
    );
    const rawRecoveryBound = section(
      releaseControl,
      '"Validate exact raw recovery envelope" = {',
      '"Initialize trusted recovery request" = {',
    );
    const trustedRecoveryBound = section(
      releaseControl,
      '"Validate bounded trusted recovery release ID" = {',
      '"Validate trusted recovery request" = {',
    );
    const watchdogBound = section(
      releaseControl,
      '"Validate bounded watched release ID" = {',
      '"Watched release invalid" = {',
    );

    expect(deployBound).toContain('QueryLanguage = "JSONata"');
    expect(deployBound).toContain('$length($states.context.Execution.Name) <= 70');
    expect(rawRecoveryBound).toContain('$length($states.input.ReleaseId) <= 70');
    expect(trustedRecoveryBound).toContain('$length($states.input.ReleaseId) <= 70');
    expect(watchdogBound).toContain('$length($states.input.ReleaseId) <= 70');
    expect(releaseControl).toContain(
      `"Name.$"         = "States.Format('reconcile-{}', $.ReleaseId)"`,
    );
  });

  test('bounds every raw FINALIZE and ROLLBACK lifecycle release identity before initialization', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const rawLifecycle = section(
      releaseControl,
      '"Validate raw lifecycle request" = {',
      '"Validate production finalization hash format" = {',
    );
    const productionFinalization = section(
      releaseControl,
      '"Validate production finalization hash format" = {',
      '"Validate bounded lifecycle release ID" = {',
    );
    const boundedLifecycle = section(
      releaseControl,
      '"Validate bounded lifecycle release ID" = {',
      '"Initialize trusted lifecycle request" = {',
    );

    expect(
      rawLifecycle.match(/Next\s*=\s*"Validate bounded lifecycle release ID"/gu) ?? [],
    ).toHaveLength(2);
    expect(productionFinalization).toContain('$length($states.input.ReleaseId) > 0');
    expect(productionFinalization).toContain('$length($states.input.ReleaseId) <= 70');
    expect(boundedLifecycle).toContain('QueryLanguage = "JSONata"');
    expect(boundedLifecycle).toContain('$length($states.input.ReleaseId) > 0');
    expect(boundedLifecycle).toContain('$length($states.input.ReleaseId) <= 70');
    expect(boundedLifecycle).toContain('Next      = "Initialize trusted lifecycle request"');
    expect(boundedLifecycle).toContain('Default = "Release lifecycle request rejected"');
  });

  test('recovers pre-contract cancellation only from an exact terminal PREPARING owner', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const broker = section(
      releaseControl,
      'resource "aws_sfn_state_machine" "release"',
      'resource "aws_iam_role" "release_watchdog"',
    );

    expect(broker).toContain('"Inspect pre-contract stale deploy execution"');
    expect(broker).toContain('"Pre-contract stale deploy is terminal"');
    expect(broker).toContain('"Clean exact pre-contract release lock"');
    expect(broker).toContain('StringEquals = "PREPARING"');
    expect(broker).toContain('PointerStatus = :status');
    expect(broker).toContain('{ S = "PREPARATION_ABORTED" }');
    expect(broker).toMatch(
      /"Pre-contract stale deploy is terminal"[\s\S]*?"FAILED"[\s\S]*?"TIMED_OUT"[\s\S]*?"ABORTED"/u,
    );
  });

  test('claim collisions are read back, waited on, and recovered without delegated false success', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const broker = section(
      releaseControl,
      'resource "aws_sfn_state_machine" "release"',
      'resource "aws_iam_role" "release_watchdog"',
    );

    expect(broker).not.toContain('"Release reconciliation delegated"');
    expect(broker).toContain('"Record already-owned exact recovery claim"');
    expect(broker).toContain('StringEqualsPath = "$$.Execution.Id"');
    expect(broker).toContain('"Wait for active recovery lifecycle operation"');
    expect(broker).toContain('"Read exact recovery claim takeover outcome"');
    expect(broker).toContain('"Wait to read recovery claim acquisition"');
    expect(broker).toContain('"Wait for competing lifecycle convergence"');
    expect(broker).toContain('ClaimOwner = :old_claim_owner');
    expect(broker).toContain('Phase = :ready');
  });

  test('orphan claims are reachable, strictly validated and CAS-cleaned before success', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );

    expect(
      releaseControl.match(/Next\s*=\s*"Load orphan recovery lifecycle claim"/gu),
    ).toHaveLength(1);
    expect(releaseControl.match(/Next\s*=\s*"Load orphan watched lifecycle claim"/gu)).toHaveLength(
      1,
    );
    expect(releaseControl).toContain('"Read orphan lifecycle claim cleanup outcome"');
    expect(releaseControl).toContain('"Wait to retry orphan lifecycle claim cleanup"');
    expect(releaseControl).toMatch(
      /"Orphan recovery lifecycle claim exists"[\s\S]*?ClaimMode\.S[\s\S]*?PointerReleaseId\.S[\s\S]*?Generation\.N[\s\S]*?Next\s*=\s*"Release recovery rejected"/u,
    );
    expect(releaseControl).toMatch(
      /"Orphan watched lifecycle claim exists"[\s\S]*?ClaimMode\.S[\s\S]*?PointerReleaseId\.S[\s\S]*?Generation\.N[\s\S]*?Next\s*=\s*"Watchdog reconciliation rejected"/u,
    );
  });

  test('DynamoDB owner absence and malformed attribute values always fail closed', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const recoveryLock = section(
      releaseControl,
      '"Recovery release lock exists" = {',
      '"Select exact recovery lock" = {',
    );
    const orphanRecovery = section(
      releaseControl,
      '"Orphan recovery lifecycle claim exists" = {',
      '"Select exact orphan recovery lifecycle claim" = {',
    );
    const watchedLock = section(
      releaseControl,
      '"Watched release lock exists" = {',
      '"Select exact watched release lock" = {',
    );
    const orphanWatched = section(
      releaseControl,
      '"Orphan watched lifecycle claim exists" = {',
      '"Select exact orphan watched lifecycle claim" = {',
    );

    expect(releaseControl).not.toMatch(
      /Variable\s*=\s*"\$\.[^"]*\.Item\.[A-Za-z][A-Za-z0-9_]*\.(?:S|N)"\s*,?\s*IsPresent\s*=\s*false/u,
    );
    expect(recoveryLock).toContain('Variable  = "$.recoveryLockResponse.Item.LockOwner"');
    expect(recoveryLock).toContain('Variable  = "$.recoveryLockResponse.Item.ClaimOwner"');
    expect(recoveryLock).toContain('Default = "Release recovery rejected"');
    expect(orphanRecovery).toContain('Variable  = "$.orphanCoordination.Item.ClaimOwner"');
    expect(orphanRecovery).toContain('Default = "Load stale release lock"');
    expect(watchedLock).toContain('Variable  = "$.watchedLockResponse.Item.LockOwner"');
    expect(watchedLock).toContain('Variable  = "$.watchedLockResponse.Item.ClaimOwner"');
    expect(watchedLock).toContain('Default = "Watchdog reconciliation rejected"');
    expect(orphanWatched).toContain('Variable  = "$.orphanCoordination.Item.ClaimOwner"');
    expect(orphanWatched).toContain('Default = "Load exact watched release lock"');
  });

  test('every top-level broker and watchdog state is reachable with no missing target', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const broker = section(
      releaseControl,
      'resource "aws_sfn_state_machine" "release"',
      'resource "aws_iam_role" "release_watchdog"',
    );
    const watchdog = section(
      releaseControl,
      'resource "aws_sfn_state_machine" "release_watchdog"',
      'resource "aws_iam_role" "bootstrap_orchestrator"',
    );

    for (const machine of [broker, watchdog]) {
      const graph = topLevelStateGraph(machine);
      expect(graph.start).not.toBe('');
      expect(graph.states.has(graph.start)).toBe(true);
      expect(graph.states.size).toBeGreaterThan(40);
      expect(graph.missing).toEqual([]);
      expect(graph.unreachable).toEqual([]);
    }

    const brokerGraph = topLevelStateGraph(broker);
    const watchdogGraph = topLevelStateGraph(watchdog);
    expect(brokerGraph.predecessors.get('Load orphan recovery lifecycle claim')?.size ?? 0).toBe(1);
    expect(watchdogGraph.predecessors.get('Load orphan watched lifecycle claim')?.size ?? 0).toBe(
      1,
    );
  });

  test('ambiguous contract, pointer and owner writes use exact read-back convergence', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    for (const state of [
      'Read possibly written immutable release contract',
      'Load possibly contract-ready coordination',
      'Read preparation cleanup outcome',
      'Read possibly finalized release pointer',
      'Read finalized lock cleanup outcome',
      'Read possibly awaiting-smoke release pointer',
      'Read awaiting-smoke coordination outcome',
      'Read possibly rolled-back release pointer',
      'Read rollback lock cleanup outcome',
      'Read recovered lock cleanup outcome',
      'Read pre-contract cleanup outcome',
      'Select pre-contract cleanup outcome',
    ]) {
      expect(releaseControl).toContain(`"${state}"`);
    }
    expect(releaseControl.match(/ConsistentRead\s*=\s*true/gu)?.length ?? 0).toBeGreaterThan(10);
    expect(releaseControl).toContain('StringEqualsPath = "$.ContractJson"');
    expect(releaseControl).toContain('REMOVE LockOwner, ReleaseId, ContractName, Phase');
    expect(releaseControl).not.toContain('"Delete failed release lock"');
    expect(releaseControl).toContain('the environment lock remains held for explicit recovery.');
  });

  test('ambiguous terminal pointer writes compare the exact frozen JSON payload', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );

    for (const pointer of [
      {
        build: 'Build finalized release pointer',
        serialize: 'Serialize finalized release pointer',
        read: 'Read possibly finalized release pointer',
        path: 'finalized',
      },
      {
        build: 'Build awaiting smoke release pointer',
        serialize: 'Serialize awaiting smoke release pointer',
        read: 'Read possibly awaiting-smoke release pointer',
        path: 'awaitingSmoke',
      },
      {
        build: 'Build rolled-back release pointer',
        serialize: 'Serialize rolled-back release pointer',
        read: 'Read possibly rolled-back release pointer',
        path: 'rolledBack',
      },
    ]) {
      expect(releaseControl).toContain(`"${pointer.serialize}"`);
      const build = section(releaseControl, `"${pointer.build}" = {`, `"${pointer.read}" = {`);
      expect(build).toContain(`"PointerJson.$" = "States.JsonToString($.${pointer.path}.Pointer)"`);
      const read = section(
        releaseControl,
        `"${pointer.read}" = {`,
        `"Possibly ${pointer.path === 'awaitingSmoke' ? 'awaiting-smoke' : pointer.path === 'rolledBack' ? 'rolled-back' : 'finalized'} release pointer matches" = {`,
      );
      expect(read).toContain('"PointerJson.$" = "$.Parameter.Value"');
      expect(releaseControl).toContain(`StringEqualsPath = "$.${pointer.path}.PointerJson"`);
    }
  });

  test('migration task arrays are counted before indexing and uncertainty retains the lock', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const broker = section(
      releaseControl,
      'resource "aws_sfn_state_machine" "release"',
      'resource "aws_iam_role" "release_watchdog"',
    );
    const migrationFailure = section(
      broker,
      '"Migration container failed" = {',
      '"Activate exact API" = {',
    );

    expect(broker).toContain('arn:aws:states:::ecs:runTask.sync');
    expect(broker).toContain('"TaskCount.$"    = "States.ArrayLength($.Tasks)"');
    expect(broker).toMatch(
      /"Exact migration task started"[\s\S]*?NumericEquals\s*=\s*1[\s\S]*?Next\s*=\s*"Capture exact migration task ARN"/u,
    );
    expect(broker).toMatch(
      /"Exact migration task described"[\s\S]*?NumericEquals\s*=\s*1[\s\S]*?Next\s*=\s*"Select exact migration task"/u,
    );
    expect(migrationFailure).toContain('Type  = "Fail"');
    expect(migrationFailure).toContain('the lock is retained');
    expect(migrationFailure).not.toContain('dynamodb:updateItem');
  });

  test('the fixed broker registers digest-bound revisions and can restore every retained revision', async () => {
    const [releaseControl, compute] = await Promise.all([
      readFile(join(root, 'infra', 'modules', 'platform', 'release-control.tf'), 'utf8'),
      readFile(join(root, 'infra', 'modules', 'platform', 'compute.tf'), 'utf8'),
    ]);
    const broker = section(
      releaseControl,
      'resource "aws_sfn_state_machine" "release"',
      'resource "aws_iam_role" "release_watchdog"',
    );

    expect(broker.match(/aws-sdk:ecr:batchGetImage/gu)).toHaveLength(4);
    expect(broker.match(/aws-sdk:ecs:registerTaskDefinition/gu)).toHaveLength(5);
    for (const service of ['Api', 'TenantDataBroker', 'Web', 'Worker']) {
      expect(broker).toContain(`"TaskDefinition.$" = "$.Contract.TaskDefinitions.${service}"`);
      expect(broker).toContain(`"TaskDefinition.$" = "$.Contract.Rollback.${service}"`);
    }
    expect(broker).toMatch(
      /"RollbackApi\.\$"\s*=\s*"\$\.priorResponses\.Api\.Service\.TaskDefinition"/u,
    );
    expect(broker).toContain('Overwrite = false');
    expect(releaseControl).toContain('Key   = "aeostudio:attested"');
    expect(releaseControl).toMatch(
      /aws:RequestTag\/aeostudio:attested[\s\S]{0,100}?values\s*=\s*\["true"\]/u,
    );
    expect(compute.match(/ignore_changes\s*=\s*\[task_definition\]/gu)).toHaveLength(4);
  });

  test('routine deployment IAM can only read evidence and invoke or observe fixed brokers', async () => {
    const iam = await readFile(join(root, 'infra', 'modules', 'platform', 'iam.tf'), 'utf8');
    const deploy = section(
      iam,
      'data "aws_iam_policy_document" "deploy"',
      'resource "aws_iam_role_policy" "deploy"',
    );

    expect(deploy).not.toMatch(
      /ecs:(?:RegisterTaskDefinition|TagResource|RunTask|UpdateService|StopTask|ExecuteCommand)|iam:PassRole/u,
    );
    expect(deploy).toContain('aws_sfn_state_machine.release.arn');
    expect(deploy).toContain('execution:${local.name}-release:*');
    expect(deploy).toContain('execution:${local.name}-release-watchdog:*');
    expect(deploy).toContain('dynamodb:GetItem');
    expect(deploy).not.toContain('dynamodb:UpdateItem');
    expect(deploy).not.toMatch(/ssm:(?:PutParameter|DeleteParameter)/u);
  });

  test('cleanup inspects exact identities and adopts the shared deterministic RECOVER child', async () => {
    const client = await readFile(
      join(root, 'scripts', 'release', 'run-release-broker.mjs'),
      'utf8',
    );

    expect(client).toContain('release-watchdog`');
    expect(client).toContain('watchdogExecutionArn');
    expect(client).not.toMatch(/waitForExecution\(\s*common\.region,\s*watchdogExecutionArn/u);
    expect(client).not.toContain('await recordTerminal(terminal, watchdogExecutionArn)');
    expect(client).not.toContain('CLEANUP_WATCHDOG_ACTIVE');
    expect(client).not.toContain("cleanupMode = 'ROLLBACK'");
    expect(client).toContain('const expectedReconciliationName = `reconcile-${releaseId}`');
    expect(client).toContain("Mode: 'RECOVER'");
    expect(client).toContain(
      'const cleanupExecution = requireSucceeded(await waitForExecution(common.region, cleanupArn))',
    );
    expect(client).toContain('requireTerminalCoordination');
    expect(client).toContain("'dynamodb',");
    expect(client).toContain("'get-item',");
    expect(client).toContain('RELEASE_EXECUTION_START_AMBIGUOUS');
    expect(client).toContain('!strictJsonObjectEquals(observed?.input, input)');
    expect(client).toContain("numberAttribute(item, 'Generation')");
    expect(client).toMatch(
      /function releaseIsNotOwned[\s\S]*?stringAttribute\(item, 'LockOwner'\) === undefined[\s\S]*?stringAttribute\(item, 'ClaimOwner'\) === undefined/u,
    );
    const missingDeployStart = client.lastIndexOf('if (deployExecution === undefined) {');
    expect(missingDeployStart).toBeGreaterThan(-1);
    const missingDeploy = client.slice(
      missingDeployStart,
      client.indexOf('if (\n      !exactExecutionIdentity(deployExecution,', missingDeployStart),
    );
    expect(missingDeploy).toContain("stringAttribute(coordination, 'LockOwner')");
    expect(missingDeploy).toContain("stringAttribute(coordination, 'ClaimOwner')");
    expect(missingDeploy).toContain("stringAttribute(coordination, 'PointerReleaseId')");
    expect(missingDeploy).toContain("stringAttribute(coordination, 'PointerContractName')");
    expect(missingDeploy).toContain("numberAttribute(coordination, 'Generation')");
    expect(missingDeploy).toContain('CLEANUP_DEPLOY_EXECUTION_MISSING_WITH_ACTIVE_COORDINATION');
  });

  test('RECOVER closes an exact no-claim AWAITING_SMOKE release through the rollback recovery claim', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const recoverySelection = section(
      releaseControl,
      '"Select exact recovery action" = {',
      '"Build finalized recovery cleanup claim" = {',
    );
    const rollbackMarker = 'Next = "Build rollback recovery claim"';
    const rollbackMarkerIndex = recoverySelection.indexOf(rollbackMarker);
    const rollbackBranchStart = recoverySelection.lastIndexOf('[{', rollbackMarkerIndex);
    const rollbackBranch = recoverySelection.slice(
      rollbackBranchStart,
      rollbackMarkerIndex + rollbackMarker.length,
    );
    const rawRecoveryShape = section(
      releaseControl,
      '"Validate exact raw recovery envelope" = {',
      '"Initialize trusted recovery request" = {',
    );
    const acquireRecoveryClaim = section(
      releaseControl,
      '"Acquire exact recovery claim" = {',
      '"Rebuild exact recovery request after claim ambiguity" = {',
    );
    const rebuildAfterAmbiguity = section(
      releaseControl,
      '"Rebuild exact recovery request after claim ambiguity" = {',
      '"Wait to read recovery claim acquisition" = {',
    );
    const waitAfterAmbiguity = section(
      releaseControl,
      '"Wait to read recovery claim acquisition" = {',
      '"Select trusted recovery action" = {',
    );
    const loadRecoveryClaim = section(
      releaseControl,
      '"Load exact recovery lifecycle claim" = {',
      '"Record already-owned exact recovery claim" = {',
    );

    expect(rollbackBranchStart).toBeGreaterThanOrEqual(0);
    expect(rollbackBranch).toMatch(
      /\$\.recoveryLockResponse\.Item\.ClaimOwner", IsPresent = false/u,
    );
    expect(rollbackBranch).toMatch(
      /\$\.recoveryLockResponse\.Item\.ClaimMode", IsPresent = false/u,
    );
    expect(rollbackBranch).toContain('{ Variable = "$.ClaimAlreadyOwned", BooleanEquals = true }');
    expect(rollbackBranch).toContain(
      '{ Variable = "$.recoveryLockResponse.Item.ClaimOwner.S", StringEqualsPath = "$$.Execution.Id" }',
    );
    expect(rollbackBranch).toContain(
      '{ Variable = "$.recoveryLockResponse.Item.ClaimMode.S", StringEquals = "RECOVER" }',
    );
    expect(rollbackBranch).toContain(
      '{ Variable = "$.recoveryPointer.Pointer.Status", StringEquals = "AWAITING_SMOKE" }',
    );
    expect(rollbackBranch).toContain(
      '{ Variable = "$.recoveryLockResponse.Item.PointerStatus.S", StringEquals = "AWAITING_SMOKE" }',
    );
    expect(rollbackBranch).toContain(
      '{ Variable = "$.recoveryPointer.Pointer.ReleaseId", StringEqualsPath = "$.recoveryLock.Lock.ReleaseId" }',
    );
    expect(rollbackBranch).toContain(
      '{ Variable = "$.recoveryPointer.Pointer.ContractName", StringEqualsPath = "$.recoveryLock.Lock.ContractName" }',
    );
    expect(rollbackBranch).toContain(
      '{ Variable = "$.recoveryLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.recoveryPointer.Pointer.ReleaseId" }',
    );
    expect(rollbackBranch).toContain(
      '{ Variable = "$.recoveryLockResponse.Item.PointerContractName.S", StringEqualsPath = "$.recoveryPointer.Pointer.ContractName" }',
    );
    expect(rollbackBranch).toContain(
      '{ Variable = "$.recoveryPointer.Pointer.FinalizationEvidence", IsPresent = false }',
    );
    for (const field of [
      'ProductionFinalizationEvidenceSha256',
      'GitHubEnvironmentEvidenceSha256',
      'PromotionControlPlaneEvidenceSha256',
    ]) {
      expect(rollbackBranch).toContain(
        `{ Variable = "$.recoveryLockResponse.Item.${field}", IsPresent = false }`,
      );
    }
    for (const status of ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED']) {
      expect(rollbackBranch).toContain(
        `{ Variable = "$.recoveryExecution.Status", StringEquals = "${status}" }`,
      );
    }
    expect(rollbackBranch).toContain(rollbackMarker);
    expect(rawRecoveryShape).toContain('QueryLanguage = "JSONata"');
    expect(rawRecoveryShape).toContain('$count($keys($states.input)) = 3');
    expect(acquireRecoveryClaim).toContain(
      'Next        = "Rebuild exact recovery request after claim ambiguity"',
    );
    expect(rebuildAfterAmbiguity).toContain(
      'Next       = "Wait to read recovery claim acquisition"',
    );
    expect(waitAfterAmbiguity).toContain('Next    = "Load stale release lock"');
    expect(loadRecoveryClaim).toContain('StringEqualsPath = "$$.Execution.Id"');
    expect(loadRecoveryClaim).toContain('StringEquals = "RECOVER"');
    expect(loadRecoveryClaim).toContain('Next = "Record already-owned exact recovery claim"');
  });

  test('staging and production use exact manifests, attestations, broker jobs and blocking smoke', async () => {
    const [build, production] = await Promise.all([
      workflow('build-attest.yml'),
      workflow('deploy-production.yml'),
    ]);

    expect(build).toMatch(/\n {2}build:\n[\s\S]{0,240}?needs:\s*\[verify, security\]/u);
    expect(build).toContain('schemaVersion:"aeostudio.release.v1"');
    expect(build).toContain('buildRunAttempt:$runAttempt');
    expect(build).toContain('Run blocking synthetic staging smoke');
    expect(build).toContain('--mode DEPLOY_START');
    expect(build).toContain('--mode DEPLOY_WAIT');
    expect(build).toContain('--mode FINALIZE');
    expect(build).toContain('--mode CLEANUP');
    expect(build).toContain(
      '--execution-name "reconcile-staging-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );
    expect(build).not.toContain('staging-cleanup-');
    for (const service of ['adot', 'api', 'web', 'worker']) {
      expect(build).toContain(`attestations/${service}-provenance.json`);
      expect(build).toContain(`attestations/${service}-sbom.json`);
    }

    expect(production).toContain('Prove staging used and smoked the exact build-once digests');
    expect(production).toContain('aeostudio.staging-smoke-envelope.v1');
    expect(production).toContain('for service in adot api web worker; do');
    expect(production.match(/gh attestation verify/gu)).toHaveLength(2);
    expect(production).toContain('--mode DEPLOY_START');
    expect(production).toContain('--mode DEPLOY_WAIT');
    expect(production).toContain('--mode FINALIZE');
    expect(production).toContain('--mode CLEANUP');
    expect(production).toContain(
      '--execution-name "reconcile-production-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );
    expect(production).not.toContain('production-cleanup-');
    expect(`${build}\n${production}`).not.toMatch(
      /aws ecs (?:register-task-definition|run-task|update-service)/u,
    );
  });

  test('production FINALIZE carries the three post-approval evidence hashes without changing staging FINALIZE', async () => {
    const [build, production, client] = await Promise.all([
      workflow('build-attest.yml'),
      workflow('deploy-production.yml'),
      readFile(join(root, 'scripts', 'release', 'run-release-broker.mjs'), 'utf8'),
    ]);
    const productionFinalize = section(
      production,
      '- name: Finalize the exact production release',
      '- name: Reconcile or roll back any started release that was not finalized',
    );
    const stagingFinalize = section(
      build,
      '- name: Finalize the exact staging release',
      '- name: Reconcile or roll back any started release that was not finalized',
    );

    expect(productionFinalize).toContain(
      '--production-finalization-evidence-sha256 "$production_finalization_evidence_sha256"',
    );
    expect(productionFinalize).toContain(
      '--github-environment-evidence-sha256 "$github_environment_evidence_sha256"',
    );
    expect(productionFinalize).toContain(
      '--promotion-control-plane-evidence-sha256 "$promotion_control_plane_evidence_sha256"',
    );
    expect(productionFinalize).toContain(
      'production_finalization_evidence_sha256="${{ steps.final-evidence.outputs.evidence_sha256 }}"',
    );
    expect(productionFinalize).toContain(
      'github_environment_evidence_sha256="${{ needs.validate-release.outputs.github-environment-evidence-sha256 }}"',
    );
    expect(productionFinalize).toContain(
      'promotion_control_plane_evidence_sha256="${{ needs.validate-release.outputs.control-plane-sha256 }}"',
    );
    expect(productionFinalize).not.toContain('jq -r');
    expect(stagingFinalize).not.toContain('finalization-evidence-sha256');
    expect(stagingFinalize).not.toContain('github-environment-evidence-sha256');
    expect(stagingFinalize).not.toContain('promotion-control-plane-evidence-sha256');
    for (const option of [
      'production-finalization-evidence-sha256',
      'github-environment-evidence-sha256',
      'promotion-control-plane-evidence-sha256',
    ]) {
      expect(client).toContain(`'${option}'`);
    }
    expect(client).toContain("common.mode === 'FINALIZE' && common.environment === 'production'");
    expect(client).toContain('ProductionFinalizationEvidenceSha256: option(');
    expect(client).toContain('GitHubEnvironmentEvidenceSha256: option(');
    expect(client).toContain('PromotionControlPlaneEvidenceSha256: option(');
  });

  test('persists production finalization hashes in the terminal pointer and coordination item', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const rawValidation = section(
      releaseControl,
      '"Validate raw lifecycle request" = {',
      '"Initialize trusted lifecycle request" = {',
    );
    const finalizedPointer = section(
      releaseControl,
      '"Build finalized release pointer" = {',
      '"Serialize finalized release pointer" = {',
    );
    const finalizedCoordination = section(
      releaseControl,
      '"Delete finalized release lock" = {',
      '"Read finalized lock cleanup outcome" = {',
    );

    for (const field of [
      'ProductionFinalizationEvidenceSha256',
      'GitHubEnvironmentEvidenceSha256',
      'PromotionControlPlaneEvidenceSha256',
    ]) {
      expect(rawValidation).toContain(`$.FinalizationEvidence.${field}`);
      expect(finalizedPointer).toContain(`"${field}.$"`);
      expect(finalizedPointer).toContain(`$.FinalizationEvidence.${field}`);
      expect(finalizedCoordination).toContain(`${field} = :`);
      expect(finalizedCoordination).toContain(`$.FinalizationEvidence.${field}`);
    }
    expect(rawValidation).toContain('var.environment == "production"');
    expect(finalizedPointer).toContain('var.environment == "production"');
    expect(finalizedCoordination).toContain('var.environment == "production"');
  });

  test('rejects a repeated production FINALIZE unless terminal coordination and pointer hashes match', async () => {
    const [releaseControl, client] = await Promise.all([
      readFile(join(root, 'infra', 'modules', 'platform', 'release-control.tf'), 'utf8'),
      readFile(join(root, 'scripts', 'release', 'run-release-broker.mjs'), 'utf8'),
    ]);
    const terminalCoordination = section(
      releaseControl,
      '"Active release lock exists" = {',
      '"Select exact active release lock" = {',
    );
    const idempotentPointer = section(
      releaseControl,
      '"Load idempotent finalized release pointer" = {',
      '"Select exact active release lock" = {',
    );
    const loadedPointer = section(
      releaseControl,
      '"Current release request matches" = {',
      '"Release lifecycle request rejected" = {',
    );
    const finalizedCleanup = section(
      releaseControl,
      '"Select finalized lock cleanup outcome" = {',
      '"Wait to retry finalized lock cleanup" = {',
    );
    const awaitingSmokeBranch =
      loadedPointer.split(
        '{ Variable = "$.loaded.Pointer.Status", StringEquals = "DEPLOYED" }',
      )[0] ?? '';

    expect(terminalCoordination).toContain('Next = "Load idempotent finalized release pointer"');
    expect(idempotentPointer).toContain('"Idempotent finalized release pointer matches"');
    expect(
      terminalCoordination.match(
        /\$\.activeReleaseCoordination\.Item\.Generation\.N", IsPresent = true/g,
      ),
    ).toHaveLength(4);
    expect(
      terminalCoordination.match(
        /\$\.activeReleaseCoordination\.Item\.PointerReleaseId\.S", IsPresent = true/g,
      ),
    ).toHaveLength(3);
    expect(
      terminalCoordination.match(
        /\$\.activeReleaseCoordination\.Item\.PointerContractName\.S", IsPresent = true/g,
      ),
    ).toHaveLength(3);
    expect(awaitingSmokeBranch).toContain(
      '{ Variable = "$.loaded.Pointer.Status", StringEquals = "AWAITING_SMOKE" }',
    );
    expect(loadedPointer).toMatch(/Choices = concat\(\s*\[\{\s*And = \[/u);
    expect(awaitingSmokeBranch).not.toContain('$.loaded.Pointer.FinalizationEvidence');
    for (const field of [
      'ProductionFinalizationEvidenceSha256',
      'GitHubEnvironmentEvidenceSha256',
      'PromotionControlPlaneEvidenceSha256',
    ]) {
      expect(terminalCoordination).toContain(`$.activeReleaseCoordination.Item.${field}.S`);
      expect(terminalCoordination).toContain(`$.FinalizationEvidence.${field}`);
      expect(idempotentPointer).toContain(
        `$.idempotentFinalized.Pointer.FinalizationEvidence.${field}`,
      );
      expect(idempotentPointer).toContain(`$.FinalizationEvidence.${field}`);
      expect(loadedPointer).toContain(`$.loaded.Pointer.FinalizationEvidence.${field}`);
      expect(loadedPointer).toContain(`$.FinalizationEvidence.${field}`);
      expect(finalizedCleanup).toContain(`$.finalizedLockCleanupOutcome.Item.${field}.S`);
      expect(finalizedCleanup).toContain(`$.FinalizationEvidence.${field}`);
    }
    expect(client).toContain('function requireFinalizedReleaseState');
    expect(client).toMatch(
      /requireFinalizedReleaseState\([\s\S]*?readPointer\(common\.region, common\.accountId, common\.environment\)\.pointer/u,
    );
    expect(client).toContain('readCoordination(common.region, common.environment)');
    expect(client).toMatch(/exactKeys\(\s*pointer\.FinalizationEvidence,\s*names/u);
    expect(client).toContain('sha256Pattern.test(pointer.FinalizationEvidence[name])');
  });

  test('recovery copies only an execution-verified production DEPLOYED pointer hash set into coordination', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const staleExecution = section(
      releaseControl,
      '"Inspect stale lifecycle execution" = {',
      '"Stale lifecycle execution is recoverable" = {',
    );
    const recoverySelection = section(
      releaseControl,
      '"Select exact recovery action" = {',
      '"Build finalized recovery cleanup claim" = {',
    );
    const recoveryClaim = section(
      releaseControl,
      '"Build finalized recovery cleanup claim" = {',
      '"Build terminal recovery cleanup claim" = {',
    );
    const recoveredFinalizedWrite = section(
      releaseControl,
      '"Delete recovered finalized release lock" = {',
      '"Delete recovered release lock" = {',
    );
    const recoveredReadback = section(
      releaseControl,
      '"Select recovered lock cleanup outcome" = {',
      '"Wait to retry recovered lock cleanup" = {',
    );

    expect(staleExecution).toContain('"Input.$"  = "States.StringToJson($.Input)"');
    expect(recoverySelection).toContain(
      '{ Variable = "$.staleLifecycleExecution.Input.Mode", StringEquals = "FINALIZE" }',
    );
    expect(recoverySelection).toContain(
      '{ Variable = "$.staleLifecycleExecution.Input.ReleaseId", StringEqualsPath = "$.recoveryPointer.Pointer.ReleaseId" }',
    );
    expect(recoveryClaim).toMatch(/TerminalStatus\s*=\s*"DEPLOYED"/u);
    expect(recoveredFinalizedWrite).toContain('var.environment == "production"');
    expect(recoverySelection).toContain(
      '{ Variable = "$.recoveryPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" }',
    );
    expect(recoverySelection).toContain(
      '{ Variable = "$.recoveryPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" }',
    );
    const productionRecovery = section(
      recoverySelection,
      'var.environment == "production" ? [{',
      'var.environment == "staging" ? [{',
    );
    const stagingRecovery = section(recoverySelection, 'var.environment == "staging" ? [{', '[{');
    for (const sharedExecutionCheck of [
      '{ Variable = "$.staleLifecycleClaim.Claim.Mode", StringEquals = "FINALIZE" }',
      '{ Variable = "$.staleLifecycleExecution.Input.Mode", StringEquals = "FINALIZE" }',
      '{ Variable = "$.staleLifecycleExecution.Input.ReleaseId", StringEqualsPath = "$.recoveryPointer.Pointer.ReleaseId" }',
    ]) {
      expect(productionRecovery).toContain(sharedExecutionCheck);
      expect(stagingRecovery).toContain(sharedExecutionCheck);
    }
    for (const field of [
      'ProductionFinalizationEvidenceSha256',
      'GitHubEnvironmentEvidenceSha256',
      'PromotionControlPlaneEvidenceSha256',
    ]) {
      expect(recoverySelection).toContain(
        `$.recoveryPointer.Pointer.FinalizationEvidence.${field}`,
      );
      expect(recoverySelection).toContain(
        `$.staleLifecycleExecution.Input.FinalizationEvidence.${field}`,
      );
      expect(recoveryClaim).toContain(`"${field}.$"`);
      expect(recoveryClaim).toContain(`$.recoveryPointer.Pointer.FinalizationEvidence.${field}`);
      expect(recoveredFinalizedWrite).toContain(`${field} = :`);
      expect(recoveredFinalizedWrite).toContain(`$.FinalizationEvidence.${field}`);
      expect(recoveredReadback).toContain(`$.recoveredLockCleanupOutcome.Item.${field}.S`);
      expect(recoveredReadback).toContain(`$.FinalizationEvidence.${field}`);
    }

    const takeoverReadback = section(
      releaseControl,
      '"Read exact recovery claim takeover outcome" = {',
      '"Record exact recovery claim takeover" = {',
    );
    expect(takeoverReadback).not.toContain(
      'Next        = "Rebuild exact recovery request after takeover ambiguity"',
    );
    expect(takeoverReadback).toContain('ResultPath = "$.recoveryClaimTakeoverOutcome"');
    expect(takeoverReadback).not.toContain('ResultPath = "$"');
  });

  test('non-deployed coordination transitions remove and reject stale production finalization hashes', async () => {
    const [releaseControl, client] = await Promise.all([
      readFile(join(root, 'infra', 'modules', 'platform', 'release-control.tf'), 'utf8'),
      readFile(join(root, 'scripts', 'release', 'run-release-broker.mjs'), 'utf8'),
    ]);
    const transitionSections = [
      section(
        releaseControl,
        '"Acquire exact environment release lock" = {',
        '"Load possibly acquired release lock" = {',
      ),
      section(
        releaseControl,
        '"Clean exact pre-contract release lock" = {',
        '"Wait to verify pre-contract cleanup" = {',
      ),
      section(
        releaseControl,
        '"Record awaiting-smoke coordination pointer" = {',
        '"Read awaiting-smoke coordination outcome" = {',
      ),
      section(
        releaseControl,
        '"Delete rollback release lock" = {',
        '"Read rollback lock cleanup outcome" = {',
      ),
      section(
        releaseControl,
        '"Delete recovered release lock" = {',
        '"Read recovered lock cleanup outcome" = {',
      ),
    ];
    const readbackSections = [
      section(
        releaseControl,
        '"Possibly acquired release lock matches" = {',
        '"Adopt exact acquired release lock" = {',
      ),
      section(
        releaseControl,
        '"Select pre-contract cleanup outcome" = {',
        '"Wait to retry pre-contract cleanup" = {',
      ),
      section(
        releaseControl,
        '"Select awaiting-smoke coordination outcome" = {',
        '"Wait to retry awaiting-smoke coordination" = {',
      ),
      section(
        releaseControl,
        '"Select rollback lock cleanup outcome" = {',
        '"Wait to retry rollback lock cleanup" = {',
      ),
      section(
        releaseControl,
        '"Select recovered lock cleanup outcome" = {',
        '"Wait to retry recovered lock cleanup" = {',
      ),
    ];

    for (const field of [
      'ProductionFinalizationEvidenceSha256',
      'GitHubEnvironmentEvidenceSha256',
      'PromotionControlPlaneEvidenceSha256',
    ]) {
      for (const transition of transitionSections) {
        expect(transition).toContain(`REMOVE`);
        expect(transition).toContain(field);
      }
      for (const readback of readbackSections) {
        expect(readback).toContain(`${field}", IsPresent = false`);
      }
    }
    expect(client).toContain('function requireNoFinalizationEvidence');
    expect(client).toMatch(
      /function requireNoFinalizationEvidence[\s\S]*?Object\.hasOwn\(item, name\)/u,
    );
    expect(client).toMatch(
      /function requireAwaitingSmokeCoordination[\s\S]*?requireNoFinalizationEvidence\(item\)/u,
    );
    expect(client).toContain('function requireExactTerminalReleaseState');
    expect(client).toMatch(
      /function requireExactTerminalReleaseState[\s\S]*?status !== 'PREPARATION_ABORTED'[\s\S]*?readPointer/u,
    );
    expect(client).toMatch(
      /function requireExactTerminalReleaseState[\s\S]*?pointer\.Status !== status[\s\S]*?requireFinalizedReleaseState[\s\S]*?requireNoFinalizationEvidence/u,
    );
    expect(client).not.toContain('CLEANUP_WATCHDOG_CONVERGED');
    expect(client).toMatch(/requireExactTerminalReleaseState\([\s\S]*?CLEANUP_ALREADY_CONVERGED/u);
    expect(client).toMatch(
      /requireSucceeded\(await waitForExecution\(common\.region, cleanupArn\)\)[\s\S]*?requireExactTerminalReleaseState/u,
    );
  });

  test('the lifecycle request validator locally admits only the intended environment modes', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const rawValidation = section(
      releaseControl,
      '"Validate raw lifecycle request" = {',
      '"Initialize trusted lifecycle request" = {',
    );

    expect(rawValidation).toContain('var.environment == "production"');
    expect(rawValidation).toContain('{ Variable = "$.Mode", StringEquals = "ROLLBACK" }');
    expect(rawValidation).toContain('{ Variable = "$.Mode", StringEquals = "FINALIZE" }');
    const productionFinalize = section(
      rawValidation,
      'var.environment == "production" ? [{',
      'var.environment == "production" ? [{',
    );
    const remainingValidation = rawValidation.slice(
      rawValidation.indexOf('var.environment == "production" ? [{') +
        'var.environment == "production" ? [{'.length,
    );
    const productionRollback = section(
      remainingValidation,
      'var.environment == "production" ? [{',
      'var.environment == "staging" ? [{',
    );
    const stagingLifecycle = section(
      rawValidation,
      'var.environment == "staging" ? [{',
      'Default = "Release lifecycle request rejected"',
    );
    expect(productionFinalize).toContain('{ Variable = "$.Mode", StringEquals = "FINALIZE" }');
    expect(productionFinalize).toContain('$.FinalizationEvidence.');
    expect(productionRollback).toContain('{ Variable = "$.Mode", StringEquals = "ROLLBACK" }');
    expect(productionRollback).not.toContain('StringEquals = "FINALIZE"');
    expect(stagingLifecycle).toContain('{ Variable = "$.Mode", StringEquals = "FINALIZE" }');
    expect(stagingLifecycle).toContain('{ Variable = "$.Mode", StringEquals = "ROLLBACK" }');
    expect(stagingLifecycle).not.toContain('$.FinalizationEvidence.');
  });

  test('watchdog and orphan terminal recovery preserve exact production finalization evidence', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const watchedOutcome = section(
      releaseControl,
      '"Select exact watched release outcome" = {',
      '"Record exact smoke-timeout recovery" = {',
    );
    const watchedClaimSelection = section(
      releaseControl,
      '"Load exact watched lifecycle claim" = {',
      '"Select exact watched lifecycle claim" = {',
    );
    const orphanTerminal = section(
      releaseControl,
      '"Exact orphan terminal state matches" = {',
      '"Delete exact finalized orphan lifecycle claim" = {',
    );
    const orphanFinalizedDelete = section(
      releaseControl,
      '"Delete exact finalized orphan lifecycle claim" = {',
      '"Delete exact orphan lifecycle claim" = {',
    );
    const orphanReadback = section(
      releaseControl,
      '"Select orphan lifecycle claim cleanup outcome" = {',
      '"Wait to retry orphan lifecycle claim cleanup" = {',
    );
    const noLockRecovery = section(
      releaseControl,
      '"Recovery release lock exists" = {',
      '"Select exact recovery lock" = {',
    );

    expect(watchedOutcome).toContain('$.watchedPointer.Pointer.SchemaVersion');
    expect(watchedOutcome).toContain('$.watchedPointer.Pointer.BrokerArn');
    expect(watchedOutcome).toContain('StringEquals = "AWAITING_SMOKE"');
    expect(watchedOutcome).toContain('StringEquals = "DEPLOYED"');
    expect(watchedClaimSelection).toContain('Default = "Build exact recovery input"');
    expect(watchedOutcome).not.toContain('Next = "Watchdog reconciliation succeeded"');
    expect(watchedOutcome).toContain('Next = "Record exact terminal recovery"');
    expect(releaseControl).not.toContain('"Build exact finalized cleanup input" = {');
    expect(releaseControl).not.toContain(
      '{ Variable = "$.reconciliation.Mode", StringEquals = "FINALIZE", Next = "Build exact finalized cleanup input" }',
    );
    expect(orphanTerminal).toContain(
      '{ Variable = "$.orphanLifecycleExecution.Input.Mode", StringEquals = "FINALIZE" }',
    );
    expect(orphanTerminal).toContain('$.orphanPointer.Pointer.SchemaVersion');
    expect(orphanTerminal).toContain('$.orphanPointer.Pointer.BrokerArn');
    expect(orphanFinalizedDelete).toContain('PointerStatus = :status');
    expect(orphanFinalizedDelete).toContain('ClaimMode = :claim_mode');
    expect(noLockRecovery).toContain(
      '$.recoveryLockResponse.Item.ProductionFinalizationEvidenceSha256',
    );
    for (const field of [
      'ProductionFinalizationEvidenceSha256',
      'GitHubEnvironmentEvidenceSha256',
      'PromotionControlPlaneEvidenceSha256',
    ]) {
      expect(watchedOutcome).toContain(`$.watchedPointer.Pointer.FinalizationEvidence.${field}`);
      expect(watchedOutcome).toContain(`$.watchedLockResponse.Item.${field}`);
      expect(orphanTerminal).toContain(
        `$.orphanLifecycleExecution.Input.FinalizationEvidence.${field}`,
      );
      expect(orphanTerminal).toContain(`$.orphanPointer.Pointer.FinalizationEvidence.${field}`);
      expect(orphanTerminal).toContain(`$.orphanCoordination.Item.${field}.S`);
      expect(orphanFinalizedDelete).toContain(field);
      expect(orphanReadback).toContain(`$.orphanLifecycleClaimCleanupOutcome.Item.${field}.S`);
      expect(orphanReadback).toContain(`$.orphanPointer.Pointer.FinalizationEvidence.${field}`);
    }
  });

  test('production direct FINALIZE hashes pass an exact JSONata lowercase sha256 gate', async () => {
    const releaseControl = await readFile(
      join(root, 'infra', 'modules', 'platform', 'release-control.tf'),
      'utf8',
    );
    const rawValidation = section(
      releaseControl,
      '"Validate raw lifecycle request" = {',
      '"Initialize trusted lifecycle request" = {',
    );
    const hashValidation = section(
      releaseControl,
      '"Validate production finalization hash format" = {',
      '"Initialize trusted lifecycle request" = {',
    );

    expect(rawValidation).toContain('Next = "Validate production finalization hash format"');
    expect(hashValidation).toContain('QueryLanguage = "JSONata"');
    expect(hashValidation).toContain('Condition =');
    expect(hashValidation).not.toContain('Variable =');
    expect(hashValidation).toContain('/^[0-9a-f]{64}$/');
    expect(hashValidation).toContain('Default = "Release lifecycle request rejected"');
    for (const field of [
      'ProductionFinalizationEvidenceSha256',
      'GitHubEnvironmentEvidenceSha256',
      'PromotionControlPlaneEvidenceSha256',
    ]) {
      expect(hashValidation).toContain(`$states.input.FinalizationEvidence.${field}`);
    }
  });

  test('rollback attempts all services and service plus target-health budgets exceed drain delay', async () => {
    const [releaseControl, compute] = await Promise.all([
      readFile(join(root, 'infra', 'modules', 'platform', 'release-control.tf'), 'utf8'),
      readFile(join(root, 'infra', 'modules', 'platform', 'compute.tf'), 'utf8'),
    ]);
    const broker = section(
      releaseControl,
      'resource "aws_sfn_state_machine" "release"',
      'resource "aws_iam_role" "release_watchdog"',
    );
    const api = section(broker, '"Restore exact API" = {', '"Restore exact Web" = {');
    const web = section(broker, '"Restore exact Web" = {', '"Restore exact Worker" = {');
    const worker = section(
      broker,
      '"Restore exact Worker" = {',
      '"Restore exact Tenant Data Broker" = {',
    );
    const tenantDataBroker = section(
      broker,
      '"Restore exact Tenant Data Broker" = {',
      '"Initialize rollback stability attempts" = {',
    );

    expect(api).toMatch(/ResultPath\s*=\s*"\$\.apiRollbackError"[\s\S]*?"Restore exact Web"/u);
    expect(web).toMatch(/ResultPath\s*=\s*"\$\.webRollbackError"[\s\S]*?"Restore exact Worker"/u);
    expect(worker).toMatch(
      /ResultPath\s*=\s*"\$\.workerRollbackError"[\s\S]*?"Restore exact Tenant Data Broker"/u,
    );
    expect(tenantDataBroker).toMatch(
      /ResultPath\s*=\s*"\$\.tenantDataBrokerRollbackError"[\s\S]*?"Initialize rollback stability attempts"/u,
    );
    expect(broker.match(/NumericGreaterThanEquals\s*=\s*15/gu)?.length ?? 0).toBeGreaterThanOrEqual(
      16,
    );
    expect(compute.match(/deregistration_delay\s*=\s*30/gu)).toHaveLength(3);
    expect(broker).toContain('TimeoutSeconds = 4200');
  });

  test('bootstrap remains a separately approved fixed zero-service broker', async () => {
    const [releaseControl, iam] = await Promise.all([
      readFile(join(root, 'infra', 'modules', 'platform', 'release-control.tf'), 'utf8'),
      readFile(join(root, 'infra', 'modules', 'platform', 'iam.tf'), 'utf8'),
    ]);
    const bootstrap = section(
      releaseControl,
      'resource "aws_sfn_state_machine" "bootstrap"',
      'resource "aws_sfn_state_machine"',
    );
    const operator = section(
      iam,
      'data "aws_iam_policy_document" "bootstrap_operator"',
      'resource "aws_iam_role_policy" "bootstrap_operator"',
    );

    expect(bootstrap).toContain('TaskDefinition = aws_ecs_task_definition.bootstrap.arn');
    expect(bootstrap).toContain('TaskDefinition = aws_ecs_task_definition.migration.arn');
    expect(bootstrap).toContain('Variable = "$.bootstrap.ExitCode", NumericEquals = 0');
    expect(bootstrap).toContain('Variable = "$.migration.ExitCode", NumericEquals = 0');
    expect(bootstrap).not.toContain('Overrides');
    expect(operator).toContain('aws_sfn_state_machine.bootstrap.arn');
    expect(operator).not.toMatch(/ecs:(?:RunTask|RegisterTaskDefinition)|iam:PassRole/u);
  });
});
