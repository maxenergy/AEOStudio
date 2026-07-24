import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

// @ts-expect-error The security verifier is a native ESM JavaScript module.
import { verifyTrivyExceptionPolicy } from '../../scripts/security/trivy-exception-policy.mjs';

const root = resolve(import.meta.dirname, '../..');

describe('Task 18 Trivy exception and network-egress policy', () => {
  test('keeps only an exact, justified and unexpired ALB log-delivery exception', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- untyped ESM import
      verifyTrivyExceptionPolicy({
        repositoryRoot: root,
        now: new Date('2026-07-24T00:00:00.000Z'),
      }),
    ).not.toThrow();
  });

  test('rejects an expired, undeclared or wildcard inline ignore', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'aeostudio-trivy-policy-'));
    await mkdir(join(fixtureRoot, 'infra'), { recursive: true });
    await mkdir(join(fixtureRoot, 'scripts', 'security'), { recursive: true });
    await writeFile(
      join(fixtureRoot, 'scripts', 'security', 'trivy-exception-policy.json'),
      JSON.stringify({
        schemaVersion: 'aeostudio.trivy-exception-policy.v1',
        maximumLifetimeDays: 366,
        exceptions: [
          {
            id: 'AWS-0132',
            path: 'infra/storage.tf',
            resource: 'aws_s3_bucket_server_side_encryption_configuration.alb_logs',
            expiresOn: '2026-07-23',
            rationale: 'A sufficiently detailed compatibility rationale for the exact resource.',
            officialEvidence:
              'https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html',
          },
        ],
      }),
    );
    await writeFile(
      join(fixtureRoot, 'infra', 'storage.tf'),
      [
        '# trivy:ignore:*:exp:2026-07-23',
        'resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {}',
      ].join('\n'),
    );

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- untyped ESM import
      verifyTrivyExceptionPolicy({
        repositoryRoot: fixtureRoot,
        now: new Date('2026-07-24T00:00:00.000Z'),
      }),
    ).toThrow(/TRIVY_EXCEPTION_(?:WILDCARD|EXPIRED|UNDECLARED)/u);
  });

  test('removes all-protocol public egress and gives private one-shot tasks exact destinations', async () => {
    const { readFile } = await import('node:fs/promises');
    const network = await readFile(
      join(root, 'infra', 'modules', 'platform', 'network.tf'),
      'utf8',
    );
    const restore = await readFile(
      join(root, 'infra', 'modules', 'platform', 'recovery-runner.tf'),
      'utf8',
    );

    for (const source of [network, restore]) {
      expect(source).not.toMatch(
        /egress\s*\{[\s\S]*?protocol\s*=\s*"-1"[\s\S]*?cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\][\s\S]*?\}/u,
      );
    }

    expect(network).toMatch(
      /resource "aws_vpc_security_group_egress_rule" "migration_to_database"[\s\S]*?referenced_security_group_id\s*=\s*aws_security_group\.database\.id[\s\S]*?from_port\s*=\s*5432[\s\S]*?to_port\s*=\s*5432/u,
    );
    expect(network).toMatch(
      /resource "aws_vpc_security_group_egress_rule" "migration_to_endpoints"[\s\S]*?referenced_security_group_id\s*=\s*aws_security_group\.aws_endpoints\.id[\s\S]*?from_port\s*=\s*443[\s\S]*?to_port\s*=\s*443/u,
    );
    expect(network).toMatch(
      /resource "aws_vpc_security_group_egress_rule" "migration_to_s3"[\s\S]*?prefix_list_id\s*=\s*data\.aws_prefix_list\.s3\.id[\s\S]*?from_port\s*=\s*443[\s\S]*?to_port\s*=\s*443/u,
    );
    expect(restore).toMatch(
      /resource "aws_vpc_security_group_egress_rule" "restore_drill_to_database"[\s\S]*?referenced_security_group_id\s*=\s*aws_security_group\.database\.id[\s\S]*?from_port\s*=\s*5432[\s\S]*?to_port\s*=\s*5432/u,
    );
    expect(restore).toMatch(
      /resource "aws_vpc_security_group_egress_rule" "restore_drill_to_endpoints"[\s\S]*?referenced_security_group_id\s*=\s*aws_security_group\.aws_endpoints\.id[\s\S]*?from_port\s*=\s*443[\s\S]*?to_port\s*=\s*443/u,
    );
    expect(restore).toMatch(
      /resource "aws_vpc_security_group_egress_rule" "restore_drill_to_s3"[\s\S]*?prefix_list_id\s*=\s*data\.aws_prefix_list\.s3\.id[\s\S]*?from_port\s*=\s*443[\s\S]*?to_port\s*=\s*443/u,
    );
  });
});
