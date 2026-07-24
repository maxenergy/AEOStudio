locals {
  restore_drill_enabled = var.environment == "staging"
}

data "aws_ecr_repository" "recovery" {
  count = local.restore_drill_enabled ? 1 : 0

  name = "aeostudio-recovery"
}

resource "aws_cloudwatch_log_group" "restore_drill" {
  count = local.restore_drill_enabled ? 1 : 0

  name              = "/ecs/${local.name}/restore-drill"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.data.arn
  tags              = merge(local.common_tags, { Purpose = "restore-drill" })
}

resource "aws_security_group" "restore_drill" {
  count = local.restore_drill_enabled ? 1 : 0

  name        = "${local.name}-restore-drill"
  description = "Private one-shot restore validation task without ingress"
  vpc_id      = aws_vpc.main.id

  tags = merge(local.common_tags, { Purpose = "restore-drill" })
}

resource "aws_vpc_security_group_egress_rule" "restore_drill_to_database" {
  count = local.restore_drill_enabled ? 1 : 0

  security_group_id            = aws_security_group.restore_drill[0].id
  referenced_security_group_id = aws_security_group.database.id
  description                  = "Restore validation task to the restored PostgreSQL endpoint"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "restore_drill_to_s3" {
  count = local.restore_drill_enabled ? 1 : 0

  security_group_id = aws_security_group.restore_drill[0].id
  prefix_list_id    = data.aws_prefix_list.s3.id
  description       = "Restore validation task to the regional S3 gateway"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "restore_drill_to_endpoints" {
  count = local.restore_drill_enabled ? 1 : 0

  security_group_id            = aws_security_group.restore_drill[0].id
  referenced_security_group_id = aws_security_group.aws_endpoints.id
  description                  = "Restore validation task to exact private AWS API endpoints"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_restore_drill" {
  count = local.restore_drill_enabled ? 1 : 0

  security_group_id            = aws_security_group.aws_endpoints.id
  referenced_security_group_id = aws_security_group.restore_drill[0].id
  description                  = "Private AWS API endpoints from the restore validation task"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_ingress_rule" "database_from_restore_drill" {
  count = local.restore_drill_enabled ? 1 : 0

  description                  = "PostgreSQL from the private restore validation task"
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.restore_drill[0].id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_s3_bucket" "restore_drill" {
  count = local.restore_drill_enabled ? 1 : 0

  bucket = "${local.name}-${data.aws_caller_identity.current.account_id}-restore-drill"
  tags   = merge(local.common_tags, { Purpose = "isolated-restore-destination" })
}

resource "aws_s3_bucket_public_access_block" "restore_drill" {
  count = local.restore_drill_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.restore_drill[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "restore_drill" {
  count = local.restore_drill_enabled ? 1 : 0

  bucket = aws_s3_bucket.restore_drill[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "restore_drill" {
  count = local.restore_drill_enabled ? 1 : 0

  bucket = aws_s3_bucket.restore_drill[0].id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.data.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "restore_drill" {
  count = local.restore_drill_enabled ? 1 : 0

  bucket = aws_s3_bucket.restore_drill[0].id

  rule {
    id     = "expire-isolated-restore-data"
    status = "Enabled"

    filter {}

    expiration {
      days = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.restore_drill]
}

resource "aws_ssm_parameter" "restore_drill_input" {
  count = local.restore_drill_enabled ? 1 : 0

  name        = "/aeostudio/staging/recovery/restore-drill-input"
  description = "Short-lived, non-secret marker and recovery-point contract prepared before a staging drill."
  type        = "String"
  value = jsonencode({
    schemaVersion = "aeostudio.restore-drill-input.v1"
    environment   = "staging"
    status        = "NOT_READY"
  })

  lifecycle {
    ignore_changes = [value]
  }

  tags = merge(local.common_tags, { Purpose = "restore-drill-input" })
}

data "aws_iam_policy_document" "restore_drill_ecs_assume" {
  count = local.restore_drill_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "restore_drill_execution" {
  count = local.restore_drill_enabled ? 1 : 0

  name               = "${local.name}-restore-drill-execution"
  assume_role_policy = data.aws_iam_policy_document.restore_drill_ecs_assume[0].json
  tags               = merge(local.common_tags, { Purpose = "restore-drill" })
}

resource "aws_iam_role" "restore_drill_task" {
  count = local.restore_drill_enabled ? 1 : 0

  name               = "${local.name}-restore-drill-task"
  assume_role_policy = data.aws_iam_policy_document.restore_drill_ecs_assume[0].json
  tags               = merge(local.common_tags, { Purpose = "restore-drill" })
}

data "aws_iam_policy_document" "restore_drill_execution" {
  count = local.restore_drill_enabled ? 1 : 0

  statement {
    sid       = "AuthenticateToPrivateEcr"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullExactRecoveryImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [data.aws_ecr_repository.recovery[0].arn]
  }

  statement {
    sid    = "WriteRestoreTaskLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.restore_drill[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "restore_drill_execution" {
  count = local.restore_drill_enabled ? 1 : 0

  name   = "${local.name}-restore-drill-execution"
  role   = aws_iam_role.restore_drill_execution[0].id
  policy = data.aws_iam_policy_document.restore_drill_execution[0].json
}

data "aws_iam_policy_document" "restore_drill_task" {
  count = local.restore_drill_enabled ? 1 : 0

  statement {
    sid       = "ReadPreparedRestoreInput"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.restore_drill_input[0].arn]
  }

  statement {
    sid       = "DescribeRdsRestoreState"
    effect    = "Allow"
    actions   = ["rds:DescribeDBInstances"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }

  statement {
    sid     = "RestoreOnlyTheStagingDatabase"
    effect  = "Allow"
    actions = ["rds:RestoreDBInstanceToPointInTime"]
    resources = [
      aws_db_instance.main.arn,
      "arn:aws:rds:${var.region}:${data.aws_caller_identity.current.account_id}:db:${local.name}-*-restore-drill",
    ]
  }

  statement {
    sid    = "RunAndObserveS3Restore"
    effect = "Allow"
    actions = [
      "backup:DescribeRecoveryPoint",
      "backup:DescribeRestoreJob",
      "backup:GetRecoveryPointRestoreMetadata",
      "backup:StartRestoreJob",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }

  statement {
    sid       = "ReadExactRestoreCredential"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }

  statement {
    sid       = "DecryptRestoreCredential"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }

  statement {
    sid     = "ListSourceAndDestinationVersions"
    effect  = "Allow"
    actions = ["s3:ListBucketVersions"]
    resources = [
      aws_s3_bucket.artifacts.arn,
      aws_s3_bucket.restore_drill[0].arn,
    ]
  }

  statement {
    sid     = "ReadSourceAndRestoredMarkers"
    effect  = "Allow"
    actions = ["s3:GetObjectVersion"]
    resources = [
      "${aws_s3_bucket.artifacts.arn}/*",
      "${aws_s3_bucket.restore_drill[0].arn}/*",
    ]
  }

  statement {
    sid       = "UseDataKeyForRestoreVerification"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "WriteOneImmutableEvidenceObject"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit_evidence.arn}/restore-drills/*"]

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
  }

  statement {
    sid       = "PassOnlyTheBackupRestoreRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.backup.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "restore_drill_task" {
  count = local.restore_drill_enabled ? 1 : 0

  name   = "${local.name}-restore-drill-task"
  role   = aws_iam_role.restore_drill_task[0].id
  policy = data.aws_iam_policy_document.restore_drill_task[0].json
}

data "aws_iam_policy_document" "restore_drill_broker_assume" {
  count = local.restore_drill_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-restore-drill"]
    }
  }
}

resource "aws_iam_role" "restore_drill_broker" {
  count = local.restore_drill_enabled ? 1 : 0

  name               = "${local.name}-restore-drill-broker"
  assume_role_policy = data.aws_iam_policy_document.restore_drill_broker_assume[0].json
  tags               = merge(local.common_tags, { Purpose = "restore-drill" })
}

data "aws_iam_policy_document" "restore_drill_broker" {
  count = local.restore_drill_enabled ? 1 : 0

  statement {
    sid       = "RunOnlyTheFixedRestoreTask"
    effect    = "Allow"
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.restore_drill[0].arn]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid    = "ObserveAndStopBrokerOwnedTasks"
    effect = "Allow"
    actions = [
      "ecs:DescribeTasks",
      "ecs:StopTask",
    ]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid     = "PassOnlyRestoreTaskRoles"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.restore_drill_execution[0].arn,
      aws_iam_role.restore_drill_task[0].arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid    = "ManageTheStepFunctionsEcsCompletionRule"
    effect = "Allow"
    actions = [
      "events:DescribeRule",
      "events:PutRule",
      "events:PutTargets",
    ]
    resources = ["arn:aws:events:${var.region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForECSTaskRule"]
  }
}

resource "aws_iam_role_policy" "restore_drill_broker" {
  count = local.restore_drill_enabled ? 1 : 0

  name   = "${local.name}-restore-drill-broker"
  role   = aws_iam_role.restore_drill_broker[0].id
  policy = data.aws_iam_policy_document.restore_drill_broker[0].json
}

resource "aws_ecs_task_definition" "restore_drill" {
  count = local.restore_drill_enabled ? 1 : 0

  family                   = "${local.name}-restore-drill"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.restore_drill_execution[0].arn
  task_role_arn            = aws_iam_role.restore_drill_task[0].arn
  skip_destroy             = true

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "restore-drill"
    image     = "${data.aws_ecr_repository.recovery[0].repository_url}@${var.recovery_image_digest}"
    essential = true
    environment = [
      { name = "AWS_REGION", value = var.region },
      { name = "AEO_SOURCE_DB_IDENTIFIER", value = aws_db_instance.main.identifier },
      { name = "AEO_RESTORE_DB_SUBNET_GROUP", value = aws_db_subnet_group.main.name },
      { name = "AEO_RESTORE_DB_PARAMETER_GROUP", value = aws_db_parameter_group.postgres18_tls.name },
      { name = "AEO_RESTORE_DB_SECURITY_GROUP", value = aws_security_group.database.id },
      { name = "AEO_RESTORE_DB_CREDENTIAL_SECRET_ARN", value = aws_db_instance.main.master_user_secret[0].secret_arn },
      { name = "AEO_RDS_CA_BUNDLE", value = "/opt/rds/global-bundle.pem" },
      { name = "AEO_RESTORE_DATABASE_NAME", value = aws_db_instance.main.db_name },
      { name = "AEO_BACKUP_VAULT_NAME", value = aws_backup_vault.main.name },
      { name = "AEO_BACKUP_RESTORE_ROLE_ARN", value = aws_iam_role.backup.arn },
      { name = "AEO_RESTORED_BUCKET", value = aws_s3_bucket.restore_drill[0].id },
      { name = "AEO_RESTORE_INPUT_PARAMETER", value = aws_ssm_parameter.restore_drill_input[0].name },
      { name = "AEO_RESTORE_EVIDENCE_BUCKET", value = aws_s3_bucket.audit_evidence.id },
      { name = "AEO_DATA_KMS_KEY_ARN", value = aws_kms_key.data.arn },
      { name = "AEO_RECOVERY_IMAGE_URI", value = "${data.aws_ecr_repository.recovery[0].repository_url}@${var.recovery_image_digest}" },
      { name = "AEO_RECOVERY_IMAGE_DIGEST", value = var.recovery_image_digest },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.restore_drill[0].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "restore"
      }
    }
  }])

  lifecycle {
    precondition {
      condition     = var.recovery_image_digest != null
      error_message = "Staging requires the exact recovery image digest."
    }
  }

  tags = merge(local.common_tags, { Purpose = "restore-drill" })
}

resource "aws_sfn_state_machine" "restore_drill" {
  count = local.restore_drill_enabled ? 1 : 0

  name     = "${local.name}-restore-drill"
  role_arn = aws_iam_role.restore_drill_broker[0].arn

  definition = jsonencode({
    Comment = "Run the one fixed staging restore task in private subnets with identity-only overrides"
    StartAt = "Validate restore request identity"
    States = {
      "Validate restore request identity" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.schemaVersion", StringEquals = "aeostudio.restore-drill-request.v1" },
            { Variable = "$.environment", StringEquals = "staging" },
            { Variable = "$.repository", IsPresent = true },
            { Variable = "$.sourceSha", IsPresent = true },
            { Variable = "$.runId", IsPresent = true },
            { Variable = "$.runAttempt", IsPresent = true },
            { Variable = "$.buildRunId", IsPresent = true },
            { Variable = "$.buildRunAttempt", IsPresent = true },
            { Variable = "$.recoveryImageDigest", StringEquals = var.recovery_image_digest },
          ]
          Next = "Run fixed private restore task"
        }]
        Default = "Restore request invalid"
      }
      "Run fixed private restore task" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 15000
        Parameters = {
          Cluster              = aws_ecs_cluster.main.arn
          TaskDefinition       = aws_ecs_task_definition.restore_drill[0].arn
          LaunchType           = "FARGATE"
          PlatformVersion      = "1.4.0"
          EnableExecuteCommand = false
          Overrides = {
            ContainerOverrides = [{
              Name = "restore-drill"
              Environment = [
                { Name = "AEO_RESTORE_REPOSITORY", "Value.$" = "$.repository" },
                { Name = "AEO_RESTORE_SOURCE_SHA", "Value.$" = "$.sourceSha" },
                { Name = "AEO_RESTORE_WORKFLOW_RUN_ID", "Value.$" = "$.runId" },
                { Name = "AEO_RESTORE_WORKFLOW_RUN_ATTEMPT", "Value.$" = "$.runAttempt" },
                { Name = "AEO_RECOVERY_BUILD_RUN_ID", "Value.$" = "$.buildRunId" },
                { Name = "AEO_RECOVERY_BUILD_RUN_ATTEMPT", "Value.$" = "$.buildRunAttempt" },
                { Name = "AEO_RESTORE_EXECUTION_ARN", "Value.$" = "$$.Execution.Id" },
              ]
            }]
          }
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              Subnets        = aws_subnet.private[*].id
              SecurityGroups = [aws_security_group.restore_drill[0].id]
              AssignPublicIp = "DISABLED"
            }
          }
        }
        Next = "Require successful restore container"
      }
      "Require successful restore container" = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.Containers[0].ExitCode"
          NumericEquals = 0
          Next          = "Restore evidence persisted"
          }, {
          Variable      = "$.containers[0].exitCode"
          NumericEquals = 0
          Next          = "Restore evidence persisted"
        }]
        Default = "Restore task failed"
      }
      "Restore evidence persisted" = {
        Type = "Succeed"
      }
      "Restore task failed" = {
        Type  = "Fail"
        Error = "RestoreDrillContainerFailed"
        Cause = "The fixed restore container exited non-zero after writing failure evidence."
      }
      "Restore request invalid" = {
        Type  = "Fail"
        Error = "RestoreDrillRequestInvalid"
        Cause = "The fixed restore broker requires a complete staging workflow identity."
      }
    }
  })

  tags = merge(local.common_tags, { Purpose = "restore-drill" })
}

data "aws_iam_role" "restore_drill_operator" {
  count = local.restore_drill_enabled ? 1 : 0

  name = var.restore_drill_operator_role_name
}

data "aws_iam_policy_document" "restore_drill_operator" {
  count = local.restore_drill_enabled ? 1 : 0

  statement {
    sid       = "StartFixedRestoreBroker"
    effect    = "Allow"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.restore_drill[0].arn]
  }

  statement {
    sid       = "ObserveRestoreBrokerExecution"
    effect    = "Allow"
    actions   = ["states:DescribeExecution"]
    resources = ["arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-restore-drill:*"]
  }

  statement {
    sid       = "ListImmutableRestoreEvidenceVersions"
    effect    = "Allow"
    actions   = ["s3:ListBucketVersions"]
    resources = [aws_s3_bucket.audit_evidence.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        "restore-drills/",
        "restore-drills/*",
      ]
    }
  }

  statement {
    sid    = "ReadImmutableRestoreEvidenceVersion"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = ["${aws_s3_bucket.audit_evidence.arn}/restore-drills/*"]
  }

  statement {
    sid       = "DecryptImmutableRestoreEvidenceThroughS3"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [aws_s3_bucket.audit_evidence.arn]
    }
  }
}

resource "aws_iam_role_policy" "restore_drill_operator" {
  count = local.restore_drill_enabled ? 1 : 0

  name   = "${local.name}-restore-drill-operator"
  role   = data.aws_iam_role.restore_drill_operator[0].id
  policy = data.aws_iam_policy_document.restore_drill_operator[0].json
}
