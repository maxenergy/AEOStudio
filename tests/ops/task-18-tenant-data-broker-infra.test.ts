import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();

async function text(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

function resource(source: string, type: string, name: string): string {
  const marker = `resource "${type}" "${name}"`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${marker}`);
  const nextResource = source.indexOf('\nresource "', start + marker.length);
  const nextData = source.indexOf('\ndata "', start + marker.length);
  const candidates = [nextResource, nextData].filter((index) => index >= 0);
  const end = candidates.length === 0 ? source.length : Math.min(...candidates);
  return source.slice(start, end);
}

function dataBlock(source: string, type: string, name: string): string {
  const marker = `data "${type}" "${name}"`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${marker}`);
  const nextResource = source.indexOf('\nresource "', start + marker.length);
  const nextData = source.indexOf('\ndata "', start + marker.length);
  const candidates = [nextResource, nextData].filter((index) => index >= 0);
  const end = candidates.length === 0 ? source.length : Math.min(...candidates);
  return source.slice(start, end);
}

function policyStatement(source: string, sid: string): string {
  const match = new RegExp(`sid\\s*=\\s*"${sid}"`, 'u').exec(source);
  if (match?.index === undefined) throw new Error(`Missing IAM statement ${sid}`);
  const start = match.index;
  const next = source.indexOf('\n  statement {', start + match[0].length);
  return source.slice(start, next < 0 ? source.length : next);
}

describe('Task 18 private Tenant Data Broker infrastructure', () => {
  test('admits only API and Worker through the internal ALB and gives Broker no Internet egress', async () => {
    const [network, data] = await Promise.all([
      text('infra/modules/platform/network.tf'),
      text('infra/modules/platform/data.tf'),
    ]);

    const internalAlb = resource(network, 'aws_security_group', 'internal_alb');
    const broker = resource(network, 'aws_security_group', 'tenant_data_broker');
    expect(internalAlb).not.toMatch(/cidr_blocks|0\.0\.0\.0\/0/u);
    expect(broker).not.toMatch(/cidr_blocks|0\.0\.0\.0\/0/u);

    for (const caller of ['api', 'worker']) {
      expect(network).toMatch(
        new RegExp(
          `resource "aws_vpc_security_group_ingress_rule" "internal_alb_https_from_${caller}"[\\s\\S]*?security_group_id\\s*=\\s*aws_security_group\\.internal_alb\\.id[\\s\\S]*?referenced_security_group_id\\s*=\\s*aws_security_group\\.${caller}\\.id[\\s\\S]*?from_port\\s*=\\s*443[\\s\\S]*?to_port\\s*=\\s*443`,
          'u',
        ),
      );
    }
    expect(network).toMatch(
      /resource "aws_vpc_security_group_ingress_rule" "tenant_data_broker_from_internal_alb"[\s\S]*?security_group_id\s*=\s*aws_security_group\.tenant_data_broker\.id[\s\S]*?referenced_security_group_id\s*=\s*aws_security_group\.internal_alb\.id[\s\S]*?from_port\s*=\s*3300[\s\S]*?to_port\s*=\s*3300/u,
    );

    expect(network).toMatch(
      /resource "aws_vpc_security_group_egress_rule" "tenant_data_broker_to_database"[\s\S]*?referenced_security_group_id\s*=\s*aws_security_group\.database\.id[\s\S]*?from_port\s*=\s*5432[\s\S]*?to_port\s*=\s*5432/u,
    );
    expect(network).toMatch(
      /resource "aws_vpc_security_group_egress_rule" "tenant_data_broker_to_endpoints"[\s\S]*?referenced_security_group_id\s*=\s*aws_security_group\.aws_endpoints\.id[\s\S]*?from_port\s*=\s*443[\s\S]*?to_port\s*=\s*443/u,
    );
    expect(network).toMatch(
      /resource "aws_vpc_security_group_egress_rule" "tenant_data_broker_to_s3"[\s\S]*?prefix_list_id\s*=\s*data\.aws_prefix_list\.s3\.id[\s\S]*?from_port\s*=\s*443[\s\S]*?to_port\s*=\s*443/u,
    );
    const brokerEgress = [
      ...network.matchAll(
        /resource "aws_vpc_security_group_egress_rule" "tenant_data_broker_[^"]+"[\s\S]*?(?=\nresource |\s*$)/gu,
      ),
    ]
      .map((match) => match[0])
      .join('\n');
    expect(brokerEgress).not.toMatch(/cidr_ipv4|cidr_ipv6|0\.0\.0\.0\/0|::\/0/u);

    expect(data).toMatch(
      /resource "aws_security_group" "database"[\s\S]*?aws_security_group\.tenant_data_broker\.id/u,
    );
  });

  test('uses private AWS endpoints for every Broker dependency', async () => {
    const network = await text('infra/modules/platform/network.tf');
    for (const service of [
      'ecr.api',
      'ecr.dkr',
      'logs',
      'secretsmanager',
      'kms',
      'xray',
      'monitoring',
    ]) {
      expect(network).toContain(`"${service}"`);
    }
    expect(network).toMatch(
      /resource "aws_vpc_endpoint" "interface"[\s\S]*?vpc_endpoint_type\s*=\s*"Interface"[\s\S]*?private_dns_enabled\s*=\s*true[\s\S]*?subnet_ids\s*=\s*aws_subnet\.private\[\*\]\.id/u,
    );
    expect(network).toMatch(
      /resource "aws_vpc_endpoint" "s3"[\s\S]*?vpc_endpoint_type\s*=\s*"Gateway"[\s\S]*?route_table_ids\s*=\s*aws_route_table\.private\[\*\]\.id/u,
    );

    const endpoints = resource(network, 'aws_security_group', 'aws_endpoints');
    for (const task of ['web', 'api', 'worker', 'migration', 'tenant_data_broker']) {
      expect(endpoints).toContain(`aws_security_group.${task}.id`);
    }
    expect(endpoints).not.toMatch(/cidr_blocks|0\.0\.0\.0\/0/u);
  });

  test('keeps the public ALB and public DNS free of Broker routes and references', async () => {
    const [network, compute, dns] = await Promise.all([
      text('infra/modules/platform/network.tf'),
      text('infra/modules/platform/compute.tf'),
      text('infra/modules/platform/dns.tf'),
    ]);
    const publicAlbSg = resource(network, 'aws_security_group', 'alb');
    const publicAlb = resource(compute, 'aws_lb', 'main');
    const publicHttps = resource(compute, 'aws_lb_listener', 'https');
    const publicApiRule = resource(compute, 'aws_lb_listener_rule', 'api');
    const publicDns = resource(dns, 'aws_route53_record', 'application');
    for (const publicSurface of [publicAlbSg, publicAlb, publicHttps, publicApiRule, publicDns]) {
      expect(publicSurface).not.toMatch(/tenant_data_broker|tenant-data-broker|\/internal\//u);
    }
  });

  test('fails closed for every internal path on the public listener', async () => {
    const compute = await text('infra/modules/platform/compute.tf');
    const deny = resource(compute, 'aws_lb_listener_rule', 'deny_public_internal');
    expect(deny).toMatch(/listener_arn\s*=\s*aws_lb_listener\.https\.arn[\s\S]*?priority\s*=\s*1/u);
    expect(deny).toMatch(
      /type\s*=\s*"fixed-response"[\s\S]*?status_code\s*=\s*"404"[\s\S]*?values\s*=\s*\["\/internal\/\*"\]/u,
    );
    expect(deny).not.toMatch(/type\s*=\s*"forward"|target_group_arn/u);
  });

  test('terminates independently validated TLS on a private two-AZ Broker ALB', async () => {
    const [dns, compute] = await Promise.all([
      text('infra/modules/platform/dns.tf'),
      text('infra/modules/platform/compute.tf'),
    ]);
    const certificate = resource(dns, 'aws_acm_certificate', 'tenant_data_broker');
    const privateZone = resource(dns, 'aws_route53_zone', 'tenant_data_broker_private');
    const privateAlias = resource(dns, 'aws_route53_record', 'tenant_data_broker_private');
    const loadBalancer = resource(compute, 'aws_lb', 'tenant_data_broker');
    const target = resource(compute, 'aws_lb_target_group', 'tenant_data_broker');
    const listener = resource(compute, 'aws_lb_listener', 'tenant_data_broker_https');

    expect(certificate).toMatch(
      /domain_name\s*=\s*local\.tenant_data_broker_hostname[\s\S]*?validation_method\s*=\s*"DNS"/u,
    );
    expect(dns).toMatch(
      /resource "aws_route53_record" "tenant_data_broker_certificate_validation"[\s\S]*?zone_id\s*=\s*var\.route53_zone_id/u,
    );
    expect(dns).toMatch(
      /resource "aws_acm_certificate_validation" "tenant_data_broker"[\s\S]*?aws_route53_record\.tenant_data_broker_certificate_validation/u,
    );
    expect(privateZone).toMatch(
      /name\s*=\s*local\.tenant_data_broker_hostname[\s\S]*?vpc_id\s*=\s*aws_vpc\.main\.id/u,
    );
    expect(privateAlias).toMatch(
      /zone_id\s*=\s*aws_route53_zone\.tenant_data_broker_private\.zone_id[\s\S]*?name\s*=\s*local\.tenant_data_broker_hostname[\s\S]*?type\s*=\s*"A"[\s\S]*?name\s*=\s*aws_lb\.tenant_data_broker\.dns_name/u,
    );

    expect(loadBalancer).toMatch(
      /internal\s*=\s*true[\s\S]*?security_groups\s*=\s*\[aws_security_group\.internal_alb\.id\][\s\S]*?subnets\s*=\s*aws_subnet\.private\[\*\]\.id/u,
    );
    expect(target).toMatch(
      /port\s*=\s*3300[\s\S]*?protocol\s*=\s*"HTTP"[\s\S]*?target_type\s*=\s*"ip"[\s\S]*?path\s*=\s*"\/internal\/healthz"/u,
    );
    expect(listener).toMatch(
      /port\s*=\s*443[\s\S]*?protocol\s*=\s*"HTTPS"[\s\S]*?ssl_policy\s*=\s*"ELBSecurityPolicy-TLS13-1-2-2021-06"[\s\S]*?aws_acm_certificate_validation\.tenant_data_broker/u,
    );
    expect(listener).toMatch(
      /default_action[\s\S]*?type\s*=\s*"fixed-response"[\s\S]*?status_code\s*=\s*"404"/u,
    );
    expect(listener).not.toMatch(/default_action[\s\S]*?target_group_arn/u);
    const brokerApiRule = resource(compute, 'aws_lb_listener_rule', 'tenant_data_broker_api');
    const brokerHealthRule = resource(compute, 'aws_lb_listener_rule', 'tenant_data_broker_health');
    expect(brokerApiRule).toMatch(
      /target_group_arn\s*=\s*aws_lb_target_group\.tenant_data_broker\.arn[\s\S]*?values\s*=\s*\["\/internal\/v1\/tenant-data"\][\s\S]*?values\s*=\s*\["POST"\]/u,
    );
    expect(brokerHealthRule).toMatch(
      /target_group_arn\s*=\s*aws_lb_target_group\.tenant_data_broker\.arn[\s\S]*?values\s*=\s*\["\/internal\/healthz"\][\s\S]*?values\s*=\s*\["GET"\]/u,
    );

    const publicAddressRecords = [
      ...dns.matchAll(/resource "aws_route53_record" "[^"]+"[\s\S]*?(?=\nresource |\s*$)/gu),
    ].filter(
      ([record]) =>
        /zone_id\s*=\s*var\.route53_zone_id/u.test(record) &&
        /type\s*=\s*"(?:A|AAAA)"/u.test(record),
    );
    expect(publicAddressRecords.map(([record]) => record).join('\n')).not.toMatch(
      /tenant_data_broker|broker\.\$\{var\.public_hostname\}/u,
    );
  });

  test('runs two private Broker tasks from the Worker digest with ADOT and exact mode', async () => {
    const compute = await text('infra/modules/platform/compute.tf');
    const task = resource(compute, 'aws_ecs_task_definition', 'tenant_data_broker');
    const service = resource(compute, 'aws_ecs_service', 'tenant_data_broker');
    const logGroup = resource(compute, 'aws_cloudwatch_log_group', 'tenant_data_broker');

    expect(logGroup).toContain('/tenant-data-broker');
    expect(task).toMatch(
      /execution_role_arn\s*=\s*aws_iam_role\.tenant_data_broker_execution\.arn/u,
    );
    expect(task).toMatch(/task_role_arn\s*=\s*aws_iam_role\.tenant_data_broker\.arn/u);
    expect(task).toContain(
      '"${data.aws_ecr_repository.worker.repository_url}@${var.worker_image_digest}"',
    );
    expect(task).toMatch(/name\s*=\s*"tenant-data-broker"/u);
    expect(task).toMatch(/containerPort\s*=\s*3300[\s\S]*?hostPort\s*=\s*3300/u);
    expect(task).toMatch(
      /name\s*=\s*"AEOSTUDIO_WORKER_MODE"[\s\S]{0,100}value\s*=\s*"tenant-data-broker"/u,
    );
    expect(task).toMatch(/name\s*=\s*"PORT"[\s\S]{0,100}value\s*=\s*"3300"/u);
    expect(task).toMatch(/name\s*=\s*"adot"[\s\S]*?image\s*=\s*local\.adot_private_image/u);
    expect(task).not.toMatch(/image\s*=\s*var\.adot_image/u);
    expect(task).toMatch(
      /name\s*=\s*"TENANT_DATA_BROKER_DATABASE_URL"[\s\S]{0,140}aws_secretsmanager_secret\.tenant_data_broker_database_url\.arn/u,
    );
    expect(task).toMatch(
      /name\s*=\s*"TENANT_DATA_BROKER_HMAC_KEY_RING"[\s\S]{0,140}aws_secretsmanager_secret\.tenant_data_broker_hmac_key_ring\.arn/u,
    );

    expect(service).toMatch(/desired_count\s*=\s*var\.bootstrap_complete\s*\?\s*2\s*:\s*0/u);
    expect(service).toMatch(
      /subnets\s*=\s*aws_subnet\.private\[\*\]\.id[\s\S]*?security_groups\s*=\s*\[aws_security_group\.tenant_data_broker\.id\][\s\S]*?assign_public_ip\s*=\s*false/u,
    );
    expect(service).toMatch(
      /target_group_arn\s*=\s*aws_lb_target_group\.tenant_data_broker\.arn[\s\S]*?container_name\s*=\s*"tenant-data-broker"[\s\S]*?container_port\s*=\s*3300/u,
    );
  });

  test('configures API and Worker to call only the private signed Broker endpoint', async () => {
    const compute = await text('infra/modules/platform/compute.tf');
    for (const taskName of ['api', 'worker']) {
      const task = resource(compute, 'aws_ecs_task_definition', taskName);
      expect(task).toMatch(
        /name\s*=\s*"TENANT_DATA_BROKER_ENDPOINT"[\s\S]{0,120}local\.tenant_data_broker_endpoint/u,
      );
      expect(task).toMatch(
        /name\s*=\s*"TENANT_DATA_BROKER_AUDIENCE"[\s\S]{0,120}local\.tenant_data_broker_hostname/u,
      );
      expect(task).toMatch(
        /name\s*=\s*"TENANT_DATA_BROKER_HMAC_KEY_RING"[\s\S]{0,160}aws_secretsmanager_secret\.tenant_data_broker_hmac_key_ring\.arn/u,
      );
    }
  });

  test('precreates empty Broker database and versioned HMAC secrets without Terraform values', async () => {
    const identity = await text('infra/modules/platform/identity.tf');
    const databaseSecret = resource(
      identity,
      'aws_secretsmanager_secret',
      'tenant_data_broker_database_url',
    );
    const keyRingSecret = resource(
      identity,
      'aws_secretsmanager_secret',
      'tenant_data_broker_hmac_key_ring',
    );

    expect(databaseSecret).toContain('/tenant_data_broker_database_url');
    expect(keyRingSecret).toContain('/tenant_data_broker_hmac_key_ring');
    expect(keyRingSecret).toMatch(
      /SecretSchema\s*=\s*"aeostudio\.tenant-data-broker-key-ring\.v1"/u,
    );
    expect(identity).not.toMatch(
      /aws_secretsmanager_secret_version|random_password|secret_string\s*=/u,
    );
  });

  test('passes Broker secret targets to the one-time bootstrap without secret material in Terraform', async () => {
    const [compute, validator] = await Promise.all([
      text('infra/modules/platform/compute.tf'),
      text('scripts/bootstrap/run-bootstrap.mjs'),
    ]);
    const bootstrap = resource(compute, 'aws_ecs_task_definition', 'bootstrap');

    expect(bootstrap).toMatch(
      /name\s*=\s*"TENANT_DATA_BROKER_DATABASE_URL_SECRET_ARN"[\s\S]{0,180}aws_secretsmanager_secret\.tenant_data_broker_database_url\.arn/u,
    );
    expect(bootstrap).toMatch(
      /name\s*=\s*"TENANT_DATA_BROKER_HMAC_KEY_RING_SECRET_ARN"[\s\S]{0,180}aws_secretsmanager_secret\.tenant_data_broker_hmac_key_ring\.arn/u,
    );
    expect(validator).toContain(
      "['TENANT_DATA_BROKER_DATABASE_URL_SECRET_ARN', 'tenant_data_broker_database_url']",
    );
    expect(validator).toContain(
      "['TENANT_DATA_BROKER_HMAC_KEY_RING_SECRET_ARN', 'tenant_data_broker_hmac_key_ring']",
    );
    expect(validator).toContain('environmentValues.size === 13');
  });

  test('uses distinct Broker execution and runtime roles with exact secret injection', async () => {
    const iam = await text('infra/modules/platform/iam.tf');
    expect(iam).toContain('resource "aws_iam_role" "tenant_data_broker_execution"');
    expect(iam).toContain('resource "aws_iam_role" "tenant_data_broker"');
    expect(iam).toMatch(
      /for_each\s*=\s*\{[\s\S]*?broker\s*=\s*aws_iam_role\.tenant_data_broker_execution\.name/u,
    );

    const brokerExecution = dataBlock(
      iam,
      'aws_iam_policy_document',
      'tenant_data_broker_execution_secrets',
    );
    expect(brokerExecution).toContain(
      'aws_secretsmanager_secret.tenant_data_broker_database_url.arn',
    );
    expect(brokerExecution).toContain(
      'aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn',
    );
    expect(brokerExecution).not.toMatch(
      /runtime_database_url|lifecycle_database_url|admin_database_url|session_encryption_key|deletion_receipt/u,
    );

    for (const sharedExecution of ['api_execution_secrets', 'worker_execution_secrets']) {
      const policy = dataBlock(iam, 'aws_iam_policy_document', sharedExecution);
      expect(policy).toContain('aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn');
      expect(policy).not.toContain('aws_secretsmanager_secret.tenant_data_broker_database_url.arn');
    }
  });

  test('gives only the Broker exact tenant S3 Secrets and service-bound KMS capabilities', async () => {
    const iam = await text('infra/modules/platform/iam.tf');
    const broker = dataBlock(iam, 'aws_iam_policy_document', 'tenant_data_broker_runtime');

    for (const action of [
      's3:ListBucketVersions',
      's3:AbortMultipartUpload',
      's3:ListMultipartUploadParts',
      'secretsmanager:GetSecretValue',
      'secretsmanager:DescribeSecret',
      'secretsmanager:DeleteSecret',
      'kms:Decrypt',
      'kms:Encrypt',
      'kms:GenerateDataKey',
    ]) {
      expect(broker).toContain(action);
    }
    expect(broker).toContain('${aws_s3_bucket.artifacts.arn}/tenants/*/workspaces/*');
    expect(broker).toContain('${aws_s3_bucket.artifacts.arn}/tenants/*/exports/*');
    expect(broker).toContain('${aws_s3_bucket.audit_evidence.arn}/tenants/*/audit-digests/*');
    const artifactListing = policyStatement(broker, 'ListExactTenantArtifactVersions');
    expect(artifactListing).toContain('aws_s3_bucket.artifacts.arn');
    expect(artifactListing).toContain('"tenants/*/workspaces/*"');
    expect(artifactListing).toContain('"tenants/*/exports/*"');
    expect(artifactListing).not.toMatch(/audit_evidence|audit-digests/u);
    const auditListing = policyStatement(broker, 'ListExactTenantAuditVersions');
    expect(auditListing).toContain('aws_s3_bucket.audit_evidence.arn');
    expect(auditListing).toContain('"tenants/*/audit-digests/*"');
    expect(auditListing).not.toMatch(/artifacts|workspaces|exports/u);
    expect(broker).toContain(
      'arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:tenant-*',
    );
    const tenantSecrets = policyStatement(broker, 'ManageExactTenantSecrets');
    expect(
      [...tenantSecrets.matchAll(/"(secretsmanager:[A-Za-z]+)"/gu)].map((match) => match[1]).sort(),
    ).toEqual(
      [
        'secretsmanager:DeleteSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
      ].sort(),
    );
    expect(broker).toMatch(
      /kms:ViaService[\s\S]*?s3\.\$\{var\.region\}\.amazonaws\.com[\s\S]*?kms:CallerAccount[\s\S]*?kms:EncryptionContext:aws:s3:arn/u,
    );
    const s3Kms = policyStatement(broker, 'UseTenantObjectDataKeyViaS3');
    const s3EncryptionContext = s3Kms.slice(
      s3Kms.indexOf('variable = "kms:EncryptionContext:aws:s3:arn"'),
    );
    expect(s3EncryptionContext).toContain('aws_s3_bucket.artifacts.arn');
    expect(s3EncryptionContext).toContain('aws_s3_bucket.audit_evidence.arn');
    expect(s3EncryptionContext).not.toMatch(/tenants\/|workspaces\/|exports\/|audit-digests\/|\*/u);
    expect(broker).toMatch(
      /kms:ViaService[\s\S]*?secretsmanager\.\$\{var\.region\}\.amazonaws\.com[\s\S]*?kms:CallerAccount[\s\S]*?kms:EncryptionContext:SecretARN/u,
    );
    expect(broker).not.toMatch(/sts:|AdministratorAccess|PowerUserAccess|actions\s*=\s*\[\s*"\*"/u);
  });

  test('forces exact KMS encryption on Broker puts and separates read delete and multipart powers', async () => {
    const [iam, storage] = await Promise.all([
      text('infra/modules/platform/iam.tf'),
      text('infra/modules/platform/storage.tf'),
    ]);
    const broker = dataBlock(iam, 'aws_iam_policy_document', 'tenant_data_broker_runtime');
    const actions = (statement: string) =>
      [...statement.matchAll(/"(s3:[A-Za-z]+)"/gu)].map((match) => match[1]).sort();

    const put = policyStatement(broker, 'PutExactTenantObjectsWithKms');
    expect(actions(put)).toEqual(['s3:PutObject']);
    expect(put).toMatch(/s3:x-amz-server-side-encryption"[\s\S]*?values\s*=\s*\["aws:kms"\]/u);
    expect(put).toMatch(
      /s3:x-amz-server-side-encryption-aws-kms-key-id"[\s\S]*?values\s*=\s*\[aws_kms_key\.data\.arn\]/u,
    );
    expect(put).toMatch(
      /s3:x-amz-server-side-encryption-bucket-key-enabled"[\s\S]*?values\s*=\s*\["true"\]/u,
    );

    expect(actions(policyStatement(broker, 'ReadExactTenantObjects'))).toEqual(
      [
        's3:GetObject',
        's3:GetObjectLegalHold',
        's3:GetObjectRetention',
        's3:GetObjectTagging',
        's3:GetObjectVersion',
      ].sort(),
    );
    expect(actions(policyStatement(broker, 'DeleteExactTenantObjects'))).toEqual(
      ['s3:DeleteObject', 's3:DeleteObjectVersion'].sort(),
    );
    expect(broker).not.toContain('s3:BypassGovernanceRetention');
    expect(actions(policyStatement(broker, 'ManageExactTenantMultipartUploads'))).toEqual(
      ['s3:AbortMultipartUpload', 's3:ListMultipartUploadParts'].sort(),
    );

    expect(storage).toContain('data "aws_iam_policy_document" "tenant_data_kms_enforcement"');
    expect(storage).toContain('resource "aws_s3_bucket_policy" "tenant_data_kms_enforcement"');
    for (const condition of [
      's3:x-amz-server-side-encryption',
      's3:x-amz-server-side-encryption-aws-kms-key-id',
      's3:x-amz-server-side-encryption-bucket-key-enabled',
    ]) {
      expect(storage).toContain(condition);
    }
    expect(storage).toContain('aws_kms_key.data.arn');
  });

  test('explicitly denies shared API and Worker every Broker data action including multipart work', async () => {
    const iam = await text('infra/modules/platform/iam.tf');
    for (const sharedPolicy of ['api_runtime', 'worker_runtime']) {
      const policy = dataBlock(iam, 'aws_iam_policy_document', sharedPolicy);
      for (const denied of [
        's3:AbortMultipartUpload',
        's3:ListMultipartUploadParts',
        's3:ListBucketMultipartUploads',
        'secretsmanager:ListSecretVersionIds',
        'secretsmanager:PutSecretValue',
      ]) {
        expect(policy).toContain(denied);
      }
      expect(policy).toMatch(/sid\s*=\s*"DenyDirectTenantDataKeyUse"[\s\S]*?effect\s*=\s*"Deny"/u);
    }
  });
});
