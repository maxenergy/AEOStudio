import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing source section: ${start}`);
  return source.slice(from, to);
}

describe('Task 18 tenant data-plane IAM boundary', () => {
  test('shared API and Worker roles hold no direct tenant object, secret, or data-key permissions', async () => {
    const iam = await readFile(join(root, 'infra', 'modules', 'platform', 'iam.tf'), 'utf8');
    const api = section(
      iam,
      'data "aws_iam_policy_document" "api_runtime"',
      'resource "aws_iam_role_policy" "api_runtime"',
    );
    const worker = section(
      iam,
      'data "aws_iam_policy_document" "worker_runtime"',
      'resource "aws_iam_role_policy" "worker_runtime"',
    );
    const directTenantDataAction =
      /(?:secretsmanager:(?:GetSecretValue|DeleteSecret|DescribeSecret)|s3:(?:GetObject|GetObjectVersion|PutObject|PutObjectTagging|PutObjectRetention|PutObjectLegalHold|GetObjectRetention|GetObjectLegalHold|DeleteObject|DeleteObjectVersion|ListBucketVersions)|kms:(?:Decrypt|Encrypt|GenerateDataKey))/u;
    const allowedStatements = (source: string) =>
      [...source.matchAll(/statement\s*\{[\s\S]*?\n\s{2}\}/gu)]
        .map((match) => match[0])
        .filter((statement) => /effect\s*=\s*"Allow"/u.test(statement))
        .join('\n');

    expect(allowedStatements(api)).not.toMatch(directTenantDataAction);
    expect(allowedStatements(worker)).not.toMatch(directTenantDataAction);
  });

  test('shared roles cannot mint caller-selected ABAC sessions and carry explicit non-overridable denies', async () => {
    const iam = await readFile(join(root, 'infra', 'modules', 'platform', 'iam.tf'), 'utf8');
    const api = section(
      iam,
      'data "aws_iam_policy_document" "api_runtime"',
      'resource "aws_iam_role_policy" "api_runtime"',
    );
    const worker = section(
      iam,
      'data "aws_iam_policy_document" "worker_runtime"',
      'resource "aws_iam_role_policy" "worker_runtime"',
    );

    for (const policy of [api, worker]) {
      expect(policy).not.toMatch(/sts:(?:AssumeRole|TagSession)/u);
      expect(policy).not.toMatch(/aws:ResourceTag\/(?:TenantId|WorkspaceId)/u);
      expect(policy).toMatch(
        /sid\s*=\s*"DenyDirectTenantSecretAccess"[\s\S]*?effect\s*=\s*"Deny"/u,
      );
      expect(policy).toMatch(/sid\s*=\s*"DenyDirectTenantDataKeyUse"[\s\S]*?effect\s*=\s*"Deny"/u);
    }
    expect(api).toMatch(/sid\s*=\s*"DenyDirectTenantDataAccess"[\s\S]*?effect\s*=\s*"Deny"/u);
    expect(worker).toMatch(/sid\s*=\s*"DenyDirectTenantObjectAccess"[\s\S]*?effect\s*=\s*"Deny"/u);
  });
});
