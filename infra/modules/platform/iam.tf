data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-web-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role" "api_execution" {
  name               = "${local.name}-api-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role" "worker_execution" {
  name               = "${local.name}-worker-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role" "tenant_data_broker_execution" {
  name               = "${local.name}-tenant-data-broker-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role" "migration_execution" {
  name               = "${local.name}-migration-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role" "bootstrap_execution" {
  name               = "${local.name}-bootstrap-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each = {
    web       = aws_iam_role.execution.name
    api       = aws_iam_role.api_execution.name
    bootstrap = aws_iam_role.bootstrap_execution.name
    worker    = aws_iam_role.worker_execution.name
    migration = aws_iam_role.migration_execution.name
    broker    = aws_iam_role.tenant_data_broker_execution.name
  }

  role       = each.value
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "web" {
  name               = "${local.name}-web-runtime"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role" "api" {
  name               = "${local.name}-api-runtime"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role" "worker" {
  name               = "${local.name}-worker-runtime"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role" "tenant_data_broker" {
  name               = "${local.name}-tenant-data-broker-runtime"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role" "migration" {
  name               = "${local.name}-migration-runtime"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role" "bootstrap" {
  name               = "${local.name}-bootstrap-runtime"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "api_execution_secrets" {
  statement {
    sid     = "InjectApiSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.runtime_database_url.arn,
      aws_secretsmanager_secret.session_encryption_key.arn,
      aws_secretsmanager_secret.deletion_receipt_signing_key.arn,
      aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn,
    ]
  }

  statement {
    sid       = "DecryptApiSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "api_execution_secrets" {
  name   = "${local.name}-api-secret-injection"
  role   = aws_iam_role.api_execution.id
  policy = data.aws_iam_policy_document.api_execution_secrets.json
}

data "aws_iam_policy_document" "worker_execution_secrets" {
  statement {
    sid     = "InjectWorkerSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.runtime_database_url.arn,
      aws_secretsmanager_secret.lifecycle_database_url.arn,
      aws_secretsmanager_secret.session_encryption_key.arn,
      aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn,
    ]
  }

  statement {
    sid       = "DecryptWorkerSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "worker_execution_secrets" {
  name   = "${local.name}-worker-secret-injection"
  role   = aws_iam_role.worker_execution.id
  policy = data.aws_iam_policy_document.worker_execution_secrets.json
}

data "aws_iam_policy_document" "tenant_data_broker_execution_secrets" {
  statement {
    sid     = "InjectExactTenantDataBrokerSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.tenant_data_broker_database_url.arn,
      aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn,
    ]
  }

  statement {
    sid       = "DecryptExactTenantDataBrokerSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "tenant_data_broker_execution_secrets" {
  name   = "${local.name}-tenant-data-broker-secret-injection"
  role   = aws_iam_role.tenant_data_broker_execution.id
  policy = data.aws_iam_policy_document.tenant_data_broker_execution_secrets.json
}

data "aws_iam_policy_document" "migration_execution_secrets" {
  statement {
    sid       = "InjectMigrationSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.admin_database_url.arn]
  }

  statement {
    sid       = "DecryptMigrationSecret"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "migration_execution_secrets" {
  name   = "${local.name}-migration-secret-injection"
  role   = aws_iam_role.migration_execution.id
  policy = data.aws_iam_policy_document.migration_execution_secrets.json
}

data "aws_iam_policy_document" "bootstrap_runtime" {
  statement {
    sid       = "ReadRdsManagedMasterSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }

  statement {
    sid    = "ReadAndSeedPrecreatedBootstrapSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
    ]
    resources = [
      aws_secretsmanager_secret.runtime_database_url.arn,
      aws_secretsmanager_secret.lifecycle_database_url.arn,
      aws_secretsmanager_secret.admin_database_url.arn,
      aws_secretsmanager_secret.tenant_data_broker_database_url.arn,
      aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn,
      aws_secretsmanager_secret.session_encryption_key.arn,
      aws_secretsmanager_secret.deletion_receipt_signing_key.arn,
    ]
  }

  statement {
    sid    = "UseExactSecretsKey"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "bootstrap_runtime" {
  name   = "${local.name}-bootstrap-runtime"
  role   = aws_iam_role.bootstrap.id
  policy = data.aws_iam_policy_document.bootstrap_runtime.json
}

data "aws_iam_policy_document" "api_runtime" {
  statement {
    sid    = "DenyDirectTenantDataAccess"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:GetObjectLegalHold",
      "s3:GetObjectRetention",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:PutObjectLegalHold",
      "s3:PutObjectRetention",
      "s3:PutObjectTagging",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
      "s3:ListBucketMultipartUploads",
      "s3:ListBucketVersions",
    ]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
      aws_s3_bucket.audit_evidence.arn,
      "${aws_s3_bucket.audit_evidence.arn}/*",
    ]
  }

  statement {
    sid    = "DenyDirectTenantSecretAccess"
    effect = "Deny"
    actions = [
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:ListSecretVersionIds",
      "secretsmanager:PutSecretValue",
      "secretsmanager:RestoreSecret",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
    ]
    resources = ["arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:tenant-*"]
  }

  statement {
    sid    = "DenyDirectTenantDataKeyUse"
    effect = "Deny"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.data.arn, aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "api_runtime" {
  name   = "${local.name}-api-runtime"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_runtime.json
}

data "aws_iam_policy_document" "worker_runtime" {
  statement {
    sid    = "DenyDirectTenantSecretAccess"
    effect = "Deny"
    actions = [
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:ListSecretVersionIds",
      "secretsmanager:PutSecretValue",
      "secretsmanager:RestoreSecret",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
    ]
    resources = ["arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:tenant-*"]
  }

  statement {
    sid    = "RelayWorkloadJobs"
    effect = "Allow"
    actions = [
      "sqs:GetQueueAttributes",
      "sqs:SendMessage",
    ]
    resources = [
      aws_sqs_queue.crawl.arn,
      aws_sqs_queue.generation.arn,
      aws_sqs_queue.publish.arn,
      aws_sqs_queue.measurement.arn,
    ]
  }

  statement {
    sid    = "ConsumeWorkloadJobs"
    effect = "Allow"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]
    resources = [
      aws_sqs_queue.crawl.arn,
      aws_sqs_queue.generation.arn,
      aws_sqs_queue.publish.arn,
      aws_sqs_queue.measurement.arn,
    ]
  }

  statement {
    sid    = "DenyDirectTenantObjectAccess"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:GetObjectLegalHold",
      "s3:GetObjectRetention",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:PutObjectLegalHold",
      "s3:PutObjectTagging",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
      "s3:ListBucketMultipartUploads",
      "s3:ListBucketVersions",
      "s3:PutObjectRetention",
    ]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
      aws_s3_bucket.audit_evidence.arn,
      "${aws_s3_bucket.audit_evidence.arn}/*",
    ]
  }

  statement {
    sid    = "VerifyBackupDeletion"
    effect = "Allow"
    actions = [
      "backup:ListRecoveryPointsByResource",
      "rds:DescribeDBInstanceAutomatedBackups",
      "rds:DescribeDBInstances",
      "rds:DescribeDBSnapshots",
    ]
    # AWS list/describe actions do not support resource-level IAM scoping. Runtime
    # responses are fail-closed against the exact account, Region, and resource ARNs.
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }

  statement {
    sid    = "DenyDirectTenantDataKeyUse"
    effect = "Deny"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.data.arn, aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "worker_runtime" {
  name   = "${local.name}-worker-runtime"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_runtime.json
}

data "aws_iam_policy_document" "tenant_data_broker_runtime" {
  statement {
    sid    = "ListExactTenantArtifactVersions"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:ListBucketVersions",
    ]
    resources = [aws_s3_bucket.artifacts.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        "tenants/*/workspaces/*",
        "tenants/*/exports/*",
      ]
    }
  }

  statement {
    sid    = "ListExactTenantAuditVersions"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:ListBucketVersions",
    ]
    resources = [aws_s3_bucket.audit_evidence.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["tenants/*/audit-digests/*"]
    }
  }

  statement {
    sid     = "PutExactTenantObjectsWithKms"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.artifacts.arn}/tenants/*/workspaces/*",
      "${aws_s3_bucket.artifacts.arn}/tenants/*/exports/*",
      "${aws_s3_bucket.audit_evidence.arn}/tenants/*/audit-digests/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.data.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-server-side-encryption-bucket-key-enabled"
      values   = ["true"]
    }
  }

  statement {
    sid    = "ReadExactTenantObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectLegalHold",
      "s3:GetObjectRetention",
      "s3:GetObjectTagging",
      "s3:GetObjectVersion",
    ]
    resources = [
      "${aws_s3_bucket.artifacts.arn}/tenants/*/workspaces/*",
      "${aws_s3_bucket.artifacts.arn}/tenants/*/exports/*",
      "${aws_s3_bucket.audit_evidence.arn}/tenants/*/audit-digests/*",
    ]
  }

  statement {
    sid    = "DeleteExactTenantObjects"
    effect = "Allow"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = [
      "${aws_s3_bucket.artifacts.arn}/tenants/*/workspaces/*",
      "${aws_s3_bucket.artifacts.arn}/tenants/*/exports/*",
      "${aws_s3_bucket.audit_evidence.arn}/tenants/*/audit-digests/*",
    ]
  }

  statement {
    sid    = "ManageExactTenantMultipartUploads"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = [
      "${aws_s3_bucket.artifacts.arn}/tenants/*/workspaces/*",
      "${aws_s3_bucket.artifacts.arn}/tenants/*/exports/*",
      "${aws_s3_bucket.audit_evidence.arn}/tenants/*/audit-digests/*",
    ]
  }

  statement {
    sid    = "ManageExactTenantObjectMetadata"
    effect = "Allow"
    actions = [
      "s3:PutObjectLegalHold",
      "s3:PutObjectRetention",
      "s3:PutObjectTagging",
    ]
    resources = [
      "${aws_s3_bucket.artifacts.arn}/tenants/*/workspaces/*",
      "${aws_s3_bucket.artifacts.arn}/tenants/*/exports/*",
      "${aws_s3_bucket.audit_evidence.arn}/tenants/*/audit-digests/*",
    ]
  }

  statement {
    sid    = "ManageExactTenantSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
    ]
    resources = [
      "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:tenant-*",
    ]
  }

  statement {
    sid    = "UseTenantObjectDataKeyViaS3"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.data.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values = [
        aws_s3_bucket.artifacts.arn,
        aws_s3_bucket.audit_evidence.arn,
      ]
    }
  }

  statement {
    sid    = "UseTenantSecretDataKeyViaSecretsManager"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
    ]
    resources = [aws_kms_key.secrets.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:SecretARN"
      values   = ["arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:tenant-*"]
    }
  }
}

resource "aws_iam_role_policy" "tenant_data_broker_runtime" {
  name   = "${local.name}-tenant-data-broker-runtime"
  role   = aws_iam_role.tenant_data_broker.id
  policy = data.aws_iam_policy_document.tenant_data_broker_runtime.json
}

data "aws_iam_policy_document" "telemetry_runtime" {
  statement {
    sid    = "ExportTracesAndMetrics"
    effect = "Allow"
    actions = [
      "cloudwatch:PutMetricData",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "telemetry_runtime" {
  for_each = {
    web    = aws_iam_role.web.id
    api    = aws_iam_role.api.id
    worker = aws_iam_role.worker.id
    broker = aws_iam_role.tenant_data_broker.id
  }

  name   = "${local.name}-${each.key}-telemetry"
  role   = each.value
  policy = data.aws_iam_policy_document.telemetry_runtime.json
}

data "aws_iam_role" "deploy" {
  name = var.deploy_role_name
}

data "aws_iam_role" "bootstrap_operator" {
  name = var.bootstrap_operator_role_name
}

data "aws_iam_policy_document" "bootstrap_operator" {
  statement {
    sid       = "ReadExactReleaseContract"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.bootstrap_contract.arn]
  }

  statement {
    sid    = "InspectExactBootstrapTaskDefinitions"
    effect = "Allow"
    # ECS does not expose a resource type or condition key for
    # DescribeTaskDefinition in the AWS Service Authorization Reference.
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "StartExactBootstrapBroker"
    effect    = "Allow"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.bootstrap.arn]
  }

  statement {
    sid       = "ObserveBootstrapBrokerExecutions"
    effect    = "Allow"
    actions   = ["states:DescribeExecution"]
    resources = ["arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-bootstrap:*"]
  }
}

resource "aws_iam_role_policy" "bootstrap_operator" {
  name   = "${local.name}-bootstrap-operator"
  role   = data.aws_iam_role.bootstrap_operator.id
  policy = data.aws_iam_policy_document.bootstrap_operator.json
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid     = "ReadExactReleaseContract"
    effect  = "Allow"
    actions = ["ssm:GetParameter"]
    resources = [
      aws_ssm_parameter.release_contract.arn,
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/aeostudio/${var.environment}/releases/*",
    ]
  }

  statement {
    sid       = "AuthenticateToPrivateEcr"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "StartExactReleaseBroker"
    effect    = "Allow"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.release.arn]
  }

  statement {
    sid     = "ObserveReleaseBrokerExecutions"
    effect  = "Allow"
    actions = ["states:DescribeExecution"]
    resources = [
      "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:*",
      "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release-watchdog:*",
    ]
  }

  statement {
    sid       = "ReadExactReleaseCoordination"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.release_control.arn]
  }

  statement {
    sid    = "ReadTaskDefinitions"
    effect = "Allow"
    # ECS does not support resource-level authorization for this read action.
    # Runtime code still validates the returned family/revision ARN exactly.
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadExactTenantDataBrokerService"
    effect    = "Allow"
    actions   = ["ecs:DescribeServices"]
    resources = [aws_ecs_service.tenant_data_broker.id]
  }

  dynamic "statement" {
    for_each = var.environment == "production" ? [true] : []

    content {
      sid       = "ReadExactApiAndWebServices"
      effect    = "Allow"
      actions   = ["ecs:DescribeServices"]
      resources = [aws_ecs_service.api.id, aws_ecs_service.web.id]
    }
  }

  statement {
    sid       = "ListExactTenantDataBrokerTasks"
    effect    = "Allow"
    actions   = ["ecs:ListTasks"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid       = "DescribeExactTenantDataBrokerTasks"
    effect    = "Allow"
    actions   = ["ecs:DescribeTasks"]
    resources = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task/${local.name}/*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid       = "ReadExactTenantDataBrokerTargetHealth"
    effect    = "Allow"
    actions   = ["elasticloadbalancing:DescribeTargetHealth"]
    resources = [aws_lb_target_group.tenant_data_broker.arn]
  }

  dynamic "statement" {
    for_each = var.environment == "production" ? [true] : []

    content {
      sid     = "ReadExactApiAndWebTargetHealth"
      effect  = "Allow"
      actions = ["elasticloadbalancing:DescribeTargetHealth"]
      resources = [
        aws_lb_target_group.api.arn,
        aws_lb_target_group.web.arn,
      ]
    }
  }

  dynamic "statement" {
    for_each = var.environment == "production" ? [true] : []

    content {
      sid    = "DiscoverProductionPublicRoute"
      effect = "Allow"
      actions = [
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:DescribeRules",
        "elasticloadbalancing:DescribeTargetGroups",
      ]
      # These ELBv2 describe/list APIs do not support resource-level IAM scoping.
      resources = ["*"]

      condition {
        test     = "StringEquals"
        variable = "aws:RequestedRegion"
        values   = [var.region]
      }
    }
  }

  dynamic "statement" {
    for_each = var.environment == "production" ? [true] : []

    content {
      sid     = "DiscoverProductionHostedZones"
      effect  = "Allow"
      actions = ["route53:ListHostedZones"]
      # Route 53 ListHostedZones does not support resource-level IAM scoping.
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.environment == "production" ? [true] : []

    content {
      sid       = "ReadExactProductionRoute53Records"
      effect    = "Allow"
      actions   = ["route53:ListResourceRecordSets"]
      resources = ["arn:aws:route53:::hostedzone/${var.route53_zone_id}"]
    }
  }

  statement {
    sid    = "ReadPromotedImages"
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
    ]
    resources = [
      data.aws_ecr_repository.adot.arn,
      data.aws_ecr_repository.web.arn,
      data.aws_ecr_repository.api.arn,
      data.aws_ecr_repository.worker.arn,
    ]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "${local.name}-deploy"
  role   = data.aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
