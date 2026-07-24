locals {
  # Step Functions JSONPath StringMatches supports only `*` as a wildcard.
  # Exact digest equality is enforced by the four fixed ECR BatchGetImage responses;
  # the client-side signed manifest verifier enforces the 40-hex source SHA.
  release_sha256_pattern  = "sha256:*"
  release_pointer_name    = "/aeostudio/${var.environment}/release-contract"
  bootstrap_contract_name = "/aeostudio/${var.environment}/bootstrap-contract"
  release_tags = concat([for key, value in local.common_tags : {
    Key   = key
    Value = value
    }], [{
    Key   = "aeostudio:attested"
    Value = "true"
  }])
  release_adot_container = {
    Name      = "adot"
    Image     = local.adot_private_image
    Essential = true
    Command   = ["--config=/etc/ecs/ecs-default-config.yaml"]
    Environment = [for entry in local.adot_environment : {
      Name  = entry.name
      Value = entry.value
    }]
    LogConfiguration = {
      LogDriver = "awslogs"
      Options = {
        "awslogs-group"         = aws_cloudwatch_log_group.adot.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "collector"
      }
    }
  }
  release_web_container = {
    Name      = "web"
    Essential = true
    PortMappings = [{
      ContainerPort = 3100
      HostPort      = 3100
      Protocol      = "tcp"
    }]
    Environment = [
      { Name = "NODE_ENV", Value = "production" },
      { Name = "NEXT_MANUAL_SIG_HANDLE", Value = "true" },
      { Name = "PORT", Value = "3100" },
      { Name = "API_INTERNAL_ORIGIN", Value = local.public_origin },
      { Name = "API_PUBLIC_ORIGIN", Value = local.public_origin },
      { Name = "WEB_ORIGIN", Value = local.public_origin },
      { Name = "OTEL_EXPORTER_OTLP_ENDPOINT", Value = "http://127.0.0.1:4318" },
    ]
    LogConfiguration = {
      LogDriver = "awslogs"
      Options = {
        "awslogs-group"         = aws_cloudwatch_log_group.web.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "web"
      }
    }
  }
  release_api_container = {
    Name      = "api"
    Essential = true
    PortMappings = [{
      ContainerPort = 3200
      HostPort      = 3200
      Protocol      = "tcp"
    }]
    Environment = [
      { Name = "NODE_ENV", Value = "production" },
      { Name = "PORT", Value = "3200" },
      { Name = "API_DATABASE_POOL_MAX", Value = "5" },
      { Name = "AWS_REGION", Value = var.region },
      { Name = "AWS_ACCOUNT_ID", Value = data.aws_caller_identity.current.account_id },
      { Name = "ARTIFACT_BUCKET", Value = aws_s3_bucket.artifacts.id },
      { Name = "AUDIT_EVIDENCE_BUCKET", Value = aws_s3_bucket.audit_evidence.id },
      { Name = "S3_KMS_KEY_ARN", Value = aws_kms_key.data.arn },
      { Name = "COGNITO_USER_POOL_ID", Value = aws_cognito_user_pool.main.id },
      { Name = "OIDC_ISSUER_URL", Value = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}" },
      { Name = "OIDC_CLIENT_ID", Value = aws_cognito_user_pool_client.web.id },
      { Name = "OIDC_REDIRECT_URI", Value = "${local.public_origin}/api/v1/auth/callback" },
      { Name = "WEB_ORIGIN", Value = local.public_origin },
      { Name = "TENANT_DATA_BROKER_ENDPOINT", Value = local.tenant_data_broker_endpoint },
      { Name = "TENANT_DATA_BROKER_AUDIENCE", Value = local.tenant_data_broker_hostname },
      { Name = "OTEL_EXPORTER_OTLP_ENDPOINT", Value = "http://127.0.0.1:4318" },
    ]
    Secrets = [
      { Name = "DATABASE_URL", ValueFrom = aws_secretsmanager_secret.runtime_database_url.arn },
      { Name = "SESSION_ENCRYPTION_KEY", ValueFrom = aws_secretsmanager_secret.session_encryption_key.arn },
      { Name = "DELETION_RECEIPT_SIGNING_KEY", ValueFrom = aws_secretsmanager_secret.deletion_receipt_signing_key.arn },
      { Name = "TENANT_DATA_BROKER_HMAC_KEY_RING", ValueFrom = aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn },
    ]
    LogConfiguration = {
      LogDriver = "awslogs"
      Options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }
  release_worker_container = {
    Name      = "worker"
    Essential = true
    Environment = concat([
      { Name = "NODE_ENV", Value = "production" },
      { Name = "AEO_ENVIRONMENT", Value = var.environment },
      { Name = "AWS_REGION", Value = var.region },
      { Name = "AWS_ACCOUNT_ID", Value = data.aws_caller_identity.current.account_id },
      { Name = "WORKER_MAX_CONCURRENT_JOBS", Value = "32" },
      { Name = "CRAWL_CONSUMER_CONCURRENCY", Value = "2" },
      { Name = "GENERATION_CONSUMER_CONCURRENCY", Value = "25" },
      { Name = "PUBLISH_CONSUMER_CONCURRENCY", Value = "2" },
      { Name = "MEASUREMENT_CONSUMER_CONCURRENCY", Value = "3" },
      { Name = "WORKLOAD_DATABASE_POOL_MAX", Value = "29" },
      { Name = "MEASUREMENT_DATABASE_POOL_MAX", Value = "3" },
      { Name = "OUTBOX_DATABASE_POOL_MAX", Value = "2" },
      { Name = "PRIVACY_DATABASE_POOL_MAX", Value = "2" },
      { Name = "RUNTIME_ISSUER_DATABASE_POOL_MAX", Value = "2" },
      { Name = "LIFECYCLE_ISSUER_DATABASE_POOL_MAX", Value = "2" },
      { Name = "CRAWL_QUEUE_URL", Value = aws_sqs_queue.crawl.url },
      { Name = "GENERATION_QUEUE_URL", Value = aws_sqs_queue.generation.url },
      { Name = "PUBLISH_QUEUE_URL", Value = aws_sqs_queue.publish.url },
      { Name = "MEASUREMENT_QUEUE_URL", Value = aws_sqs_queue.measurement.url },
      { Name = "AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT", Value = "sqs" },
      { Name = "ARTIFACT_BUCKET", Value = aws_s3_bucket.artifacts.id },
      { Name = "AUDIT_EVIDENCE_BUCKET", Value = aws_s3_bucket.audit_evidence.id },
      { Name = "S3_KMS_KEY_ARN", Value = aws_kms_key.data.arn },
      { Name = "BACKUP_VAULT_NAME", Value = aws_backup_vault.main.name },
      { Name = "RDS_INSTANCE_ARN", Value = aws_db_instance.main.arn },
      { Name = "RDS_INSTANCE_IDENTIFIER", Value = aws_db_instance.main.identifier },
      { Name = "TENANT_DATA_BROKER_ENDPOINT", Value = local.tenant_data_broker_endpoint },
      { Name = "TENANT_DATA_BROKER_AUDIENCE", Value = local.tenant_data_broker_hostname },
      { Name = "OTEL_EXPORTER_OTLP_ENDPOINT", Value = "http://127.0.0.1:4318" },
      ], var.environment == "staging" ? [
      { Name = "GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX", Value = "0050" },
      { Name = "GENERATION_CAPACITY_PROBE_HOLD_MS", Value = "10000" },
    ] : [])
    Secrets = [
      { Name = "DATABASE_URL", ValueFrom = aws_secretsmanager_secret.runtime_database_url.arn },
      { Name = "LIFECYCLE_DATABASE_URL", ValueFrom = aws_secretsmanager_secret.lifecycle_database_url.arn },
      { Name = "SESSION_ENCRYPTION_KEY", ValueFrom = aws_secretsmanager_secret.session_encryption_key.arn },
      { Name = "TENANT_DATA_BROKER_HMAC_KEY_RING", ValueFrom = aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn },
    ]
    LogConfiguration = {
      LogDriver = "awslogs"
      Options = {
        "awslogs-group"         = aws_cloudwatch_log_group.worker.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }
  release_migration_container = {
    Name      = "migration"
    Essential = true
    Command   = ["node", "packages/db/dist/migrate-main.js"]
    Environment = [
      { Name = "NODE_ENV", Value = "production" },
      { Name = "MIGRATION_DATABASE_POOL_MAX", Value = "1" },
      { Name = "AWS_REGION", Value = var.region },
      { Name = "AWS_ACCOUNT_ID", Value = data.aws_caller_identity.current.account_id },
      { Name = "ARTIFACT_BUCKET", Value = aws_s3_bucket.artifacts.id },
      { Name = "AUDIT_EVIDENCE_BUCKET", Value = aws_s3_bucket.audit_evidence.id },
      { Name = "S3_KMS_KEY_ARN", Value = aws_kms_key.data.arn },
    ]
    Secrets = [
      { Name = "DATABASE_URL", ValueFrom = aws_secretsmanager_secret.admin_database_url.arn },
    ]
    LogConfiguration = {
      LogDriver = "awslogs"
      Options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "migration"
      }
    }
  }
  release_tenant_data_broker_container = {
    Name      = "tenant-data-broker"
    Essential = true
    PortMappings = [{
      ContainerPort = 3300
      HostPort      = 3300
      Protocol      = "tcp"
    }]
    Environment = [
      { Name = "NODE_ENV", Value = "production" },
      { Name = "AWS_REGION", Value = var.region },
      { Name = "AWS_ACCOUNT_ID", Value = data.aws_caller_identity.current.account_id },
      { Name = "ARTIFACT_BUCKET", Value = aws_s3_bucket.artifacts.id },
      { Name = "AUDIT_EVIDENCE_BUCKET", Value = aws_s3_bucket.audit_evidence.id },
      { Name = "S3_KMS_KEY_ARN", Value = aws_kms_key.data.arn },
      { Name = "AEOSTUDIO_WORKER_MODE", Value = "tenant-data-broker" },
      { Name = "TENANT_DATA_BROKER_DATABASE_POOL_MAX", Value = "5" },
      { Name = "PORT", Value = "3300" },
      { Name = "TENANT_DATA_BROKER_AUDIENCE", Value = local.tenant_data_broker_hostname },
      { Name = "OTEL_SERVICE_NAME", Value = "aeostudio-tenant-data-broker" },
      { Name = "OTEL_EXPORTER_OTLP_ENDPOINT", Value = "http://127.0.0.1:4318" },
    ]
    Secrets = [
      { Name = "TENANT_DATA_BROKER_DATABASE_URL", ValueFrom = aws_secretsmanager_secret.tenant_data_broker_database_url.arn },
      { Name = "TENANT_DATA_BROKER_HMAC_KEY_RING", ValueFrom = aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn },
    ]
    LogConfiguration = {
      LogDriver = "awslogs"
      Options = {
        "awslogs-group"         = aws_cloudwatch_log_group.tenant_data_broker.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "tenant-data-broker"
      }
    }
  }
}

resource "aws_dynamodb_table" "release_control" {
  name         = "${local.name}-release-control"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "CoordinationKey"

  attribute {
    name = "CoordinationKey"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = var.environment == "production"
  tags                        = local.common_tags
}

data "aws_iam_policy_document" "step_functions_assume" {
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
      values = [
        "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release",
        "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release-watchdog",
        "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-bootstrap",
      ]
    }
  }
}

resource "aws_iam_role" "release_orchestrator" {
  name               = "${local.name}-release-orchestrator"
  assume_role_policy = data.aws_iam_policy_document.step_functions_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "release_orchestrator" {
  statement {
    sid       = "StartExactReleaseWatchdog"
    effect    = "Allow"
    actions   = ["states:StartExecution"]
    resources = ["arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release-watchdog"]
  }

  statement {
    sid       = "RunExactMigrationTask"
    effect    = "Allow"
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-migration:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid     = "VerifyExactReleaseRepositories"
    effect  = "Allow"
    actions = ["ecr:BatchGetImage"]
    resources = [
      data.aws_ecr_repository.api.arn,
      data.aws_ecr_repository.adot.arn,
      data.aws_ecr_repository.web.arn,
      data.aws_ecr_repository.worker.arn,
    ]
  }

  statement {
    sid       = "RegisterBrokerConstructedTaskDefinitions"
    effect    = "Allow"
    actions   = ["ecs:RegisterTaskDefinition"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/aeostudio:attested"
      values   = ["true"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = concat(keys(local.common_tags), ["aeostudio:attested"])
    }
  }

  statement {
    sid     = "TagBrokerConstructedTaskDefinitions"
    effect  = "Allow"
    actions = ["ecs:TagResource"]
    resources = [
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-api:*",
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-web:*",
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-worker:*",
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-migration:*",
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-tenant-data-broker:*",
    ]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/aeostudio:attested"
      values   = ["true"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = concat(keys(local.common_tags), ["aeostudio:attested"])
    }
  }

  statement {
    sid    = "ManageBrokerReleaseContracts"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:PutParameter",
    ]
    resources = [
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/aeostudio/${var.environment}/release-contract",
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/aeostudio/${var.environment}/releases/*",
    ]
  }

  statement {
    sid    = "CoordinateExactReleaseOwners"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.release_control.arn]
  }

  statement {
    sid     = "InspectExactBrokerExecutionsForRecovery"
    effect  = "Allow"
    actions = ["states:DescribeExecution"]
    resources = [
      "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:*",
      "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release-watchdog:*",
    ]
  }

  statement {
    sid    = "InspectAndStopBrokerTasks"
    effect = "Allow"
    actions = [
      "ecs:DescribeTasks",
      "ecs:StopTask",
    ]
    resources = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task/${local.name}/*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid     = "PassExactReleaseRoles"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.api_execution.arn,
      aws_iam_role.api.arn,
      aws_iam_role.execution.arn,
      aws_iam_role.web.arn,
      aws_iam_role.worker_execution.arn,
      aws_iam_role.worker.arn,
      aws_iam_role.migration_execution.arn,
      aws_iam_role.migration.arn,
      aws_iam_role.tenant_data_broker_execution.arn,
      aws_iam_role.tenant_data_broker.arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid    = "ObserveSynchronousEcsTask"
    effect = "Allow"
    actions = [
      "events:DescribeRule",
      "events:PutRule",
      "events:PutTargets",
    ]
    resources = ["arn:aws:events:${var.region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForECSTaskRule"]
  }

  statement {
    sid     = "InspectExactReleaseServices"
    effect  = "Allow"
    actions = ["ecs:DescribeServices"]
    resources = [
      aws_ecs_service.api.id,
      aws_ecs_service.tenant_data_broker.id,
      aws_ecs_service.web.id,
      aws_ecs_service.worker.id,
    ]
  }

  statement {
    sid     = "InspectExactLoadBalancerTargets"
    effect  = "Allow"
    actions = ["elasticloadbalancing:DescribeTargetHealth"]
    resources = [
      aws_lb_target_group.api.arn,
      aws_lb_target_group.tenant_data_broker.arn,
      aws_lb_target_group.web.arn,
    ]
  }

  statement {
    sid       = "ActivateOrRestoreExactApiRevision"
    effect    = "Allow"
    actions   = ["ecs:UpdateService"]
    resources = [aws_ecs_service.api.id]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }

    condition {
      test     = "ArnLike"
      variable = "ecs:task-definition"
      values   = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-api:*"]
    }
  }

  statement {
    sid       = "ActivateOrRestoreExactWebRevision"
    effect    = "Allow"
    actions   = ["ecs:UpdateService"]
    resources = [aws_ecs_service.web.id]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }

    condition {
      test     = "ArnLike"
      variable = "ecs:task-definition"
      values   = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-web:*"]
    }
  }

  statement {
    sid       = "ActivateOrRestoreExactWorkerRevision"
    effect    = "Allow"
    actions   = ["ecs:UpdateService"]
    resources = [aws_ecs_service.worker.id]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }

    condition {
      test     = "ArnLike"
      variable = "ecs:task-definition"
      values   = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-worker:*"]
    }
  }

  statement {
    sid       = "ActivateOrRestoreExactTenantDataBrokerRevision"
    effect    = "Allow"
    actions   = ["ecs:UpdateService"]
    resources = [aws_ecs_service.tenant_data_broker.id]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }

    condition {
      test     = "ArnLike"
      variable = "ecs:task-definition"
      values   = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-tenant-data-broker:*"]
    }
  }
}

resource "aws_iam_role_policy" "release_orchestrator" {
  name   = "${local.name}-release-orchestrator"
  role   = aws_iam_role.release_orchestrator.id
  policy = data.aws_iam_policy_document.release_orchestrator.json
}

resource "aws_sfn_state_machine" "release" {
  name     = "${local.name}-release"
  role_arn = aws_iam_role.release_orchestrator.arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment        = "Fixed AEOStudio release capability broker"
    StartAt        = "Select fixed release capability"
    TimeoutSeconds = 4200
    States = {
      "Select fixed release capability" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.Mode", StringEquals = "DEPLOY", Next = "Validate trusted deploy request" },
          { Variable = "$.Mode", StringEquals = "FINALIZE", Next = "Validate raw lifecycle request" },
          { Variable = "$.Mode", StringEquals = "ROLLBACK", Next = "Validate raw lifecycle request" },
          { Variable = "$.Mode", StringEquals = "RECOVER", Next = "Validate raw recovery request" },
        ]
        Default = "Release mode invalid"
      }
      "Release mode invalid" = {
        Type  = "Fail"
        Error = "ReleaseModeInvalid"
        Cause = "The release broker accepts only the fixed DEPLOY, FINALIZE, ROLLBACK, or RECOVER capability."
      }
      "Validate trusted deploy request" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.Release.ApiDigest", IsPresent = true },
            { Variable = "$.Release.ApiDigest", StringMatches = local.release_sha256_pattern },
            { Variable = "$.Release.WebDigest", IsPresent = true },
            { Variable = "$.Release.WebDigest", StringMatches = local.release_sha256_pattern },
            { Variable = "$.Release.WorkerDigest", IsPresent = true },
            { Variable = "$.Release.WorkerDigest", StringMatches = local.release_sha256_pattern },
            { Variable = "$.Release.AdotDigest", IsPresent = true },
            { Variable = "$.Release.AdotDigest", StringMatches = local.release_sha256_pattern },
            { Variable = "$.Release.SourceSha", IsString = true },
            { Not = { Variable = "$.Release.SourceSha", StringEquals = "" } },
            { Variable = "$.Release.BuildRunId", IsNumeric = true },
            { Variable = "$.Release.BuildRunId", NumericGreaterThan = 0 },
            { Variable = "$.Release.BuildRunAttempt", IsNumeric = true },
            { Variable = "$.Release.BuildRunAttempt", NumericGreaterThan = 0 },
          ]
          Next = "Validate bounded deploy execution name"
        }]
        Default = "Release request invalid"
      }
      "Validate bounded deploy execution name" = {
        Type          = "Choice"
        QueryLanguage = "JSONata"
        Choices = [{
          Condition = "{% $length($states.context.Execution.Name) > 0 and $length($states.context.Execution.Name) <= 70 %}"
          Next      = "Verify exact API digest"
        }]
        Default = "Release request invalid"
      }
      "Release request invalid" = {
        Type  = "Fail"
        Error = "ReleaseRequestInvalid"
        Cause = "A deploy request must contain only canonical release identity and four sha256 digests."
      }
      "Acquire exact environment release lock" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "SET LockOwner = :owner, ReleaseId = :release, ContractName = :contract, Phase = :preparing REMOVE ProductionFinalizationEvidenceSha256, GitHubEnvironmentEvidenceSha256, PromotionControlPlaneEvidenceSha256 ADD Generation :one"
          ConditionExpression = "attribute_not_exists(LockOwner) AND attribute_not_exists(ClaimOwner)"
          ExpressionAttributeValues = {
            ":owner"     = { "S.$" = "$.ReleaseLock.DeployExecutionArn" }
            ":release"   = { "S.$" = "$.ReleaseLock.ReleaseId" }
            ":contract"  = { "S.$" = "$.ReleaseLock.ContractName" }
            ":preparing" = { S = "PREPARING" }
            ":one"       = { N = "1" }
          }
          ReturnValues = "ALL_NEW"
        }
        ResultSelector = {
          "Generation.$" = "$.Attributes.Generation.N"
        }
        ResultPath = "$.acquiredReleaseLock"
        Next       = "Capture exact release generation"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.releaseLockAcquisitionError"
          Next        = "Load possibly acquired release lock"
        }]
      }
      "Load possibly acquired release lock" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.possiblyAcquiredReleaseLock"
        Next       = "Possibly acquired release lock matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.releaseLockReadbackError"
          Next        = "Release lock unavailable"
        }]
      }
      "Possibly acquired release lock matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.possiblyAcquiredReleaseLock.Item.LockOwner.S", IsPresent = true },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.ReleaseId.S", IsPresent = true },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.ContractName.S", IsPresent = true },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.Generation.N", IsPresent = true },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.Phase.S", IsPresent = true },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.LockOwner.S", StringEqualsPath = "$.ReleaseLock.DeployExecutionArn" },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.ReleaseId.S", StringEqualsPath = "$.ReleaseLock.ReleaseId" },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.ContractName.S", StringEqualsPath = "$.ReleaseLock.ContractName" },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.Phase.S", StringEquals = "PREPARING" },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.ClaimOwner", IsPresent = false },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
            { Variable = "$.possiblyAcquiredReleaseLock.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
          ]
          Next = "Adopt exact acquired release lock"
        }]
        Default = "Release lock unavailable"
      }
      "Adopt exact acquired release lock" = {
        Type = "Pass"
        Parameters = {
          "Generation.$" = "$.possiblyAcquiredReleaseLock.Item.Generation.N"
        }
        ResultPath = "$.acquiredReleaseLock"
        Next       = "Capture exact release generation"
      }
      "Release lock unavailable" = {
        Type  = "Fail"
        Error = "ReleaseLockUnavailable"
        Cause = "Another release or lifecycle owner holds the exact environment coordination item."
      }
      "Capture exact release generation" = {
        Type = "Pass"
        Parameters = {
          "DeployExecutionArn.$" = "$.ReleaseLock.DeployExecutionArn"
          "ReleaseId.$"          = "$.ReleaseLock.ReleaseId"
          "ContractName.$"       = "$.ReleaseLock.ContractName"
          "Generation.$"         = "$.acquiredReleaseLock.Generation"
          Phase                  = "PREPARING"
        }
        ResultPath = "$.ReleaseLock"
        Next       = "Capture exact rollback revisions"
      }
      "Build exact release watchdog launch" = {
        Type = "Pass"
        Parameters = {
          "Name.$"         = "$.ReleaseLock.ReleaseId"
          "ExecutionArn.$" = "States.Format('arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release-watchdog:{}', $.ReleaseLock.ReleaseId)"
          Input = {
            "DeployExecutionArn.$" = "$.ReleaseLock.DeployExecutionArn"
            "ReleaseId.$"          = "$.ReleaseLock.ReleaseId"
          }
        }
        ResultPath = "$.watchdogLaunch"
        Next       = "Start exact release watchdog"
      }
      "Verify exact API digest" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecr:batchGetImage"
        TimeoutSeconds = 20
        Parameters = {
          RepositoryName = data.aws_ecr_repository.api.name
          ImageIds       = [{ "ImageDigest.$" = "$.Release.ApiDigest" }]
        }
        ResultSelector = {
          "FailureCount.$" = "States.ArrayLength($.Failures)"
          "ImageCount.$"   = "States.ArrayLength($.Images)"
          "Images.$"       = "$.Images"
        }
        ResultPath = "$.verifiedApi"
        Next       = "Exact API digest exists"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release digest verification failed"
        }]
      }
      "Exact API digest exists" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.verifiedApi.FailureCount", NumericEquals = 0 },
            { Variable = "$.verifiedApi.ImageCount", NumericEquals = 1 },
          ]
          Next = "Capture exact API digest"
        }]
        Default = "Release digest verification failed"
      }
      "Capture exact API digest" = {
        Type = "Pass"
        Parameters = {
          "ImageDigest.$" = "$.verifiedApi.Images[0].ImageId.ImageDigest"
        }
        ResultPath = "$.verifiedApiExact"
        Next       = "Exact API digest matches"
      }
      "Exact API digest matches" = {
        Type = "Choice"
        Choices = [{
          Variable         = "$.verifiedApiExact.ImageDigest"
          StringEqualsPath = "$.Release.ApiDigest"
          Next             = "Verify exact Web digest"
        }]
        Default = "Release digest verification failed"
      }
      "Verify exact Web digest" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecr:batchGetImage"
        TimeoutSeconds = 20
        Parameters = {
          RepositoryName = data.aws_ecr_repository.web.name
          ImageIds       = [{ "ImageDigest.$" = "$.Release.WebDigest" }]
        }
        ResultSelector = {
          "FailureCount.$" = "States.ArrayLength($.Failures)"
          "ImageCount.$"   = "States.ArrayLength($.Images)"
          "Images.$"       = "$.Images"
        }
        ResultPath = "$.verifiedWeb"
        Next       = "Exact Web digest exists"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release digest verification failed"
        }]
      }
      "Exact Web digest exists" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.verifiedWeb.FailureCount", NumericEquals = 0 },
            { Variable = "$.verifiedWeb.ImageCount", NumericEquals = 1 },
          ]
          Next = "Capture exact Web digest"
        }]
        Default = "Release digest verification failed"
      }
      "Capture exact Web digest" = {
        Type = "Pass"
        Parameters = {
          "ImageDigest.$" = "$.verifiedWeb.Images[0].ImageId.ImageDigest"
        }
        ResultPath = "$.verifiedWebExact"
        Next       = "Exact Web digest matches"
      }
      "Exact Web digest matches" = {
        Type = "Choice"
        Choices = [{
          Variable         = "$.verifiedWebExact.ImageDigest"
          StringEqualsPath = "$.Release.WebDigest"
          Next             = "Verify exact Worker digest"
        }]
        Default = "Release digest verification failed"
      }
      "Verify exact Worker digest" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecr:batchGetImage"
        TimeoutSeconds = 20
        Parameters = {
          RepositoryName = data.aws_ecr_repository.worker.name
          ImageIds       = [{ "ImageDigest.$" = "$.Release.WorkerDigest" }]
        }
        ResultSelector = {
          "FailureCount.$" = "States.ArrayLength($.Failures)"
          "ImageCount.$"   = "States.ArrayLength($.Images)"
          "Images.$"       = "$.Images"
        }
        ResultPath = "$.verifiedWorker"
        Next       = "Exact Worker digest exists"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release digest verification failed"
        }]
      }
      "Exact Worker digest exists" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.verifiedWorker.FailureCount", NumericEquals = 0 },
            { Variable = "$.verifiedWorker.ImageCount", NumericEquals = 1 },
          ]
          Next = "Capture exact Worker digest"
        }]
        Default = "Release digest verification failed"
      }
      "Capture exact Worker digest" = {
        Type = "Pass"
        Parameters = {
          "ImageDigest.$" = "$.verifiedWorker.Images[0].ImageId.ImageDigest"
        }
        ResultPath = "$.verifiedWorkerExact"
        Next       = "Exact Worker digest matches"
      }
      "Exact Worker digest matches" = {
        Type = "Choice"
        Choices = [{
          Variable         = "$.verifiedWorkerExact.ImageDigest"
          StringEqualsPath = "$.Release.WorkerDigest"
          Next             = "Verify exact ADOT digest"
        }]
        Default = "Release digest verification failed"
      }
      "Verify exact ADOT digest" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecr:batchGetImage"
        TimeoutSeconds = 20
        Parameters = {
          RepositoryName = data.aws_ecr_repository.adot.name
          ImageIds       = [{ "ImageDigest.$" = "$.Release.AdotDigest" }]
        }
        ResultSelector = {
          "FailureCount.$" = "States.ArrayLength($.Failures)"
          "ImageCount.$"   = "States.ArrayLength($.Images)"
          "Images.$"       = "$.Images"
        }
        ResultPath = "$.verifiedAdot"
        Next       = "Exact ADOT digest exists"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release digest verification failed"
        }]
      }
      "Exact ADOT digest exists" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.verifiedAdot.FailureCount", NumericEquals = 0 },
            { Variable = "$.verifiedAdot.ImageCount", NumericEquals = 1 },
          ]
          Next = "Capture exact ADOT digest"
        }]
        Default = "Release digest verification failed"
      }
      "Capture exact ADOT digest" = {
        Type = "Pass"
        Parameters = {
          "ImageDigest.$" = "$.verifiedAdot.Images[0].ImageId.ImageDigest"
        }
        ResultPath = "$.verifiedAdotExact"
        Next       = "Exact ADOT digest matches"
      }
      "Exact ADOT digest matches" = {
        Type = "Choice"
        Choices = [{
          Variable         = "$.verifiedAdotExact.ImageDigest"
          StringEqualsPath = "$.Release.AdotDigest"
          Next             = "Build exact environment release lock"
        }]
        Default = "Release digest verification failed"
      }
      "Release digest verification failed" = {
        Type  = "Fail"
        Error = "ReleaseDigestVerificationFailed"
        Cause = "Every requested digest must be a canonical existing digest in its fixed private ECR repository."
      }
      "Build exact environment release lock" = {
        Type = "Pass"
        Parameters = {
          "DeployExecutionArn.$" = "$$.Execution.Id"
          "ReleaseId.$"          = "$$.Execution.Name"
          "ContractName.$"       = "States.Format('/aeostudio/${var.environment}/releases/{}', $$.Execution.Name)"
        }
        ResultPath = "$.ReleaseLock"
        Next       = "Build exact release watchdog launch"
      }
      "Capture exact rollback revisions" = {
        Type = "Parallel"
        Branches = [
          {
            StartAt = "Describe exact rollback API service"
            States = {
              "Describe exact rollback API service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 20
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.api.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact rollback API response count"
              }
              "Exact rollback API response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact rollback API service"
                }]
                Default = "Rollback API response invalid"
              }
              "Select exact rollback API service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Rollback API response invalid" = {
                Type  = "Fail"
                Error = "RollbackApiServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe exact rollback Web service"
            States = {
              "Describe exact rollback Web service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 20
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.web.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact rollback Web response count"
              }
              "Exact rollback Web response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact rollback Web service"
                }]
                Default = "Rollback Web response invalid"
              }
              "Select exact rollback Web service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Rollback Web response invalid" = {
                Type  = "Fail"
                Error = "RollbackWebServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe exact rollback Worker service"
            States = {
              "Describe exact rollback Worker service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 20
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.worker.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact rollback Worker response count"
              }
              "Exact rollback Worker response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact rollback Worker service"
                }]
                Default = "Rollback Worker response invalid"
              }
              "Select exact rollback Worker service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Rollback Worker response invalid" = {
                Type  = "Fail"
                Error = "RollbackWorkerServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe exact rollback Tenant Data Broker service"
            States = {
              "Describe exact rollback Tenant Data Broker service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 20
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.tenant_data_broker.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact rollback Tenant Data Broker response count"
              }
              "Exact rollback Tenant Data Broker response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact rollback Tenant Data Broker service"
                }]
                Default = "Rollback Tenant Data Broker response invalid"
              }
              "Select exact rollback Tenant Data Broker service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Rollback Tenant Data Broker response invalid" = {
                Type  = "Fail"
                Error = "RollbackTenantDataBrokerServiceDescriptionInvalid"
              }
            }
          },
        ]
        ResultSelector = {
          "Api.$"              = "$[0]"
          "Web.$"              = "$[1]"
          "Worker.$"           = "$[2]"
          "TenantDataBroker.$" = "$[3]"
        }
        ResultPath = "$.priorResponses"
        Next       = "Exact rollback service count captured"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.rollbackCaptureError"
          Next        = "Clean failed release preparation lock"
        }]
      }
      "Exact rollback service count captured" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.priorResponses.Api.FailureCount", NumericEquals = 0 },
            { Variable = "$.priorResponses.Api.ServiceCount", NumericEquals = 1 },
            { Variable = "$.priorResponses.Web.FailureCount", NumericEquals = 0 },
            { Variable = "$.priorResponses.Web.ServiceCount", NumericEquals = 1 },
            { Variable = "$.priorResponses.Worker.FailureCount", NumericEquals = 0 },
            { Variable = "$.priorResponses.Worker.ServiceCount", NumericEquals = 1 },
            { Variable = "$.priorResponses.TenantDataBroker.FailureCount", NumericEquals = 0 },
            { Variable = "$.priorResponses.TenantDataBroker.ServiceCount", NumericEquals = 1 },
          ]
          Next = "Select exact rollback revisions"
        }]
        Default = "Clean failed release preparation lock"
      }
      "Select exact rollback revisions" = {
        Type = "Pass"
        Parameters = {
          FailureCount                     = 0
          ServiceCount                     = 4
          "ApiName.$"                      = "$.priorResponses.Api.Service.ServiceName"
          "RollbackApi.$"                  = "$.priorResponses.Api.Service.TaskDefinition"
          "ApiDesiredCount.$"              = "$.priorResponses.Api.Service.DesiredCount"
          "ApiRunningCount.$"              = "$.priorResponses.Api.Service.RunningCount"
          "ApiPendingCount.$"              = "$.priorResponses.Api.Service.PendingCount"
          "WebName.$"                      = "$.priorResponses.Web.Service.ServiceName"
          "RollbackWeb.$"                  = "$.priorResponses.Web.Service.TaskDefinition"
          "WebDesiredCount.$"              = "$.priorResponses.Web.Service.DesiredCount"
          "WebRunningCount.$"              = "$.priorResponses.Web.Service.RunningCount"
          "WebPendingCount.$"              = "$.priorResponses.Web.Service.PendingCount"
          "WorkerName.$"                   = "$.priorResponses.Worker.Service.ServiceName"
          "RollbackWorker.$"               = "$.priorResponses.Worker.Service.TaskDefinition"
          "WorkerDesiredCount.$"           = "$.priorResponses.Worker.Service.DesiredCount"
          "WorkerRunningCount.$"           = "$.priorResponses.Worker.Service.RunningCount"
          "WorkerPendingCount.$"           = "$.priorResponses.Worker.Service.PendingCount"
          "TenantDataBrokerName.$"         = "$.priorResponses.TenantDataBroker.Service.ServiceName"
          "RollbackTenantDataBroker.$"     = "$.priorResponses.TenantDataBroker.Service.TaskDefinition"
          "TenantDataBrokerDesiredCount.$" = "$.priorResponses.TenantDataBroker.Service.DesiredCount"
          "TenantDataBrokerRunningCount.$" = "$.priorResponses.TenantDataBroker.Service.RunningCount"
          "TenantDataBrokerPendingCount.$" = "$.priorResponses.TenantDataBroker.Service.PendingCount"
        }
        ResultPath = "$.prior"
        Next       = "Exact rollback revisions captured"
      }
      "Exact rollback revisions captured" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.prior.FailureCount", NumericEquals = 0 },
            { Variable = "$.prior.ServiceCount", NumericEquals = 4 },
            { Variable = "$.prior.ApiName", StringEquals = aws_ecs_service.api.name },
            { Variable = "$.prior.RollbackApi", StringMatches = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-api:*" },
            { Variable = "$.prior.ApiDesiredCount", NumericEquals = 2 },
            { Variable = "$.prior.ApiRunningCount", NumericEquals = 2 },
            { Variable = "$.prior.ApiPendingCount", NumericEquals = 0 },
            { Variable = "$.prior.WebName", StringEquals = aws_ecs_service.web.name },
            { Variable = "$.prior.RollbackWeb", StringMatches = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-web:*" },
            { Variable = "$.prior.WebDesiredCount", NumericEquals = 2 },
            { Variable = "$.prior.WebRunningCount", NumericEquals = 2 },
            { Variable = "$.prior.WebPendingCount", NumericEquals = 0 },
            { Variable = "$.prior.WorkerName", StringEquals = aws_ecs_service.worker.name },
            { Variable = "$.prior.RollbackWorker", StringMatches = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-worker:*" },
            { Variable = "$.prior.WorkerDesiredCount", NumericEquals = 2 },
            { Variable = "$.prior.WorkerRunningCount", NumericEquals = 2 },
            { Variable = "$.prior.WorkerPendingCount", NumericEquals = 0 },
            { Variable = "$.prior.TenantDataBrokerName", StringEquals = aws_ecs_service.tenant_data_broker.name },
            { Variable = "$.prior.RollbackTenantDataBroker", StringMatches = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-tenant-data-broker:*" },
            { Variable = "$.prior.TenantDataBrokerDesiredCount", NumericEquals = 2 },
            { Variable = "$.prior.TenantDataBrokerRunningCount", NumericEquals = 2 },
            { Variable = "$.prior.TenantDataBrokerPendingCount", NumericEquals = 0 },
          ]
          Next = "Register fixed API revision"
        }]
        Default = "Clean failed release preparation lock"
      }
      "Register fixed API revision" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:registerTaskDefinition"
        TimeoutSeconds = 30
        Parameters = {
          Family                  = "${local.name}-api"
          Cpu                     = "1024"
          Memory                  = "2048"
          NetworkMode             = "awsvpc"
          RequiresCompatibilities = ["FARGATE"]
          ExecutionRoleArn        = aws_iam_role.api_execution.arn
          TaskRoleArn             = aws_iam_role.api.arn
          RuntimePlatform         = { CpuArchitecture = "X86_64", OperatingSystemFamily = "LINUX" }
          ContainerDefinitions = [
            merge(local.release_api_container, { "Image.$" = "States.Format('${data.aws_ecr_repository.api.repository_url}@{}', $.Release.ApiDigest)" }),
            merge(local.release_adot_container, { "Image.$" = "States.Format('${data.aws_ecr_repository.adot.repository_url}@{}', $.Release.AdotDigest)" }),
          ]
          Tags = local.release_tags
        }
        ResultSelector = {
          "TaskDefinitionArn.$" = "$.TaskDefinition.TaskDefinitionArn"
        }
        ResultPath = "$.registeredApi"
        Next       = "Register fixed Web revision"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.apiRegistrationError"
          Next        = "Clean failed release preparation lock"
        }]
      }
      "Register fixed Web revision" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:registerTaskDefinition"
        TimeoutSeconds = 30
        Parameters = {
          Family                  = "${local.name}-web"
          Cpu                     = "512"
          Memory                  = "1024"
          NetworkMode             = "awsvpc"
          RequiresCompatibilities = ["FARGATE"]
          ExecutionRoleArn        = aws_iam_role.execution.arn
          TaskRoleArn             = aws_iam_role.web.arn
          RuntimePlatform         = { CpuArchitecture = "X86_64", OperatingSystemFamily = "LINUX" }
          ContainerDefinitions = [
            merge(local.release_web_container, { "Image.$" = "States.Format('${data.aws_ecr_repository.web.repository_url}@{}', $.Release.WebDigest)" }),
            merge(local.release_adot_container, { "Image.$" = "States.Format('${data.aws_ecr_repository.adot.repository_url}@{}', $.Release.AdotDigest)" }),
          ]
          Tags = local.release_tags
        }
        ResultSelector = {
          "TaskDefinitionArn.$" = "$.TaskDefinition.TaskDefinitionArn"
        }
        ResultPath = "$.registeredWeb"
        Next       = "Register fixed Worker revision"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.webRegistrationError"
          Next        = "Clean failed release preparation lock"
        }]
      }
      "Register fixed Worker revision" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:registerTaskDefinition"
        TimeoutSeconds = 30
        Parameters = {
          Family                  = "${local.name}-worker"
          Cpu                     = "4096"
          Memory                  = "8192"
          NetworkMode             = "awsvpc"
          RequiresCompatibilities = ["FARGATE"]
          ExecutionRoleArn        = aws_iam_role.worker_execution.arn
          TaskRoleArn             = aws_iam_role.worker.arn
          RuntimePlatform         = { CpuArchitecture = "X86_64", OperatingSystemFamily = "LINUX" }
          ContainerDefinitions = [
            merge(local.release_worker_container, { "Image.$" = "States.Format('${data.aws_ecr_repository.worker.repository_url}@{}', $.Release.WorkerDigest)" }),
            merge(local.release_adot_container, { "Image.$" = "States.Format('${data.aws_ecr_repository.adot.repository_url}@{}', $.Release.AdotDigest)" }),
          ]
          Tags = local.release_tags
        }
        ResultSelector = {
          "TaskDefinitionArn.$" = "$.TaskDefinition.TaskDefinitionArn"
        }
        ResultPath = "$.registeredWorker"
        Next       = "Register fixed Tenant Data Broker revision"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.workerRegistrationError"
          Next        = "Clean failed release preparation lock"
        }]
      }
      "Register fixed Tenant Data Broker revision" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:registerTaskDefinition"
        TimeoutSeconds = 30
        Parameters = {
          Family                  = "${local.name}-tenant-data-broker"
          Cpu                     = "1024"
          Memory                  = "2048"
          NetworkMode             = "awsvpc"
          RequiresCompatibilities = ["FARGATE"]
          ExecutionRoleArn        = aws_iam_role.tenant_data_broker_execution.arn
          TaskRoleArn             = aws_iam_role.tenant_data_broker.arn
          RuntimePlatform         = { CpuArchitecture = "X86_64", OperatingSystemFamily = "LINUX" }
          ContainerDefinitions = [
            merge(local.release_tenant_data_broker_container, { "Image.$" = "States.Format('${data.aws_ecr_repository.worker.repository_url}@{}', $.Release.WorkerDigest)" }),
            merge(local.release_adot_container, { "Image.$" = "States.Format('${data.aws_ecr_repository.adot.repository_url}@{}', $.Release.AdotDigest)" }),
          ]
          Tags = local.release_tags
        }
        ResultSelector = {
          "TaskDefinitionArn.$" = "$.TaskDefinition.TaskDefinitionArn"
        }
        ResultPath = "$.registeredTenantDataBroker"
        Next       = "Register fixed migration revision"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.tenantDataBrokerRegistrationError"
          Next        = "Clean failed release preparation lock"
        }]
      }
      "Register fixed migration revision" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:registerTaskDefinition"
        TimeoutSeconds = 30
        Parameters = {
          Family                  = "${local.name}-migration"
          Cpu                     = "512"
          Memory                  = "1024"
          NetworkMode             = "awsvpc"
          RequiresCompatibilities = ["FARGATE"]
          ExecutionRoleArn        = aws_iam_role.migration_execution.arn
          TaskRoleArn             = aws_iam_role.migration.arn
          RuntimePlatform         = { CpuArchitecture = "X86_64", OperatingSystemFamily = "LINUX" }
          ContainerDefinitions    = [merge(local.release_migration_container, { "Image.$" = "States.Format('${data.aws_ecr_repository.api.repository_url}@{}', $.Release.ApiDigest)" })]
          Tags                    = local.release_tags
        }
        ResultSelector = {
          "TaskDefinitionArn.$" = "$.TaskDefinition.TaskDefinitionArn"
        }
        ResultPath = "$.registeredMigration"
        Next       = "Build immutable release contract"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.migrationRegistrationError"
          Next        = "Clean failed release preparation lock"
        }]
      }
      "Build immutable release contract" = {
        Type = "Pass"
        Parameters = {
          Contract = {
            SchemaVersion    = "aeostudio.release-contract.v2"
            Environment      = var.environment
            Region           = var.region
            AccountId        = data.aws_caller_identity.current.account_id
            "ReleaseId.$"    = "$$.Execution.Name"
            "ContractName.$" = "States.Format('/aeostudio/${var.environment}/releases/{}', $$.Execution.Name)"
            BrokerArn        = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release"
            WatchdogArn      = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release-watchdog"
            Source = {
              "Sha.$"             = "$.Release.SourceSha"
              "BuildRunId.$"      = "$.Release.BuildRunId"
              "BuildRunAttempt.$" = "$.Release.BuildRunAttempt"
            }
            Digests = {
              "Api.$"    = "$.Release.ApiDigest"
              "Adot.$"   = "$.Release.AdotDigest"
              "Web.$"    = "$.Release.WebDigest"
              "Worker.$" = "$.Release.WorkerDigest"
            }
            Images = {
              "Api.$"              = "States.Format('${data.aws_ecr_repository.api.repository_url}@{}', $.Release.ApiDigest)"
              "Adot.$"             = "States.Format('${data.aws_ecr_repository.adot.repository_url}@{}', $.Release.AdotDigest)"
              "Web.$"              = "States.Format('${data.aws_ecr_repository.web.repository_url}@{}', $.Release.WebDigest)"
              "Worker.$"           = "States.Format('${data.aws_ecr_repository.worker.repository_url}@{}', $.Release.WorkerDigest)"
              "TenantDataBroker.$" = "States.Format('${data.aws_ecr_repository.worker.repository_url}@{}', $.Release.WorkerDigest)"
            }
            TaskDefinitions = {
              "Api.$"              = "$.registeredApi.TaskDefinitionArn"
              "Web.$"              = "$.registeredWeb.TaskDefinitionArn"
              "Worker.$"           = "$.registeredWorker.TaskDefinitionArn"
              "TenantDataBroker.$" = "$.registeredTenantDataBroker.TaskDefinitionArn"
              "Migration.$"        = "$.registeredMigration.TaskDefinitionArn"
            }
            Rollback = {
              "Api.$"              = "$.prior.RollbackApi"
              "Web.$"              = "$.prior.RollbackWeb"
              "Worker.$"           = "$.prior.RollbackWorker"
              "TenantDataBroker.$" = "$.prior.RollbackTenantDataBroker"
            }
          }
          "ReleaseLock.$"    = "$.ReleaseLock"
          "watchdogLaunch.$" = "$.watchdogLaunch"
          RollbackOutcome    = "FAIL"
        }
        ResultPath = "$"
        Next       = "Serialize immutable release contract"
      }
      "Serialize immutable release contract" = {
        Type = "Pass"
        Parameters = {
          "Contract.$"        = "$.Contract"
          "ReleaseLock.$"     = "$.ReleaseLock"
          "RollbackOutcome.$" = "$.RollbackOutcome"
          "ContractJson.$"    = "States.JsonToString($.Contract)"
          "watchdogLaunch.$"  = "$.watchdogLaunch"
        }
        ResultPath = "$"
        Next       = "Write immutable release contract"
      }
      "Write immutable release contract" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:putParameter"
        TimeoutSeconds = 20
        Parameters = {
          "Name.$"  = "$.Contract.ContractName"
          Type      = "String"
          "Value.$" = "$.ContractJson"
          Overwrite = false
        }
        ResultPath = null
        Next       = "Mark exact release contract ready"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.contractWriteError"
          Next        = "Read possibly written immutable release contract"
        }]
      }
      "Read possibly written immutable release contract" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          "Name.$" = "$.Contract.ContractName"
        }
        ResultSelector = {
          "Value.$" = "$.Parameter.Value"
        }
        ResultPath = "$.possiblyWrittenContract"
        Next       = "Possibly written immutable release contract matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.contractReadbackError"
          Next        = "Clean failed release preparation lock"
        }]
      }
      "Possibly written immutable release contract matches" = {
        Type = "Choice"
        Choices = [{
          Variable         = "$.possiblyWrittenContract.Value"
          StringEqualsPath = "$.ContractJson"
          Next             = "Mark exact release contract ready"
        }]
        Default = "Clean failed release preparation lock"
      }
      "Mark exact release contract ready" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "SET Phase = :ready"
          ConditionExpression = "LockOwner = :owner AND ReleaseId = :release AND ContractName = :contract AND Generation = :generation AND Phase = :preparing AND attribute_not_exists(ClaimOwner)"
          ExpressionAttributeValues = {
            ":owner"      = { "S.$" = "$.ReleaseLock.DeployExecutionArn" }
            ":release"    = { "S.$" = "$.ReleaseLock.ReleaseId" }
            ":contract"   = { "S.$" = "$.ReleaseLock.ContractName" }
            ":generation" = { "N.$" = "$.ReleaseLock.Generation" }
            ":preparing"  = { S = "PREPARING" }
            ":ready"      = { S = "CONTRACT_READY" }
          }
        }
        ResultPath = null
        Next       = "Adopt exact contract-ready phase"
        Retry = [{
          ErrorEquals     = ["DynamoDb.InternalServerError", "DynamoDB.InternalServerError", "States.Timeout"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.contractReadyTransitionError"
          Next        = "Load possibly contract-ready coordination"
        }]
      }
      "Load possibly contract-ready coordination" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.possiblyContractReadyCoordination"
        Next       = "Possibly contract-ready coordination matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.contractReadyReadbackError"
          Next        = "Release contract readiness failed"
        }]
      }
      "Possibly contract-ready coordination matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.possiblyContractReadyCoordination.Item.LockOwner.S", IsPresent = true },
            { Variable = "$.possiblyContractReadyCoordination.Item.ReleaseId.S", IsPresent = true },
            { Variable = "$.possiblyContractReadyCoordination.Item.ContractName.S", IsPresent = true },
            { Variable = "$.possiblyContractReadyCoordination.Item.Generation.N", IsPresent = true },
            { Variable = "$.possiblyContractReadyCoordination.Item.Phase.S", IsPresent = true },
            { Variable = "$.possiblyContractReadyCoordination.Item.LockOwner.S", StringEqualsPath = "$.ReleaseLock.DeployExecutionArn" },
            { Variable = "$.possiblyContractReadyCoordination.Item.ReleaseId.S", StringEqualsPath = "$.ReleaseLock.ReleaseId" },
            { Variable = "$.possiblyContractReadyCoordination.Item.ContractName.S", StringEqualsPath = "$.ReleaseLock.ContractName" },
            { Variable = "$.possiblyContractReadyCoordination.Item.Generation.N", StringEqualsPath = "$.ReleaseLock.Generation" },
            { Variable = "$.possiblyContractReadyCoordination.Item.Phase.S", StringEquals = "CONTRACT_READY" },
            { Variable = "$.possiblyContractReadyCoordination.Item.ClaimOwner", IsPresent = false },
          ]
          Next = "Adopt exact contract-ready phase"
        }]
        Default = "Release contract readiness failed"
      }
      "Adopt exact contract-ready phase" = {
        Type = "Pass"
        Parameters = {
          "DeployExecutionArn.$" = "$.ReleaseLock.DeployExecutionArn"
          "ReleaseId.$"          = "$.ReleaseLock.ReleaseId"
          "ContractName.$"       = "$.ReleaseLock.ContractName"
          "Generation.$"         = "$.ReleaseLock.Generation"
          Phase                  = "CONTRACT_READY"
        }
        ResultPath = "$.ReleaseLock"
        Next       = "Run exact migration"
      }
      "Release contract readiness failed" = {
        Type  = "Fail"
        Error = "ReleaseContractReadinessFailed"
        Cause = "The immutable contract exists but its exact generation could not be marked ready; the watchdog retains the lock for recovery."
      }
      "Start exact release watchdog" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::states:startExecution"
        TimeoutSeconds = 20
        Parameters = {
          StateMachineArn = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release-watchdog"
          "Name.$"        = "$.watchdogLaunch.Name"
          "Input.$"       = "$.watchdogLaunch.Input"
        }
        ResultSelector = {
          "ExecutionArn.$" = "$.ExecutionArn"
        }
        ResultPath = "$.watchdog"
        Next       = "Exact release watchdog started"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.watchdogStartError"
          Next        = "Inspect possibly started release watchdog"
        }]
      }
      "Exact release watchdog started" = {
        Type = "Choice"
        Choices = [{
          Variable         = "$.watchdog.ExecutionArn"
          StringEqualsPath = "$.watchdogLaunch.ExecutionArn"
          Next             = "Inspect possibly started release watchdog"
        }]
        Default = "Release watchdog unavailable"
      }
      "Inspect possibly started release watchdog" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:sfn:describeExecution"
        TimeoutSeconds = 20
        Parameters = {
          "ExecutionArn.$" = "$.watchdogLaunch.ExecutionArn"
        }
        ResultSelector = {
          "Status.$" = "$.Status"
          "Input.$"  = "States.StringToJson($.Input)"
        }
        ResultPath = "$.possiblyStartedWatchdog"
        Next       = "Possibly started release watchdog matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.watchdogReadbackError"
          Next        = "Release watchdog unavailable"
        }]
      }
      "Possibly started release watchdog matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.possiblyStartedWatchdog.Status", IsPresent = true },
            { Variable = "$.possiblyStartedWatchdog.Input.DeployExecutionArn", IsPresent = true },
            { Variable = "$.possiblyStartedWatchdog.Input.ReleaseId", IsPresent = true },
            { Variable = "$.possiblyStartedWatchdog.Status", StringEquals = "RUNNING" },
            { Variable = "$.possiblyStartedWatchdog.Input.DeployExecutionArn", StringEqualsPath = "$.ReleaseLock.DeployExecutionArn" },
            { Variable = "$.possiblyStartedWatchdog.Input.ReleaseId", StringEqualsPath = "$.ReleaseLock.ReleaseId" },
          ]
          Next = "Acquire exact environment release lock"
        }]
        Default = "Release watchdog unavailable"
      }
      "Release watchdog unavailable" = {
        Type  = "Fail"
        Error = "ReleaseWatchdogUnavailable"
        Cause = "The deterministic watchdog could not be started and verified before the environment lock was acquired."
      }
      "Clean failed release preparation lock" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "REMOVE LockOwner, ReleaseId, ContractName, Phase"
          ConditionExpression = "LockOwner = :owner AND ReleaseId = :release AND ContractName = :contract AND Generation = :generation AND Phase = :preparing AND attribute_not_exists(ClaimOwner)"
          ExpressionAttributeValues = {
            ":owner"      = { "S.$" = "$.ReleaseLock.DeployExecutionArn" }
            ":release"    = { "S.$" = "$.ReleaseLock.ReleaseId" }
            ":contract"   = { "S.$" = "$.ReleaseLock.ContractName" }
            ":generation" = { "N.$" = "$.ReleaseLock.Generation" }
            ":preparing"  = { S = "PREPARING" }
          }
        }
        Next = "Release preparation failed"
        Retry = [{
          ErrorEquals     = ["DynamoDb.InternalServerError", "DynamoDB.InternalServerError", "States.Timeout"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.preparationCleanupError"
          Next        = "Read preparation cleanup outcome"
        }]
      }
      "Read preparation cleanup outcome" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.preparationCleanupOutcome"
        Next       = "Select preparation cleanup outcome"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.preparationCleanupReadError"
          Next        = "Release preparation lock cleanup failed"
        }]
      }
      "Select preparation cleanup outcome" = {
        Type = "Choice"
        Choices = [
          {
            Variable  = "$.preparationCleanupOutcome.Item.LockOwner"
            IsPresent = false
            Next      = "Release preparation failed"
          },
          {
            And = [
              { Variable = "$.preparationCleanupOutcome.Item.Generation.N", IsPresent = true },
              {
                Not = {
                  Variable         = "$.preparationCleanupOutcome.Item.Generation.N"
                  StringEqualsPath = "$.ReleaseLock.Generation"
                }
              },
            ]
            Next = "Release preparation failed"
          },
          {
            And = [
              { Variable = "$.preparationCleanupOutcome.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.preparationCleanupOutcome.Item.ReleaseId.S", IsPresent = true },
              { Variable = "$.preparationCleanupOutcome.Item.ContractName.S", IsPresent = true },
              { Variable = "$.preparationCleanupOutcome.Item.Phase.S", IsPresent = true },
              { Variable = "$.preparationCleanupOutcome.Item.LockOwner.S", StringEqualsPath = "$.ReleaseLock.DeployExecutionArn" },
              { Variable = "$.preparationCleanupOutcome.Item.ReleaseId.S", StringEqualsPath = "$.ReleaseLock.ReleaseId" },
              { Variable = "$.preparationCleanupOutcome.Item.ContractName.S", StringEqualsPath = "$.ReleaseLock.ContractName" },
              { Variable = "$.preparationCleanupOutcome.Item.Phase.S", StringEquals = "PREPARING" },
              { Variable = "$.preparationCleanupOutcome.Item.ClaimOwner", IsPresent = false },
            ]
            Next = "Wait to retry preparation cleanup"
          },
        ]
        Default = "Release preparation lock cleanup failed"
      }
      "Wait to retry preparation cleanup" = {
        Type    = "Wait"
        Seconds = 5
        Next    = "Clean failed release preparation lock"
      }
      "Release preparation lock cleanup failed" = {
        Type  = "Fail"
        Error = "ReleaseLockCleanupFailed"
        Cause = "Release preparation failed and its environment lock could not be removed."
      }
      "Release preparation failed" = {
        Type  = "Fail"
        Error = "ReleasePreparationFailed"
        Cause = "The fixed broker could not verify digests, capture rollback state, or construct its immutable release contract."
      }
      "Validate raw lifecycle request" = {
        Type = "Choice"
        Choices = concat(
          var.environment == "production" ? [{
            And = [
              { Variable = "$.ReleaseId", IsPresent = true },
              { Variable = "$.ReleaseId", IsString = true },
              { Not = { Variable = "$.ReleaseId", StringEquals = "" } },
              { Variable = "$.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256", IsPresent = true },
              { Variable = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256", IsString = true },
              { Not = { Variable = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256", StringEquals = "" } },
              { Variable = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", IsPresent = true },
              { Variable = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", IsString = true },
              { Not = { Variable = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", StringEquals = "" } },
              { Variable = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", IsPresent = true },
              { Variable = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", IsString = true },
              { Not = { Variable = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", StringEquals = "" } },
            ]
            Next = "Validate production finalization hash format"
          }] : [],
          var.environment == "production" ? [{
            And = [
              { Variable = "$.ReleaseId", IsPresent = true },
              { Variable = "$.ReleaseId", IsString = true },
              { Not = { Variable = "$.ReleaseId", StringEquals = "" } },
              { Variable = "$.Mode", StringEquals = "ROLLBACK" },
            ]
            Next = "Validate bounded lifecycle release ID"
          }] : [],
          var.environment == "staging" ? [{
            And = [
              { Variable = "$.ReleaseId", IsPresent = true },
              { Variable = "$.ReleaseId", IsString = true },
              { Not = { Variable = "$.ReleaseId", StringEquals = "" } },
              {
                Or = [
                  { Variable = "$.Mode", StringEquals = "FINALIZE" },
                  { Variable = "$.Mode", StringEquals = "ROLLBACK" },
                ]
              },
            ]
            Next = "Validate bounded lifecycle release ID"
          }] : []
        )
        Default = "Release lifecycle request rejected"
      }
      "Validate production finalization hash format" = {
        Type          = "Choice"
        QueryLanguage = "JSONata"
        Choices = [{
          Condition = "{% $length($states.input.ReleaseId) > 0 and $length($states.input.ReleaseId) <= 70 and $count($match($states.input.FinalizationEvidence.ProductionFinalizationEvidenceSha256, /^[0-9a-f]{64}$/)) = 1 and $count($match($states.input.FinalizationEvidence.GitHubEnvironmentEvidenceSha256, /^[0-9a-f]{64}$/)) = 1 and $count($match($states.input.FinalizationEvidence.PromotionControlPlaneEvidenceSha256, /^[0-9a-f]{64}$/)) = 1 %}"
          Next      = "Initialize trusted production finalization request"
        }]
        Default = "Release lifecycle request rejected"
      }
      "Validate bounded lifecycle release ID" = {
        Type          = "Choice"
        QueryLanguage = "JSONata"
        Choices = [{
          Condition = "{% $length($states.input.ReleaseId) > 0 and $length($states.input.ReleaseId) <= 70 %}"
          Next      = "Initialize trusted lifecycle request"
        }]
        Default = "Release lifecycle request rejected"
      }
      "Initialize trusted lifecycle request" = {
        Type = "Pass"
        Parameters = {
          "Mode.$"                 = "$.Mode"
          "ReleaseId.$"            = "$.ReleaseId"
          "ExpectedContractName.$" = "States.Format('/aeostudio/${var.environment}/releases/{}', $.ReleaseId)"
        }
        ResultPath = "$"
        Next       = "Load active release lock"
      }
      "Initialize trusted production finalization request" = {
        Type = "Pass"
        Parameters = {
          "Mode.$"                 = "$.Mode"
          "ReleaseId.$"            = "$.ReleaseId"
          "ExpectedContractName.$" = "States.Format('/aeostudio/${var.environment}/releases/{}', $.ReleaseId)"
          FinalizationEvidence = {
            "ProductionFinalizationEvidenceSha256.$" = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256"
            "GitHubEnvironmentEvidenceSha256.$"      = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256"
            "PromotionControlPlaneEvidenceSha256.$"  = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256"
          }
        }
        ResultPath = "$"
        Next       = "Load active release lock"
      }
      "Validate raw recovery request" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.ReleaseId", IsPresent = true },
            { Variable = "$.ReleaseId", IsString = true },
            { Not = { Variable = "$.ReleaseId", StringEquals = "" } },
            { Variable = "$.DeployExecutionArn", IsPresent = true },
            { Variable = "$.DeployExecutionArn", IsString = true },
            { Variable = "$.DeployExecutionArn", StringMatches = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:*" },
          ]
          Next = "Validate exact raw recovery envelope"
        }]
        Default = "Release recovery rejected"
      }
      "Validate exact raw recovery envelope" = {
        Type          = "Choice"
        QueryLanguage = "JSONata"
        Choices = [{
          Condition = "{% $type($states.input) = 'object' and $count($keys($states.input)) = 3 and $length($states.input.ReleaseId) > 0 and $length($states.input.ReleaseId) <= 70 %}"
          Next      = "Initialize trusted recovery request"
        }]
        Default = "Release recovery rejected"
      }
      "Initialize trusted recovery request" = {
        Type = "Pass"
        Parameters = {
          Mode                     = "RECOVER"
          ClaimAlreadyOwned        = false
          "ReleaseId.$"            = "$.ReleaseId"
          "DeployExecutionArn.$"   = "$.DeployExecutionArn"
          "ExpectedContractName.$" = "States.Format('/aeostudio/${var.environment}/releases/{}', $.ReleaseId)"
        }
        ResultPath = "$"
        Next       = "Validate bounded trusted recovery release ID"
      }
      "Validate bounded trusted recovery release ID" = {
        Type          = "Choice"
        QueryLanguage = "JSONata"
        Choices = [{
          Condition = "{% $length($states.input.ReleaseId) > 0 and $length($states.input.ReleaseId) <= 70 %}"
          Next      = "Validate trusted recovery request"
        }]
        Default = "Release recovery rejected"
      }
      "Validate trusted recovery request" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.ReleaseId", IsString = true },
            { Not = { Variable = "$.ReleaseId", StringEquals = "" } },
            { Variable = "$.DeployExecutionArn", StringMatches = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:*" },
          ]
          Next = "Load stale release lock"
        }]
        Default = "Release recovery rejected"
      }
      "Load stale release lock" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.recoveryLockResponse"
        Next       = "Recovery release lock exists"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release recovery rejected"
        }]
      }
      "Recovery release lock exists" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.recoveryLockResponse.Item.LockOwner", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.Phase", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.Generation.N", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", StringEquals = "PREPARATION_ABORTED" },
              { Variable = "$.recoveryLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.recoveryLockResponse.Item.PointerContractName.S", StringEqualsPath = "$.ExpectedContractName" },
              { Variable = "$.recoveryLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Release recovery already complete"
          },
          {
            And = [
              { Variable = "$.recoveryLockResponse.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.ReleaseId.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.ContractName.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.Generation.N", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.Phase.S", IsPresent = true },
            ]
            Next = "Select exact recovery lock"
          },
          {
            Variable  = "$.recoveryLockResponse.Item.LockOwner"
            IsPresent = true
            Next      = "Release recovery rejected"
          },
          {
            Variable  = "$.recoveryLockResponse.Item.ClaimOwner"
            IsPresent = true
            Next      = "Load orphan recovery lifecycle claim"
          },
        ]
        Default = "Release recovery rejected"
      }
      "Select exact recovery lock" = {
        Type = "Pass"
        Parameters = {
          Lock = {
            "DeployExecutionArn.$" = "$.recoveryLockResponse.Item.LockOwner.S"
            "ReleaseId.$"          = "$.recoveryLockResponse.Item.ReleaseId.S"
            "ContractName.$"       = "$.recoveryLockResponse.Item.ContractName.S"
            "Generation.$"         = "$.recoveryLockResponse.Item.Generation.N"
            "Phase.$"              = "$.recoveryLockResponse.Item.Phase.S"
          }
        }
        ResultPath = "$.recoveryLock"
        Next       = "Exact recovery lock matches request"
      }
      "Load orphan recovery lifecycle claim" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.orphanCoordination"
        Next       = "Orphan recovery lifecycle claim exists"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release recovery rejected"
        }]
      }
      "Orphan recovery lifecycle claim exists" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.orphanCoordination.Item.ClaimOwner.S", IsPresent = true },
              { Variable = "$.orphanCoordination.Item.ClaimMode.S", IsPresent = true },
              { Variable = "$.orphanCoordination.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.orphanCoordination.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.orphanCoordination.Item.Generation.N", IsPresent = true },
            ]
            Next = "Select exact orphan recovery lifecycle claim"
          },
          {
            Variable  = "$.orphanCoordination.Item.ClaimOwner"
            IsPresent = true
            Next      = "Release recovery rejected"
          },
        ]
        Default = "Load stale release lock"
      }
      "Select exact orphan recovery lifecycle claim" = {
        Type = "Pass"
        Parameters = {
          Claim = {
            "ExecutionArn.$" = "$.orphanCoordination.Item.ClaimOwner.S"
            "Mode.$"         = "$.orphanCoordination.Item.ClaimMode.S"
            "ReleaseId.$"    = "$.orphanCoordination.Item.PointerReleaseId.S"
            "ContractName.$" = "$.orphanCoordination.Item.PointerContractName.S"
            "Generation.$"   = "$.orphanCoordination.Item.Generation.N"
          }
        }
        ResultPath = "$.orphanLifecycleClaim"
        Next       = "Exact orphan lifecycle claim matches request"
      }
      "Exact orphan lifecycle claim matches request" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.orphanLifecycleClaim.Claim.ExecutionArn", StringMatches = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:*" },
            { Variable = "$.orphanLifecycleClaim.Claim.ReleaseId", StringEqualsPath = "$.ReleaseId" },
            { Variable = "$.orphanLifecycleClaim.Claim.ContractName", StringMatches = "/aeostudio/${var.environment}/releases/*" },
          ]
          Next = "Inspect orphan lifecycle execution"
        }]
        Default = "Release recovery rejected"
      }
      "Inspect orphan lifecycle execution" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:sfn:describeExecution"
        TimeoutSeconds = 20
        Parameters = {
          "ExecutionArn.$" = "$.orphanLifecycleClaim.Claim.ExecutionArn"
        }
        ResultSelector = {
          "Input.$"  = "States.StringToJson($.Input)"
          "Status.$" = "$.Status"
        }
        ResultPath = "$.orphanLifecycleExecution"
        Next       = "Orphan lifecycle execution is terminal"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release recovery rejected"
        }]
      }
      "Orphan lifecycle execution is terminal" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.orphanLifecycleExecution.Status", StringEquals = "FAILED", Next = "Load orphan recovery pointer" },
          { Variable = "$.orphanLifecycleExecution.Status", StringEquals = "TIMED_OUT", Next = "Load orphan recovery pointer" },
          { Variable = "$.orphanLifecycleExecution.Status", StringEquals = "ABORTED", Next = "Load orphan recovery pointer" },
          { Variable = "$.orphanLifecycleExecution.Status", StringEquals = "SUCCEEDED", Next = "Load orphan recovery pointer" },
        ]
        Default = "Release recovery rejected"
      }
      "Load orphan recovery pointer" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name = local.release_pointer_name
        }
        ResultSelector = {
          "Pointer.$" = "States.StringToJson($.Parameter.Value)"
        }
        ResultPath = "$.orphanPointer"
        Next       = "Load orphan recovery contract"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release recovery rejected"
        }]
      }
      "Load orphan recovery contract" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          "Name.$" = "$.orphanLifecycleClaim.Claim.ContractName"
        }
        ResultSelector = {
          "Contract.$" = "States.StringToJson($.Parameter.Value)"
        }
        ResultPath = "$.orphanContract"
        Next       = "Exact orphan terminal state matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release recovery rejected"
        }]
      }
      "Exact orphan terminal state matches" = {
        Type = "Choice"
        Choices = concat(
          var.environment == "production" ? [{
            And = [
              { Variable = "$.orphanPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.orphanPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.orphanPointer.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.orphanPointer.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.orphanPointer.Pointer.ContractName", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ContractName" },
              { Variable = "$.orphanContract.Contract.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.orphanContract.Contract.ContractName", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ContractName" },
              { Variable = "$.orphanContract.Contract.Environment", StringEquals = var.environment },
              { Variable = "$.orphanContract.Contract.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.orphanCoordination.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
              { Variable = "$.orphanCoordination.Item.PointerReleaseId.S", StringEqualsPath = "$.orphanPointer.Pointer.ReleaseId" },
              { Variable = "$.orphanCoordination.Item.PointerContractName.S", StringEqualsPath = "$.orphanPointer.Pointer.ContractName" },
              { Variable = "$.orphanLifecycleClaim.Claim.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.orphanLifecycleExecution.Input.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.orphanLifecycleExecution.Input.ReleaseId", StringEqualsPath = "$.orphanPointer.Pointer.ReleaseId" },
              { Variable = "$.orphanPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256", IsPresent = true },
              { Variable = "$.orphanPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", IsPresent = true },
              { Variable = "$.orphanPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", IsPresent = true },
              { Variable = "$.orphanLifecycleExecution.Input.FinalizationEvidence.ProductionFinalizationEvidenceSha256", StringEqualsPath = "$.orphanPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
              { Variable = "$.orphanLifecycleExecution.Input.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", StringEqualsPath = "$.orphanPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
              { Variable = "$.orphanLifecycleExecution.Input.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", StringEqualsPath = "$.orphanPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
              { Variable = "$.orphanCoordination.Item.ProductionFinalizationEvidenceSha256.S", StringEqualsPath = "$.orphanPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
              { Variable = "$.orphanCoordination.Item.GitHubEnvironmentEvidenceSha256.S", StringEqualsPath = "$.orphanPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
              { Variable = "$.orphanCoordination.Item.PromotionControlPlaneEvidenceSha256.S", StringEqualsPath = "$.orphanPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
            ]
            Next = "Delete exact finalized orphan lifecycle claim"
          }] : [],
          var.environment == "staging" ? [{
            And = [
              { Variable = "$.orphanPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.orphanPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.orphanPointer.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.orphanPointer.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.orphanPointer.Pointer.ContractName", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ContractName" },
              { Variable = "$.orphanPointer.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.orphanContract.Contract.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.orphanContract.Contract.ContractName", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ContractName" },
              { Variable = "$.orphanContract.Contract.Environment", StringEquals = var.environment },
              { Variable = "$.orphanContract.Contract.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.orphanCoordination.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
              { Variable = "$.orphanCoordination.Item.PointerReleaseId.S", StringEqualsPath = "$.orphanPointer.Pointer.ReleaseId" },
              { Variable = "$.orphanCoordination.Item.PointerContractName.S", StringEqualsPath = "$.orphanPointer.Pointer.ContractName" },
              { Variable = "$.orphanLifecycleClaim.Claim.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.orphanLifecycleExecution.Input.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.orphanLifecycleExecution.Input.ReleaseId", StringEqualsPath = "$.orphanPointer.Pointer.ReleaseId" },
              { Variable = "$.orphanCoordination.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.orphanCoordination.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.orphanCoordination.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Delete exact finalized orphan lifecycle claim"
          }] : [],
          [{
            And = [
              { Variable = "$.orphanPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.orphanPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.orphanPointer.Pointer.Status", StringEquals = "ROLLED_BACK" },
              { Variable = "$.orphanPointer.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.orphanPointer.Pointer.ContractName", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ContractName" },
              { Variable = "$.orphanPointer.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.orphanContract.Contract.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.orphanContract.Contract.ContractName", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ContractName" },
              { Variable = "$.orphanContract.Contract.Environment", StringEquals = var.environment },
              { Variable = "$.orphanContract.Contract.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.orphanCoordination.Item.PointerStatus.S", StringEquals = "ROLLED_BACK" },
              { Variable = "$.orphanCoordination.Item.PointerReleaseId.S", StringEqualsPath = "$.orphanPointer.Pointer.ReleaseId" },
              { Variable = "$.orphanCoordination.Item.PointerContractName.S", StringEqualsPath = "$.orphanPointer.Pointer.ContractName" },
              { Variable = "$.orphanCoordination.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.orphanCoordination.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.orphanCoordination.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Delete exact orphan lifecycle claim"
          }]
        )
        Default = "Release recovery rejected"
      }
      "Delete exact finalized orphan lifecycle claim" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "REMOVE ClaimOwner, ClaimMode"
          ConditionExpression = var.environment == "production" ? "attribute_not_exists(LockOwner) AND ClaimOwner = :claim_owner AND ClaimMode = :claim_mode AND PointerStatus = :status AND PointerReleaseId = :release AND PointerContractName = :contract AND Generation = :generation AND ProductionFinalizationEvidenceSha256 = :production_finalization_evidence AND GitHubEnvironmentEvidenceSha256 = :github_environment_evidence AND PromotionControlPlaneEvidenceSha256 = :promotion_control_plane_evidence" : "attribute_not_exists(LockOwner) AND ClaimOwner = :claim_owner AND ClaimMode = :claim_mode AND PointerStatus = :status AND PointerReleaseId = :release AND PointerContractName = :contract AND Generation = :generation AND attribute_not_exists(ProductionFinalizationEvidenceSha256) AND attribute_not_exists(GitHubEnvironmentEvidenceSha256) AND attribute_not_exists(PromotionControlPlaneEvidenceSha256)"
          ExpressionAttributeValues = merge({
            ":claim_owner" = { "S.$" = "$.orphanLifecycleClaim.Claim.ExecutionArn" }
            ":claim_mode"  = { S = "FINALIZE" }
            ":status"      = { S = "DEPLOYED" }
            ":release"     = { "S.$" = "$.orphanLifecycleClaim.Claim.ReleaseId" }
            ":contract"    = { "S.$" = "$.orphanLifecycleClaim.Claim.ContractName" }
            ":generation"  = { "N.$" = "$.orphanLifecycleClaim.Claim.Generation" }
            }, var.environment == "production" ? {
            ":production_finalization_evidence" = { "S.$" = "$.orphanPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256" }
            ":github_environment_evidence"      = { "S.$" = "$.orphanPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" }
            ":promotion_control_plane_evidence" = { "S.$" = "$.orphanPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" }
          } : {})
        }
        ResultPath = null
        Next       = "Read orphan lifecycle claim cleanup outcome"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.orphanLifecycleClaimCleanupError"
          Next        = "Read orphan lifecycle claim cleanup outcome"
        }]
      }
      "Delete exact orphan lifecycle claim" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "REMOVE ClaimOwner, ClaimMode"
          ConditionExpression = "attribute_not_exists(LockOwner) AND ClaimOwner = :claim_owner AND PointerStatus = :status AND PointerReleaseId = :release AND PointerContractName = :contract AND Generation = :generation AND attribute_not_exists(ProductionFinalizationEvidenceSha256) AND attribute_not_exists(GitHubEnvironmentEvidenceSha256) AND attribute_not_exists(PromotionControlPlaneEvidenceSha256)"
          ExpressionAttributeValues = {
            ":claim_owner" = { "S.$" = "$.orphanLifecycleClaim.Claim.ExecutionArn" }
            ":status"      = { S = "ROLLED_BACK" }
            ":release"     = { "S.$" = "$.orphanLifecycleClaim.Claim.ReleaseId" }
            ":contract"    = { "S.$" = "$.orphanLifecycleClaim.Claim.ContractName" }
            ":generation"  = { "N.$" = "$.orphanLifecycleClaim.Claim.Generation" }
          }
        }
        ResultPath = null
        Next       = "Read orphan lifecycle claim cleanup outcome"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.orphanLifecycleClaimCleanupError"
          Next        = "Read orphan lifecycle claim cleanup outcome"
        }]
      }
      "Read orphan lifecycle claim cleanup outcome" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.orphanLifecycleClaimCleanupOutcome"
        Next       = "Select orphan lifecycle claim cleanup outcome"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.orphanLifecycleClaimCleanupReadError"
          Next        = "Release lifecycle operation incomplete"
        }]
      }
      "Select orphan lifecycle claim cleanup outcome" = {
        Type = "Choice"
        Choices = concat(
          var.environment == "production" ? [{
            And = [
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.orphanLifecycleClaim.Claim.Generation" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerReleaseId.S", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ReleaseId" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerContractName.S", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ContractName" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.LockOwner", IsPresent = false },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.ProductionFinalizationEvidenceSha256.S", StringEqualsPath = "$.orphanPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256.S", StringEqualsPath = "$.orphanPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256.S", StringEqualsPath = "$.orphanPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
            ]
            Next = "Release recovery already complete"
          }] : [],
          var.environment == "staging" ? [{
            And = [
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerReleaseId.S", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ReleaseId" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerContractName.S", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ContractName" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.orphanLifecycleClaim.Claim.Generation" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.LockOwner", IsPresent = false },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Release recovery already complete"
          }] : [],
          [{
            And = [
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerStatus.S", StringEquals = "ROLLED_BACK" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerReleaseId.S", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ReleaseId" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PointerContractName.S", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ContractName" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.orphanLifecycleClaim.Claim.Generation" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.LockOwner", IsPresent = false },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Release recovery already complete"
          }],
          [{
            And = [
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.ClaimOwner.S", IsPresent = true },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.orphanLifecycleClaim.Claim.Generation" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.ClaimOwner.S", StringEqualsPath = "$.orphanLifecycleClaim.Claim.ExecutionArn" },
              { Variable = "$.orphanLifecycleClaimCleanupOutcome.Item.LockOwner", IsPresent = false },
            ]
            Next = "Wait to retry orphan lifecycle claim cleanup"
          }]
        )
        Default = "Release lifecycle operation incomplete"
      }
      "Wait to retry orphan lifecycle claim cleanup" = {
        Type    = "Wait"
        Seconds = 5
        Next    = "Select orphan lifecycle claim cleanup retry"
      }
      "Select orphan lifecycle claim cleanup retry" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.orphanPointer.Pointer.Status", StringEquals = "DEPLOYED", Next = "Delete exact finalized orphan lifecycle claim" },
          { Variable = "$.orphanPointer.Pointer.Status", StringEquals = "ROLLED_BACK", Next = "Delete exact orphan lifecycle claim" },
        ]
        Default = "Release lifecycle operation incomplete"
      }
      "Read possibly finalized release pointer" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name = local.release_pointer_name
        }
        ResultSelector = {
          "PointerJson.$" = "$.Parameter.Value"
        }
        ResultPath = "$.possiblyFinalizedPointer"
        Next       = "Possibly finalized release pointer matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.finalizedPointerReadError"
          Next        = "Release lifecycle operation incomplete"
        }]
      }
      "Possibly finalized release pointer matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.possiblyFinalizedPointer.PointerJson", IsPresent = true },
            { Variable = "$.possiblyFinalizedPointer.PointerJson", StringEqualsPath = "$.finalized.PointerJson" },
          ]
          Next = "Delete finalized release lock"
        }]
        Default = "Release lifecycle operation incomplete"
      }
      "Release recovery already complete" = {
        Type = "Succeed"
      }
      "Exact recovery lock matches request" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.recoveryLock.Lock.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.recoveryLock.Lock.DeployExecutionArn", StringEqualsPath = "$.DeployExecutionArn" },
              { Variable = "$.recoveryLock.Lock.ContractName", StringMatches = "/aeostudio/${var.environment}/releases/*" },
              { Variable = "$.recoveryLock.Lock.Phase", StringEquals = "CONTRACT_READY" },
            ]
            Next = "Load immutable recovery contract"
          },
          {
            And = [
              { Variable = "$.recoveryLock.Lock.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.recoveryLock.Lock.DeployExecutionArn", StringEqualsPath = "$.DeployExecutionArn" },
              { Variable = "$.recoveryLock.Lock.ContractName", StringMatches = "/aeostudio/${var.environment}/releases/*" },
              { Variable = "$.recoveryLock.Lock.Phase", StringEquals = "PREPARING" },
              { Variable = "$.recoveryLockResponse.Item.ClaimOwner", IsPresent = false },
            ]
            Next = "Inspect pre-contract stale deploy execution"
          },
        ]
        Default = "Release recovery rejected"
      }
      "Inspect pre-contract stale deploy execution" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:sfn:describeExecution"
        TimeoutSeconds = 20
        Parameters = {
          "ExecutionArn.$" = "$.recoveryLock.Lock.DeployExecutionArn"
        }
        ResultSelector = {
          "Status.$" = "$.Status"
        }
        ResultPath = "$.preContractDeployExecution"
        Next       = "Pre-contract stale deploy is terminal"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.preContractDeployInspectionError"
          Next        = "Release recovery rejected"
        }]
      }
      "Pre-contract stale deploy is terminal" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.preContractDeployExecution.Status", StringEquals = "FAILED", Next = "Clean exact pre-contract release lock" },
          { Variable = "$.preContractDeployExecution.Status", StringEquals = "TIMED_OUT", Next = "Clean exact pre-contract release lock" },
          { Variable = "$.preContractDeployExecution.Status", StringEquals = "ABORTED", Next = "Clean exact pre-contract release lock" },
        ]
        Default = "Release recovery rejected"
      }
      "Clean exact pre-contract release lock" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "SET PointerStatus = :status, PointerReleaseId = :release, PointerContractName = :contract REMOVE LockOwner, ReleaseId, ContractName, Phase, ProductionFinalizationEvidenceSha256, GitHubEnvironmentEvidenceSha256, PromotionControlPlaneEvidenceSha256"
          ConditionExpression = "LockOwner = :owner AND ReleaseId = :release AND ContractName = :contract AND Generation = :generation AND Phase = :preparing AND attribute_not_exists(ClaimOwner)"
          ExpressionAttributeValues = {
            ":owner"      = { "S.$" = "$.recoveryLock.Lock.DeployExecutionArn" }
            ":release"    = { "S.$" = "$.recoveryLock.Lock.ReleaseId" }
            ":contract"   = { "S.$" = "$.recoveryLock.Lock.ContractName" }
            ":generation" = { "N.$" = "$.recoveryLock.Lock.Generation" }
            ":preparing"  = { S = "PREPARING" }
            ":status"     = { S = "PREPARATION_ABORTED" }
          }
        }
        ResultPath = null
        Next       = "Release recovery completed"
        Retry = [{
          ErrorEquals     = ["DynamoDb.InternalServerError", "DynamoDB.InternalServerError", "States.Timeout"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.preContractCleanupError"
          Next        = "Wait to verify pre-contract cleanup"
        }]
      }
      "Wait to verify pre-contract cleanup" = {
        Type    = "Wait"
        Seconds = 5
        Next    = "Read pre-contract cleanup outcome"
      }
      "Read pre-contract cleanup outcome" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.preContractCleanupOutcome"
        Next       = "Select pre-contract cleanup outcome"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release recovery rejected"
        }]
      }
      "Select pre-contract cleanup outcome" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.preContractCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.preContractCleanupOutcome.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.preContractCleanupOutcome.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.preContractCleanupOutcome.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.preContractCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.recoveryLock.Lock.Generation" },
              { Variable = "$.preContractCleanupOutcome.Item.PointerStatus.S", StringEquals = "PREPARATION_ABORTED" },
              { Variable = "$.preContractCleanupOutcome.Item.PointerReleaseId.S", StringEqualsPath = "$.recoveryLock.Lock.ReleaseId" },
              { Variable = "$.preContractCleanupOutcome.Item.PointerContractName.S", StringEqualsPath = "$.recoveryLock.Lock.ContractName" },
              { Variable = "$.preContractCleanupOutcome.Item.LockOwner", IsPresent = false },
              { Variable = "$.preContractCleanupOutcome.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.preContractCleanupOutcome.Item.Phase", IsPresent = false },
              { Variable = "$.preContractCleanupOutcome.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.preContractCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.preContractCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Release recovery completed"
          },
          {
            And = [
              { Variable = "$.preContractCleanupOutcome.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.preContractCleanupOutcome.Item.ReleaseId.S", IsPresent = true },
              { Variable = "$.preContractCleanupOutcome.Item.ContractName.S", IsPresent = true },
              { Variable = "$.preContractCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.preContractCleanupOutcome.Item.Phase.S", IsPresent = true },
              { Variable = "$.preContractCleanupOutcome.Item.LockOwner.S", StringEqualsPath = "$.recoveryLock.Lock.DeployExecutionArn" },
              { Variable = "$.preContractCleanupOutcome.Item.ReleaseId.S", StringEqualsPath = "$.recoveryLock.Lock.ReleaseId" },
              { Variable = "$.preContractCleanupOutcome.Item.ContractName.S", StringEqualsPath = "$.recoveryLock.Lock.ContractName" },
              { Variable = "$.preContractCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.recoveryLock.Lock.Generation" },
              { Variable = "$.preContractCleanupOutcome.Item.Phase.S", StringEquals = "PREPARING" },
              { Variable = "$.preContractCleanupOutcome.Item.ClaimOwner", IsPresent = false },
            ]
            Next = "Wait to retry pre-contract cleanup"
          },
        ]
        Default = "Release recovery rejected"
      }
      "Wait to retry pre-contract cleanup" = {
        Type    = "Wait"
        Seconds = 5
        Next    = "Clean exact pre-contract release lock"
      }
      "Load immutable recovery contract" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          "Name.$" = "$.recoveryLock.Lock.ContractName"
        }
        ResultSelector = {
          "Contract.$" = "States.StringToJson($.Parameter.Value)"
        }
        ResultPath = "$.recoveryContract"
        Next       = "Immutable recovery contract matches lock"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release recovery rejected"
        }]
      }
      "Immutable recovery contract matches lock" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.recoveryContract.Contract.ReleaseId", StringEqualsPath = "$.recoveryLock.Lock.ReleaseId" },
            { Variable = "$.recoveryContract.Contract.ContractName", StringEqualsPath = "$.recoveryLock.Lock.ContractName" },
            { Variable = "$.recoveryContract.Contract.Environment", StringEquals = var.environment },
            { Variable = "$.recoveryContract.Contract.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
          ]
          Next = "Load current recovery pointer"
        }]
        Default = "Release recovery rejected"
      }
      "Load current recovery pointer" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name = local.release_pointer_name
        }
        ResultSelector = {
          "Pointer.$" = "States.StringToJson($.Parameter.Value)"
        }
        ResultPath = "$.recoveryPointer"
        Next       = "Load exact recovery lifecycle claim"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release recovery rejected"
        }]
      }
      "Load exact recovery lifecycle claim" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.recoveryLockResponse.Item.ClaimOwner.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.ClaimMode.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.ClaimOwner.S", StringEqualsPath = "$$.Execution.Id" },
              { Variable = "$.recoveryLockResponse.Item.ClaimMode.S", StringEquals = "RECOVER" },
            ]
            Next = "Record already-owned exact recovery claim"
          },
          {
            And = [
              { Variable = "$.recoveryLockResponse.Item.ClaimOwner.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.ClaimMode.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.ReleaseId.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.ContractName.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.Generation.N", IsPresent = true },
            ]
            Next = "Select exact stale lifecycle claim"
          },
        ]
        Default = "Inspect stale deploy execution"
      }
      "Record already-owned exact recovery claim" = {
        Type       = "Pass"
        Result     = true
        ResultPath = "$.ClaimAlreadyOwned"
        Next       = "Inspect stale deploy execution"
      }
      "Select exact stale lifecycle claim" = {
        Type = "Pass"
        Parameters = {
          Claim = {
            "ExecutionArn.$"       = "$.recoveryLockResponse.Item.ClaimOwner.S"
            "Mode.$"               = "$.recoveryLockResponse.Item.ClaimMode.S"
            "DeployExecutionArn.$" = "$.recoveryLockResponse.Item.LockOwner.S"
            "ReleaseId.$"          = "$.recoveryLockResponse.Item.ReleaseId.S"
            "ContractName.$"       = "$.recoveryLockResponse.Item.ContractName.S"
            "Generation.$"         = "$.recoveryLockResponse.Item.Generation.N"
          }
        }
        ResultPath = "$.staleLifecycleClaim"
        Next       = "Exact stale lifecycle claim matches"
      }
      "Exact stale lifecycle claim matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.staleLifecycleClaim.Claim.ExecutionArn", StringMatches = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:*" },
            { Variable = "$.staleLifecycleClaim.Claim.DeployExecutionArn", StringEqualsPath = "$.recoveryLock.Lock.DeployExecutionArn" },
            { Variable = "$.staleLifecycleClaim.Claim.ReleaseId", StringEqualsPath = "$.recoveryLock.Lock.ReleaseId" },
            { Variable = "$.staleLifecycleClaim.Claim.ContractName", StringEqualsPath = "$.recoveryLock.Lock.ContractName" },
            { Variable = "$.staleLifecycleClaim.Claim.Generation", StringEqualsPath = "$.recoveryLock.Lock.Generation" },
          ]
          Next = "Inspect stale lifecycle execution"
        }]
        Default = "Release recovery rejected"
      }
      "Inspect stale lifecycle execution" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:sfn:describeExecution"
        TimeoutSeconds = 20
        Parameters = {
          "ExecutionArn.$" = "$.staleLifecycleClaim.Claim.ExecutionArn"
        }
        ResultSelector = {
          "Input.$"  = "States.StringToJson($.Input)"
          "Status.$" = "$.Status"
        }
        ResultPath = "$.staleLifecycleExecution"
        Next       = "Stale lifecycle execution is recoverable"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release recovery rejected"
        }]
      }
      "Stale lifecycle execution is recoverable" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.staleLifecycleExecution.Status", StringEquals = "FAILED", Next = "Record failed lifecycle recovery" },
          { Variable = "$.staleLifecycleExecution.Status", StringEquals = "TIMED_OUT", Next = "Record failed lifecycle recovery" },
          { Variable = "$.staleLifecycleExecution.Status", StringEquals = "ABORTED", Next = "Record failed lifecycle recovery" },
          { Variable = "$.staleLifecycleExecution.Status", StringEquals = "SUCCEEDED", Next = "Record terminal lifecycle cleanup" },
          { Variable = "$.staleLifecycleExecution.Status", StringEquals = "RUNNING", Next = "Wait for active recovery lifecycle operation" },
        ]
        Default = "Release recovery rejected"
      }
      "Wait for active recovery lifecycle operation" = {
        Type    = "Wait"
        Seconds = 15
        Next    = "Load stale release lock"
      }
      "Record failed lifecycle recovery" = {
        Type       = "Pass"
        Result     = { CanRollback = true }
        ResultPath = "$.recoveryReason"
        Next       = "Take over exact stale lifecycle claim"
      }
      "Record terminal lifecycle cleanup" = {
        Type       = "Pass"
        Result     = { CanRollback = false }
        ResultPath = "$.recoveryReason"
        Next       = "Take over exact stale lifecycle claim"
      }
      "Take over exact stale lifecycle claim" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "SET ClaimOwner = :new_claim_owner, ClaimMode = :recovery_mode"
          ConditionExpression = "LockOwner = :lock_owner AND ReleaseId = :release AND ContractName = :contract AND Generation = :generation AND Phase = :ready AND ClaimOwner = :old_claim_owner"
          ExpressionAttributeValues = {
            ":lock_owner"      = { "S.$" = "$.recoveryLock.Lock.DeployExecutionArn" }
            ":release"         = { "S.$" = "$.recoveryLock.Lock.ReleaseId" }
            ":contract"        = { "S.$" = "$.recoveryLock.Lock.ContractName" }
            ":generation"      = { "N.$" = "$.recoveryLock.Lock.Generation" }
            ":ready"           = { S = "CONTRACT_READY" }
            ":old_claim_owner" = { "S.$" = "$.staleLifecycleClaim.Claim.ExecutionArn" }
            ":new_claim_owner" = { "S.$" = "$$.Execution.Id" }
            ":recovery_mode"   = { S = "RECOVER" }
          }
        }
        ResultPath = null
        Next       = "Record exact recovery claim takeover"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.recoveryClaimTakeoverError"
          Next        = "Read exact recovery claim takeover outcome"
        }]
      }
      "Read exact recovery claim takeover outcome" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.recoveryClaimTakeoverOutcome"
        Next       = "Exact recovery claim takeover outcome matches"
        Retry = [{
          ErrorEquals     = ["DynamoDb.InternalServerError", "DynamoDB.InternalServerError", "States.Timeout"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.recoveryClaimTakeoverReadError"
          Next        = "Release lifecycle operation incomplete"
        }]
      }
      "Exact recovery claim takeover outcome matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.LockOwner.S", IsPresent = true },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.ReleaseId.S", IsPresent = true },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.ContractName.S", IsPresent = true },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.Generation.N", IsPresent = true },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.Phase.S", IsPresent = true },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.ClaimOwner.S", IsPresent = true },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.ClaimMode.S", IsPresent = true },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.LockOwner.S", StringEqualsPath = "$.recoveryLock.Lock.DeployExecutionArn" },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.ReleaseId.S", StringEqualsPath = "$.recoveryLock.Lock.ReleaseId" },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.ContractName.S", StringEqualsPath = "$.recoveryLock.Lock.ContractName" },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.Generation.N", StringEqualsPath = "$.recoveryLock.Lock.Generation" },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.Phase.S", StringEquals = "CONTRACT_READY" },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.ClaimOwner.S", StringEqualsPath = "$$.Execution.Id" },
            { Variable = "$.recoveryClaimTakeoverOutcome.Item.ClaimMode.S", StringEquals = "RECOVER" },
          ]
          Next = "Record exact recovery claim takeover"
        }]
        Default = "Release recovery rejected"
      }
      "Record exact recovery claim takeover" = {
        Type       = "Pass"
        Result     = true
        ResultPath = "$.ClaimAlreadyOwned"
        Next       = "Select exact recovery action"
      }
      "Inspect stale deploy execution" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:sfn:describeExecution"
        TimeoutSeconds = 20
        Parameters = {
          "ExecutionArn.$" = "$.recoveryLock.Lock.DeployExecutionArn"
        }
        ResultSelector = {
          "Status.$" = "$.Status"
        }
        ResultPath = "$.recoveryExecution"
        Next       = "Stale deploy execution is recoverable"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release recovery rejected"
        }]
      }
      "Stale deploy execution is recoverable" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.recoveryExecution.Status", StringEquals = "FAILED", Next = "Record failed deploy recovery" },
          { Variable = "$.recoveryExecution.Status", StringEquals = "TIMED_OUT", Next = "Record failed deploy recovery" },
          { Variable = "$.recoveryExecution.Status", StringEquals = "ABORTED", Next = "Record failed deploy recovery" },
          { Variable = "$.recoveryExecution.Status", StringEquals = "SUCCEEDED", Next = "Record terminal deploy cleanup" },
        ]
        Default = "Release recovery rejected"
      }
      "Record failed deploy recovery" = {
        Type       = "Pass"
        Result     = { CanRollback = true }
        ResultPath = "$.recoveryReason"
        Next       = "Select exact recovery action"
      }
      "Record terminal deploy cleanup" = {
        Type       = "Pass"
        Result     = { CanRollback = false }
        ResultPath = "$.recoveryReason"
        Next       = "Select exact recovery action"
      }
      "Select exact recovery action" = {
        Type = "Choice"
        Choices = concat(
          var.environment == "production" ? [{
            And = [
              { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerContractName.S", IsPresent = true },
              {
                Or = [
                  { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", StringEquals = "AWAITING_SMOKE" },
                  { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
                ]
              },
              { Variable = "$.recoveryLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.recoveryPointer.Pointer.ReleaseId" },
              { Variable = "$.recoveryLockResponse.Item.PointerContractName.S", StringEqualsPath = "$.recoveryPointer.Pointer.ContractName" },
              { Variable = "$.recoveryPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.recoveryPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.recoveryPointer.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.recoveryPointer.Pointer.ReleaseId", StringEqualsPath = "$.recoveryLock.Lock.ReleaseId" },
              { Variable = "$.recoveryPointer.Pointer.ContractName", StringEqualsPath = "$.recoveryLock.Lock.ContractName" },
              { Variable = "$.staleLifecycleClaim.Claim.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.staleLifecycleExecution.Input.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.staleLifecycleExecution.Input.ReleaseId", StringEqualsPath = "$.recoveryPointer.Pointer.ReleaseId" },
              { Variable = "$.recoveryPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256", IsPresent = true },
              { Variable = "$.recoveryPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", IsPresent = true },
              { Variable = "$.recoveryPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", IsPresent = true },
              { Variable = "$.staleLifecycleExecution.Input.FinalizationEvidence.ProductionFinalizationEvidenceSha256", StringEqualsPath = "$.recoveryPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
              { Variable = "$.staleLifecycleExecution.Input.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", StringEqualsPath = "$.recoveryPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
              { Variable = "$.staleLifecycleExecution.Input.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", StringEqualsPath = "$.recoveryPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
              {
                Or = [
                  {
                    And = [
                      { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", StringEquals = "AWAITING_SMOKE" },
                      { Variable = "$.recoveryLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
                      { Variable = "$.recoveryLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
                      { Variable = "$.recoveryLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
                    ]
                  },
                  {
                    And = [
                      { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
                      { Variable = "$.recoveryLockResponse.Item.ProductionFinalizationEvidenceSha256.S", StringEqualsPath = "$.recoveryPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
                      { Variable = "$.recoveryLockResponse.Item.GitHubEnvironmentEvidenceSha256.S", StringEqualsPath = "$.recoveryPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
                      { Variable = "$.recoveryLockResponse.Item.PromotionControlPlaneEvidenceSha256.S", StringEqualsPath = "$.recoveryPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
                    ]
                  },
                ]
              },
            ]
            Next = "Build finalized recovery cleanup claim"
          }] : [],
          var.environment == "staging" ? [{
            And = [
              { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerContractName.S", IsPresent = true },
              {
                Or = [
                  { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", StringEquals = "AWAITING_SMOKE" },
                  { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
                ]
              },
              { Variable = "$.recoveryLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.recoveryPointer.Pointer.ReleaseId" },
              { Variable = "$.recoveryLockResponse.Item.PointerContractName.S", StringEqualsPath = "$.recoveryPointer.Pointer.ContractName" },
              { Variable = "$.recoveryPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.recoveryPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.recoveryPointer.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.recoveryPointer.Pointer.ReleaseId", StringEqualsPath = "$.recoveryLock.Lock.ReleaseId" },
              { Variable = "$.recoveryPointer.Pointer.ContractName", StringEqualsPath = "$.recoveryLock.Lock.ContractName" },
              { Variable = "$.recoveryPointer.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.staleLifecycleClaim.Claim.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.staleLifecycleExecution.Input.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.staleLifecycleExecution.Input.ReleaseId", StringEqualsPath = "$.recoveryPointer.Pointer.ReleaseId" },
              { Variable = "$.recoveryLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Build finalized recovery cleanup claim"
          }] : [],
          [{
            And = [
              { Variable = "$.recoveryLockResponse.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.ReleaseId.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.ContractName.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.Generation.N", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.Phase.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.LockOwner.S", StringEqualsPath = "$.recoveryLock.Lock.DeployExecutionArn" },
              { Variable = "$.recoveryLockResponse.Item.ReleaseId.S", StringEqualsPath = "$.recoveryLock.Lock.ReleaseId" },
              { Variable = "$.recoveryLockResponse.Item.ContractName.S", StringEqualsPath = "$.recoveryLock.Lock.ContractName" },
              { Variable = "$.recoveryLockResponse.Item.Generation.N", StringEqualsPath = "$.recoveryLock.Lock.Generation" },
              { Variable = "$.recoveryLockResponse.Item.Phase.S", StringEquals = "CONTRACT_READY" },
              { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", StringEquals = "AWAITING_SMOKE" },
              { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", StringEqualsPath = "$.recoveryPointer.Pointer.Status" },
              { Variable = "$.recoveryLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.recoveryPointer.Pointer.ReleaseId" },
              { Variable = "$.recoveryLockResponse.Item.PointerContractName.S", StringEqualsPath = "$.recoveryPointer.Pointer.ContractName" },
              { Variable = "$.recoveryPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.recoveryPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.recoveryPointer.Pointer.Status", StringEquals = "AWAITING_SMOKE" },
              { Variable = "$.recoveryPointer.Pointer.ReleaseId", StringEqualsPath = "$.recoveryLock.Lock.ReleaseId" },
              { Variable = "$.recoveryPointer.Pointer.ContractName", StringEqualsPath = "$.recoveryLock.Lock.ContractName" },
              { Variable = "$.recoveryPointer.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
              {
                Or = [
                  {
                    And = [
                      { Variable = "$.ClaimAlreadyOwned", BooleanEquals = false },
                      { Variable = "$.recoveryLockResponse.Item.ClaimOwner", IsPresent = false },
                      { Variable = "$.recoveryLockResponse.Item.ClaimMode", IsPresent = false },
                    ]
                  },
                  {
                    And = [
                      { Variable = "$.ClaimAlreadyOwned", BooleanEquals = true },
                      { Variable = "$.recoveryLockResponse.Item.ClaimOwner.S", StringEqualsPath = "$$.Execution.Id" },
                      { Variable = "$.recoveryLockResponse.Item.ClaimMode.S", StringEquals = "RECOVER" },
                    ]
                  },
                ]
              },
              {
                Or = [
                  { Variable = "$.recoveryExecution.Status", StringEquals = "SUCCEEDED" },
                  { Variable = "$.recoveryExecution.Status", StringEquals = "FAILED" },
                  { Variable = "$.recoveryExecution.Status", StringEquals = "TIMED_OUT" },
                  { Variable = "$.recoveryExecution.Status", StringEquals = "ABORTED" },
                ]
              },
            ]
            Next = "Build rollback recovery claim"
          }],
          [{
            And = [
              { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.recoveryLockResponse.Item.PointerStatus.S", StringEqualsPath = "$.recoveryPointer.Pointer.Status" },
              { Variable = "$.recoveryLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.recoveryPointer.Pointer.ReleaseId" },
              { Variable = "$.recoveryLockResponse.Item.PointerContractName.S", StringEqualsPath = "$.recoveryPointer.Pointer.ContractName" },
              { Variable = "$.recoveryPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.recoveryPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.recoveryPointer.Pointer.Status", StringEquals = "ROLLED_BACK" },
              { Variable = "$.recoveryPointer.Pointer.ReleaseId", StringEqualsPath = "$.recoveryLock.Lock.ReleaseId" },
              { Variable = "$.recoveryPointer.Pointer.ContractName", StringEqualsPath = "$.recoveryLock.Lock.ContractName" },
              { Variable = "$.recoveryPointer.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.recoveryLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Build terminal recovery cleanup claim"
            },
            { Variable = "$.recoveryReason.CanRollback", BooleanEquals = true, Next = "Build rollback recovery claim" },
        ])
        Default = "Release recovery rejected"
      }
      "Build finalized recovery cleanup claim" = {
        Type = "Pass"
        Parameters = merge({
          "Contract.$"          = "$.recoveryContract.Contract"
          "ReleaseLock.$"       = "$.recoveryLock.Lock"
          "ClaimAlreadyOwned.$" = "$.ClaimAlreadyOwned"
          TerminalStatus        = "DEPLOYED"
          RecoveryAction        = "CLEANUP"
          Claim = {
            "ExecutionArn.$"       = "$$.Execution.Id"
            Mode                   = "RECOVER"
            "DeployExecutionArn.$" = "$.recoveryLock.Lock.DeployExecutionArn"
            "ReleaseId.$"          = "$.recoveryLock.Lock.ReleaseId"
            "ContractName.$"       = "$.recoveryLock.Lock.ContractName"
            "Generation.$"         = "$.recoveryLock.Lock.Generation"
          }
          }, var.environment == "production" ? {
          FinalizationEvidence = {
            "ProductionFinalizationEvidenceSha256.$" = "$.recoveryPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256"
            "GitHubEnvironmentEvidenceSha256.$"      = "$.recoveryPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256"
            "PromotionControlPlaneEvidenceSha256.$"  = "$.recoveryPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256"
          }
        } : {})
        ResultPath = "$"
        Next       = "Select recovery claim acquisition"
      }
      "Build terminal recovery cleanup claim" = {
        Type = "Pass"
        Parameters = {
          "Contract.$"          = "$.recoveryContract.Contract"
          "ReleaseLock.$"       = "$.recoveryLock.Lock"
          "ClaimAlreadyOwned.$" = "$.ClaimAlreadyOwned"
          TerminalStatus        = "ROLLED_BACK"
          RecoveryAction        = "CLEANUP"
          Claim = {
            "ExecutionArn.$"       = "$$.Execution.Id"
            Mode                   = "RECOVER"
            "DeployExecutionArn.$" = "$.recoveryLock.Lock.DeployExecutionArn"
            "ReleaseId.$"          = "$.recoveryLock.Lock.ReleaseId"
            "ContractName.$"       = "$.recoveryLock.Lock.ContractName"
            "Generation.$"         = "$.recoveryLock.Lock.Generation"
          }
        }
        ResultPath = "$"
        Next       = "Select recovery claim acquisition"
      }
      "Build rollback recovery claim" = {
        Type = "Pass"
        Parameters = {
          "Contract.$"          = "$.recoveryContract.Contract"
          "ReleaseLock.$"       = "$.recoveryLock.Lock"
          "ClaimAlreadyOwned.$" = "$.ClaimAlreadyOwned"
          RecoveryAction        = "ROLLBACK"
          Claim = {
            "ExecutionArn.$"       = "$$.Execution.Id"
            Mode                   = "RECOVER"
            "DeployExecutionArn.$" = "$.recoveryLock.Lock.DeployExecutionArn"
            "ReleaseId.$"          = "$.recoveryLock.Lock.ReleaseId"
            "ContractName.$"       = "$.recoveryLock.Lock.ContractName"
            "Generation.$"         = "$.recoveryLock.Lock.Generation"
          }
        }
        ResultPath = "$"
        Next       = "Select recovery claim acquisition"
      }
      "Select recovery claim acquisition" = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.ClaimAlreadyOwned"
          BooleanEquals = true
          Next          = "Select trusted recovery action"
        }]
        Default = "Acquire exact recovery claim"
      }
      "Acquire exact recovery claim" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "SET ClaimOwner = :claim_owner, ClaimMode = :claim_mode"
          ConditionExpression = "LockOwner = :lock_owner AND ReleaseId = :release AND ContractName = :contract AND Generation = :generation AND Phase = :ready AND attribute_not_exists(ClaimOwner)"
          ExpressionAttributeValues = {
            ":lock_owner"  = { "S.$" = "$.Claim.DeployExecutionArn" }
            ":release"     = { "S.$" = "$.Claim.ReleaseId" }
            ":contract"    = { "S.$" = "$.Claim.ContractName" }
            ":generation"  = { "N.$" = "$.Claim.Generation" }
            ":ready"       = { S = "CONTRACT_READY" }
            ":claim_owner" = { "S.$" = "$.Claim.ExecutionArn" }
            ":claim_mode"  = { S = "RECOVER" }
          }
        }
        ResultPath = null
        Next       = "Select trusted recovery action"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.recoveryClaimAcquisitionError"
          Next        = "Rebuild exact recovery request after claim ambiguity"
        }]
      }
      "Rebuild exact recovery request after claim ambiguity" = {
        Type = "Pass"
        Parameters = {
          Mode                   = "RECOVER"
          ClaimAlreadyOwned      = false
          "ReleaseId.$"          = "$.Claim.ReleaseId"
          "DeployExecutionArn.$" = "$.Claim.DeployExecutionArn"
        }
        ResultPath = "$"
        Next       = "Wait to read recovery claim acquisition"
      }
      "Wait to read recovery claim acquisition" = {
        Type    = "Wait"
        Seconds = 5
        Next    = "Load stale release lock"
      }
      "Select trusted recovery action" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.RecoveryAction", StringEquals = "CLEANUP", Next = "Select terminal recovery cleanup" },
          { Variable = "$.RecoveryAction", StringEquals = "ROLLBACK", Next = "Initialize trusted recovery rollback" },
        ]
        Default = "Release recovery rejected"
      }
      "Select terminal recovery cleanup" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.TerminalStatus", StringEquals = "DEPLOYED", Next = "Delete recovered finalized release lock" },
          { Variable = "$.TerminalStatus", StringEquals = "ROLLED_BACK", Next = "Delete recovered release lock" },
        ]
        Default = "Release recovery rejected"
      }
      "Initialize trusted recovery rollback" = {
        Type = "Pass"
        Parameters = {
          "Contract.$"       = "$.Contract"
          "ReleaseLock.$"    = "$.ReleaseLock"
          "LifecycleClaim.$" = "$.Claim"
          RollbackOutcome    = "SUCCEED"
        }
        ResultPath = "$"
        Next       = "Restore exact API"
      }
      "Delete recovered finalized release lock" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = var.environment == "production" ? "SET PointerStatus = :status, PointerReleaseId = :release, PointerContractName = :contract, ProductionFinalizationEvidenceSha256 = :production_finalization_evidence, GitHubEnvironmentEvidenceSha256 = :github_environment_evidence, PromotionControlPlaneEvidenceSha256 = :promotion_control_plane_evidence REMOVE LockOwner, ReleaseId, ContractName, Phase, ClaimOwner, ClaimMode" : "SET PointerStatus = :status, PointerReleaseId = :release, PointerContractName = :contract REMOVE LockOwner, ReleaseId, ContractName, Phase, ClaimOwner, ClaimMode, ProductionFinalizationEvidenceSha256, GitHubEnvironmentEvidenceSha256, PromotionControlPlaneEvidenceSha256"
          ConditionExpression = "LockOwner = :lock_owner AND ReleaseId = :release AND ContractName = :contract AND Generation = :generation AND Phase = :ready AND ClaimOwner = :claim_owner"
          ExpressionAttributeValues = merge({
            ":lock_owner"  = { "S.$" = "$.ReleaseLock.DeployExecutionArn" }
            ":release"     = { "S.$" = "$.ReleaseLock.ReleaseId" }
            ":contract"    = { "S.$" = "$.ReleaseLock.ContractName" }
            ":generation"  = { "N.$" = "$.ReleaseLock.Generation" }
            ":ready"       = { S = "CONTRACT_READY" }
            ":claim_owner" = { "S.$" = "$.Claim.ExecutionArn" }
            ":status"      = { S = "DEPLOYED" }
            }, var.environment == "production" ? {
            ":production_finalization_evidence" = { "S.$" = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256" }
            ":github_environment_evidence"      = { "S.$" = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" }
            ":promotion_control_plane_evidence" = { "S.$" = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" }
          } : {})
        }
        ResultPath = null
        Next       = "Release recovery completed"
        Retry = [{
          ErrorEquals     = ["DynamoDb.InternalServerError", "DynamoDB.InternalServerError", "States.Timeout"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.recoveredLockCleanupError"
          Next        = "Read recovered lock cleanup outcome"
        }]
      }
      "Delete recovered release lock" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "SET PointerStatus = :status, PointerReleaseId = :release, PointerContractName = :contract REMOVE LockOwner, ReleaseId, ContractName, Phase, ClaimOwner, ClaimMode, ProductionFinalizationEvidenceSha256, GitHubEnvironmentEvidenceSha256, PromotionControlPlaneEvidenceSha256"
          ConditionExpression = "LockOwner = :lock_owner AND ReleaseId = :release AND ContractName = :contract AND Generation = :generation AND Phase = :ready AND ClaimOwner = :claim_owner"
          ExpressionAttributeValues = {
            ":lock_owner"  = { "S.$" = "$.ReleaseLock.DeployExecutionArn" }
            ":release"     = { "S.$" = "$.ReleaseLock.ReleaseId" }
            ":contract"    = { "S.$" = "$.ReleaseLock.ContractName" }
            ":generation"  = { "N.$" = "$.ReleaseLock.Generation" }
            ":ready"       = { S = "CONTRACT_READY" }
            ":claim_owner" = { "S.$" = "$.Claim.ExecutionArn" }
            ":status"      = { "S.$" = "$.TerminalStatus" }
          }
        }
        ResultPath = null
        Next       = "Release recovery completed"
        Retry = [{
          ErrorEquals     = ["DynamoDb.InternalServerError", "DynamoDB.InternalServerError", "States.Timeout"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.recoveredLockCleanupError"
          Next        = "Read recovered lock cleanup outcome"
        }]
      }
      "Read recovered lock cleanup outcome" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.recoveredLockCleanupOutcome"
        Next       = "Select recovered lock cleanup outcome"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.recoveredLockCleanupReadError"
          Next        = "Release lifecycle operation incomplete"
        }]
      }
      "Select recovered lock cleanup outcome" = {
        Type = "Choice"
        Choices = concat(
          var.environment == "production" ? [{
            And = [
              { Variable = "$.recoveredLockCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.recoveredLockCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.ReleaseLock.Generation" },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerStatus.S", StringEqualsPath = "$.TerminalStatus" },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerReleaseId.S", StringEqualsPath = "$.ReleaseLock.ReleaseId" },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerContractName.S", StringEqualsPath = "$.ReleaseLock.ContractName" },
              { Variable = "$.recoveredLockCleanupOutcome.Item.LockOwner", IsPresent = false },
              { Variable = "$.recoveredLockCleanupOutcome.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.recoveredLockCleanupOutcome.Item.Phase", IsPresent = false },
              {
                Or = [
                  {
                    And = [
                      { Variable = "$.TerminalStatus", StringEquals = "DEPLOYED" },
                      { Variable = "$.recoveredLockCleanupOutcome.Item.ProductionFinalizationEvidenceSha256.S", IsPresent = true },
                      { Variable = "$.recoveredLockCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256.S", IsPresent = true },
                      { Variable = "$.recoveredLockCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256.S", IsPresent = true },
                      { Variable = "$.recoveredLockCleanupOutcome.Item.ProductionFinalizationEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
                      { Variable = "$.recoveredLockCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
                      { Variable = "$.recoveredLockCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
                    ]
                  },
                  {
                    And = [
                      { Variable = "$.TerminalStatus", StringEquals = "ROLLED_BACK" },
                      { Variable = "$.recoveredLockCleanupOutcome.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
                      { Variable = "$.recoveredLockCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
                      { Variable = "$.recoveredLockCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
                    ]
                  },
                ]
              },
            ]
            Next = "Release recovery completed"
          }] : [],
          var.environment == "staging" ? [{
            And = [
              { Variable = "$.recoveredLockCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.recoveredLockCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.ReleaseLock.Generation" },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerStatus.S", StringEqualsPath = "$.TerminalStatus" },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerReleaseId.S", StringEqualsPath = "$.ReleaseLock.ReleaseId" },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PointerContractName.S", StringEqualsPath = "$.ReleaseLock.ContractName" },
              { Variable = "$.recoveredLockCleanupOutcome.Item.LockOwner", IsPresent = false },
              { Variable = "$.recoveredLockCleanupOutcome.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.recoveredLockCleanupOutcome.Item.Phase", IsPresent = false },
              { Variable = "$.recoveredLockCleanupOutcome.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.recoveredLockCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.recoveredLockCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Release recovery completed"
          }] : [],
          [{
            And = [
              { Variable = "$.recoveredLockCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.recoveredLockCleanupOutcome.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.recoveredLockCleanupOutcome.Item.ClaimOwner.S", IsPresent = true },
              { Variable = "$.recoveredLockCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.ReleaseLock.Generation" },
              { Variable = "$.recoveredLockCleanupOutcome.Item.LockOwner.S", StringEqualsPath = "$.ReleaseLock.DeployExecutionArn" },
              { Variable = "$.recoveredLockCleanupOutcome.Item.ClaimOwner.S", StringEqualsPath = "$.Claim.ExecutionArn" },
            ]
            Next = "Wait to retry recovered lock cleanup"
          }]
        )
        Default = "Release lifecycle operation incomplete"
      }
      "Wait to retry recovered lock cleanup" = {
        Type    = "Wait"
        Seconds = 5
        Next    = "Select terminal recovery cleanup"
      }
      "Release recovery completed" = {
        Type = "Succeed"
      }
      "Release recovery rejected" = {
        Type  = "Fail"
        Error = "ReleaseRecoveryRejected"
        Cause = "Recovery requires an exact release ID, deploy execution, lock, immutable contract, terminal owner, and fail-closed pointer action."
      }
      "Load active release lock" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.activeReleaseCoordination"
        Next       = "Active release lock exists"
      }
      "Active release lock exists" = {
        Type = "Choice"
        Choices = concat(
          var.environment == "production" ? [{
            And = [
              { Variable = "$.activeReleaseCoordination.Item.LockOwner", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.Phase", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.Generation.N", IsPresent = true },
              { Variable = "$.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
              { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", StringEqualsPath = "$.ExpectedContractName" },
              { Variable = "$.activeReleaseCoordination.Item.ProductionFinalizationEvidenceSha256.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.GitHubEnvironmentEvidenceSha256.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PromotionControlPlaneEvidenceSha256.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.ProductionFinalizationEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
              { Variable = "$.activeReleaseCoordination.Item.GitHubEnvironmentEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
              { Variable = "$.activeReleaseCoordination.Item.PromotionControlPlaneEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
            ]
            Next = "Load idempotent finalized release pointer"
          }] : [],
          var.environment == "staging" ? [{
            And = [
              { Variable = "$.activeReleaseCoordination.Item.LockOwner", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.Phase", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.Generation.N", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
              { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", StringEqualsPath = "$.ExpectedContractName" },
              { Variable = "$.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.activeReleaseCoordination.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Load idempotent finalized release pointer"
          }] : [],
          [{
            And = [
              { Variable = "$.activeReleaseCoordination.Item.LockOwner", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.Phase", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.Generation.N", IsPresent = true },
              { Variable = "$.Mode", StringEquals = "ROLLBACK" },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", StringEquals = "ROLLED_BACK" },
              { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", StringEqualsPath = "$.ExpectedContractName" },
              { Variable = "$.activeReleaseCoordination.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Load idempotent rolled-back release pointer"
          }],
          [{
            And = [
              { Variable = "$.activeReleaseCoordination.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.ReleaseId.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.ContractName.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.Generation.N", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.Phase.S", IsPresent = true },
            ]
            Next = "Select exact active release lock"
          }],
          [{
            Variable  = "$.activeReleaseCoordination.Item.LockOwner.S"
            IsPresent = true
            Next      = "Release lifecycle request rejected"
          }]
        )
        Default = "Release lifecycle request rejected"
      }
      "Load idempotent finalized release pointer" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name = local.release_pointer_name
        }
        ResultSelector = {
          "Pointer.$" = "States.StringToJson($.Parameter.Value)"
        }
        ResultPath = "$.idempotentFinalized"
        Next       = "Idempotent finalized release pointer matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.idempotentFinalizedPointerReadError"
          Next        = "Release lifecycle request rejected"
        }]
      }
      "Idempotent finalized release pointer matches" = {
        Type = "Choice"
        Choices = concat(
          var.environment == "production" ? [{
            And = [
              { Variable = "$.idempotentFinalized.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.idempotentFinalized.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.idempotentFinalized.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.idempotentFinalized.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.idempotentFinalized.Pointer.ContractName", StringEqualsPath = "$.ExpectedContractName" },
              { Variable = "$.idempotentFinalized.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256", IsPresent = true },
              { Variable = "$.idempotentFinalized.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", IsPresent = true },
              { Variable = "$.idempotentFinalized.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", IsPresent = true },
              { Variable = "$.idempotentFinalized.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256", StringEqualsPath = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
              { Variable = "$.idempotentFinalized.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", StringEqualsPath = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
              { Variable = "$.idempotentFinalized.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", StringEqualsPath = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
            ]
            Next = "Release finalized"
          }] : [],
          var.environment == "staging" ? [{
            And = [
              { Variable = "$.idempotentFinalized.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.idempotentFinalized.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.idempotentFinalized.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.idempotentFinalized.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.idempotentFinalized.Pointer.ContractName", StringEqualsPath = "$.ExpectedContractName" },
              { Variable = "$.idempotentFinalized.Pointer.FinalizationEvidence", IsPresent = false },
            ]
            Next = "Release finalized"
          }] : []
        )
        Default = "Release lifecycle request rejected"
      }
      "Load idempotent rolled-back release pointer" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name = local.release_pointer_name
        }
        ResultSelector = {
          "Pointer.$" = "States.StringToJson($.Parameter.Value)"
        }
        ResultPath = "$.idempotentRolledBack"
        Next       = "Idempotent rolled-back release pointer matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release lifecycle request rejected"
        }]
      }
      "Idempotent rolled-back release pointer matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.idempotentRolledBack.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
            { Variable = "$.idempotentRolledBack.Pointer.Status", StringEquals = "ROLLED_BACK" },
            { Variable = "$.idempotentRolledBack.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
            { Variable = "$.idempotentRolledBack.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
            { Variable = "$.idempotentRolledBack.Pointer.ContractName", StringEqualsPath = "$.ExpectedContractName" },
            { Variable = "$.idempotentRolledBack.Pointer.FinalizationEvidence", IsPresent = false },
          ]
          Next = "Rollback succeeded"
        }]
        Default = "Release lifecycle request rejected"
      }
      "Select exact active release lock" = {
        Type = "Pass"
        Parameters = {
          Lock = {
            "DeployExecutionArn.$" = "$.activeReleaseCoordination.Item.LockOwner.S"
            "ReleaseId.$"          = "$.activeReleaseCoordination.Item.ReleaseId.S"
            "ContractName.$"       = "$.activeReleaseCoordination.Item.ContractName.S"
            "Generation.$"         = "$.activeReleaseCoordination.Item.Generation.N"
            "Phase.$"              = "$.activeReleaseCoordination.Item.Phase.S"
          }
        }
        ResultPath = "$.loadedLock"
        Next       = "Load current release pointer"
      }
      "Load current release pointer" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name = local.release_pointer_name
        }
        ResultSelector = {
          "Pointer.$" = "States.StringToJson($.Parameter.Value)"
        }
        ResultPath = "$.loaded"
        Next       = "Current release request matches"
      }
      "Current release request matches" = {
        Type = "Choice"
        Choices = concat([{
          And = [
            { Variable = "$.loadedLock.Lock.Phase", StringEquals = "CONTRACT_READY" },
            { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", IsPresent = true },
            { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", IsPresent = true },
            { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", IsPresent = true },
            { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", StringEqualsPath = "$.loaded.Pointer.Status" },
            { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", StringEqualsPath = "$.loaded.Pointer.ReleaseId" },
            { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", StringEqualsPath = "$.loaded.Pointer.ContractName" },
            { Variable = "$.loaded.Pointer.Status", StringEquals = "AWAITING_SMOKE" },
            { Variable = "$.loaded.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
            { Variable = "$.loaded.Pointer.ReleaseId", StringEqualsPath = "$.loadedLock.Lock.ReleaseId" },
            { Variable = "$.loaded.Pointer.ContractName", StringEqualsPath = "$.loadedLock.Lock.ContractName" },
            { Variable = "$.activeReleaseCoordination.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
            { Variable = "$.activeReleaseCoordination.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
            { Variable = "$.activeReleaseCoordination.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
          ]
          Next = "Load immutable current release contract"
          }],
          var.environment == "production" ? [{
            And = [
              { Variable = "$.loadedLock.Lock.Phase", StringEquals = "CONTRACT_READY" },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", StringEqualsPath = "$.loaded.Pointer.Status" },
              { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", StringEqualsPath = "$.loaded.Pointer.ReleaseId" },
              { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", StringEqualsPath = "$.loaded.Pointer.ContractName" },
              { Variable = "$.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.loaded.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.loaded.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.loaded.Pointer.ReleaseId", StringEqualsPath = "$.loadedLock.Lock.ReleaseId" },
              { Variable = "$.loaded.Pointer.ContractName", StringEqualsPath = "$.loadedLock.Lock.ContractName" },
              { Variable = "$.loaded.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256", IsPresent = true },
              { Variable = "$.loaded.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", IsPresent = true },
              { Variable = "$.loaded.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", IsPresent = true },
              { Variable = "$.loaded.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256", StringEqualsPath = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
              { Variable = "$.loaded.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", StringEqualsPath = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
              { Variable = "$.loaded.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", StringEqualsPath = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
              { Variable = "$.activeReleaseCoordination.Item.ProductionFinalizationEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
              { Variable = "$.activeReleaseCoordination.Item.GitHubEnvironmentEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
              { Variable = "$.activeReleaseCoordination.Item.PromotionControlPlaneEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
            ]
            Next = "Load immutable current release contract"
          }] : [],
          var.environment == "staging" ? [{
            And = [
              { Variable = "$.loadedLock.Lock.Phase", StringEquals = "CONTRACT_READY" },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", StringEqualsPath = "$.loaded.Pointer.ReleaseId" },
              { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", StringEqualsPath = "$.loaded.Pointer.ContractName" },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
              { Variable = "$.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.loaded.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.loaded.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.loaded.Pointer.ReleaseId", StringEqualsPath = "$.loadedLock.Lock.ReleaseId" },
              { Variable = "$.loaded.Pointer.ContractName", StringEqualsPath = "$.loadedLock.Lock.ContractName" },
              { Variable = "$.loaded.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Load immutable current release contract"
          }] : [],
          [{
            And = [
              { Variable = "$.loadedLock.Lock.Phase", StringEquals = "CONTRACT_READY" },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.PointerStatus.S", StringEqualsPath = "$.loaded.Pointer.Status" },
              { Variable = "$.activeReleaseCoordination.Item.PointerReleaseId.S", StringEqualsPath = "$.loaded.Pointer.ReleaseId" },
              { Variable = "$.activeReleaseCoordination.Item.PointerContractName.S", StringEqualsPath = "$.loaded.Pointer.ContractName" },
              { Variable = "$.Mode", StringEquals = "ROLLBACK" },
              { Variable = "$.loaded.Pointer.Status", StringEquals = "ROLLED_BACK" },
              { Variable = "$.loaded.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.loaded.Pointer.ReleaseId", StringEqualsPath = "$.loadedLock.Lock.ReleaseId" },
              { Variable = "$.loaded.Pointer.ContractName", StringEqualsPath = "$.loadedLock.Lock.ContractName" },
              { Variable = "$.loaded.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.activeReleaseCoordination.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Load immutable current release contract"
          }]
        )
        Default = "Release lifecycle request rejected"
      }
      "Release lifecycle request rejected" = {
        Type  = "Fail"
        Error = "ReleaseLifecycleRequestRejected"
        Cause = "The requested release does not own the awaiting-smoke environment lock."
      }
      "Build finalized release pointer" = {
        Type = "Pass"
        Parameters = {
          Pointer = merge({
            SchemaVersion    = "aeostudio.release-pointer.v1"
            Status           = "DEPLOYED"
            BrokerArn        = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release"
            "ReleaseId.$"    = "$.loaded.Pointer.ReleaseId"
            "ContractName.$" = "$.loaded.Pointer.ContractName"
            }, var.environment == "production" ? {
            FinalizationEvidence = {
              "ProductionFinalizationEvidenceSha256.$" = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256"
              "GitHubEnvironmentEvidenceSha256.$"      = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256"
              "PromotionControlPlaneEvidenceSha256.$"  = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256"
            }
          } : {})
        }
        ResultPath = "$.finalized"
        Next       = "Serialize finalized release pointer"
      }
      "Serialize finalized release pointer" = {
        Type = "Pass"
        Parameters = {
          "Pointer.$"     = "$.finalized.Pointer"
          "PointerJson.$" = "States.JsonToString($.finalized.Pointer)"
        }
        ResultPath = "$.finalized"
        Next       = "Mark release finalized"
      }
      "Mark release finalized" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:putParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name      = local.release_pointer_name
          Type      = "String"
          "Value.$" = "$.finalized.PointerJson"
          Overwrite = true
        }
        ResultPath = null
        Next       = "Delete finalized release lock"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.finalizedPointerWriteError"
          Next        = "Read possibly finalized release pointer"
        }]
      }
      "Delete finalized release lock" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = var.environment == "production" ? "SET PointerStatus = :status, PointerReleaseId = :release, PointerContractName = :contract, ProductionFinalizationEvidenceSha256 = :production_finalization_evidence, GitHubEnvironmentEvidenceSha256 = :github_environment_evidence, PromotionControlPlaneEvidenceSha256 = :promotion_control_plane_evidence REMOVE LockOwner, ReleaseId, ContractName, Phase, ClaimOwner, ClaimMode" : "SET PointerStatus = :status, PointerReleaseId = :release, PointerContractName = :contract REMOVE LockOwner, ReleaseId, ContractName, Phase, ClaimOwner, ClaimMode, ProductionFinalizationEvidenceSha256, GitHubEnvironmentEvidenceSha256, PromotionControlPlaneEvidenceSha256"
          ConditionExpression = "LockOwner = :lock_owner AND ReleaseId = :release AND ContractName = :contract AND Generation = :generation AND Phase = :ready AND ClaimOwner = :claim_owner"
          ExpressionAttributeValues = merge({
            ":lock_owner"  = { "S.$" = "$.loadedLock.Lock.DeployExecutionArn" }
            ":release"     = { "S.$" = "$.loadedLock.Lock.ReleaseId" }
            ":contract"    = { "S.$" = "$.loadedLock.Lock.ContractName" }
            ":generation"  = { "N.$" = "$.loadedLock.Lock.Generation" }
            ":ready"       = { S = "CONTRACT_READY" }
            ":claim_owner" = { "S.$" = "$.lifecycleClaim.Claim.ExecutionArn" }
            ":status"      = { S = "DEPLOYED" }
            }, var.environment == "production" ? {
            ":production_finalization_evidence" = { "S.$" = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256" }
            ":github_environment_evidence"      = { "S.$" = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" }
            ":promotion_control_plane_evidence" = { "S.$" = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" }
          } : {})
        }
        Next = "Release finalized"
        Retry = [{
          ErrorEquals     = ["DynamoDb.InternalServerError", "DynamoDB.InternalServerError", "States.Timeout"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.finalizedLockCleanupError"
          Next        = "Read finalized lock cleanup outcome"
        }]
      }
      "Read finalized lock cleanup outcome" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.finalizedLockCleanupOutcome"
        Next       = "Select finalized lock cleanup outcome"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.finalizedLockCleanupReadError"
          Next        = "Release lifecycle operation incomplete"
        }]
      }
      "Select finalized lock cleanup outcome" = {
        Type = "Choice"
        Choices = concat(
          var.environment == "production" ? [{
            And = [
              { Variable = "$.finalizedLockCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.finalizedLockCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.loadedLock.Lock.Generation" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PointerReleaseId.S", StringEqualsPath = "$.loadedLock.Lock.ReleaseId" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PointerContractName.S", StringEqualsPath = "$.loadedLock.Lock.ContractName" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.LockOwner", IsPresent = false },
              { Variable = "$.finalizedLockCleanupOutcome.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.finalizedLockCleanupOutcome.Item.Phase", IsPresent = false },
              { Variable = "$.finalizedLockCleanupOutcome.Item.ProductionFinalizationEvidenceSha256.S", IsPresent = true },
              { Variable = "$.finalizedLockCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256.S", IsPresent = true },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256.S", IsPresent = true },
              { Variable = "$.finalizedLockCleanupOutcome.Item.ProductionFinalizationEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256.S", StringEqualsPath = "$.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
            ]
            Next = "Release finalized"
          }] : [],
          var.environment == "staging" ? [{
            And = [
              { Variable = "$.finalizedLockCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PointerReleaseId.S", StringEqualsPath = "$.loadedLock.Lock.ReleaseId" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PointerContractName.S", StringEqualsPath = "$.loadedLock.Lock.ContractName" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.loadedLock.Lock.Generation" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.LockOwner", IsPresent = false },
              { Variable = "$.finalizedLockCleanupOutcome.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.finalizedLockCleanupOutcome.Item.Phase", IsPresent = false },
              { Variable = "$.finalizedLockCleanupOutcome.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.finalizedLockCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.finalizedLockCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Release finalized"
          }] : [],
          [{
            And = [
              { Variable = "$.finalizedLockCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.finalizedLockCleanupOutcome.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.finalizedLockCleanupOutcome.Item.ClaimOwner.S", IsPresent = true },
              { Variable = "$.finalizedLockCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.loadedLock.Lock.Generation" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.LockOwner.S", StringEqualsPath = "$.loadedLock.Lock.DeployExecutionArn" },
              { Variable = "$.finalizedLockCleanupOutcome.Item.ClaimOwner.S", StringEqualsPath = "$.lifecycleClaim.Claim.ExecutionArn" },
            ]
            Next = "Wait to retry finalized lock cleanup"
          }]
        )
        Default = "Release lifecycle operation incomplete"
      }
      "Wait to retry finalized lock cleanup" = {
        Type    = "Wait"
        Seconds = 5
        Next    = "Delete finalized release lock"
      }
      "Release finalized" = {
        Type = "Succeed"
      }
      "Release lifecycle operation incomplete" = {
        Type  = "Fail"
        Error = "ReleaseLifecycleOperationIncomplete"
        Cause = "The environment remains fail-closed behind its release lock and requires the fixed recovery capability."
      }
      "Load immutable current release contract" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          "Name.$" = "$.loaded.Pointer.ContractName"
        }
        ResultSelector = {
          "Contract.$" = "States.StringToJson($.Parameter.Value)"
        }
        ResultPath = "$.immutable"
        Next       = "Immutable release contract matches lifecycle request"
      }
      "Immutable release contract matches lifecycle request" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.immutable.Contract.ReleaseId", StringEqualsPath = "$.ReleaseId" },
            { Variable = "$.immutable.Contract.ContractName", StringEqualsPath = "$.loaded.Pointer.ContractName" },
            { Variable = "$.immutable.Contract.Environment", StringEquals = var.environment },
          ]
          Next = "Build exact release lifecycle claim"
        }]
        Default = "Release lifecycle request rejected"
      }
      "Build exact release lifecycle claim" = {
        Type = "Pass"
        Parameters = {
          Claim = {
            "ExecutionArn.$"       = "$$.Execution.Id"
            "Mode.$"               = "$.Mode"
            "DeployExecutionArn.$" = "$.loadedLock.Lock.DeployExecutionArn"
            "ReleaseId.$"          = "$.ReleaseId"
            "ContractName.$"       = "$.loaded.Pointer.ContractName"
            "Generation.$"         = "$.loadedLock.Lock.Generation"
          }
        }
        ResultPath = "$.lifecycleClaim"
        Next       = "Select current lifecycle claim ownership"
      }
      "Select current lifecycle claim ownership" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.activeReleaseCoordination.Item.ClaimOwner.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.ClaimMode.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.ClaimOwner.S", StringEqualsPath = "$.lifecycleClaim.Claim.ExecutionArn" },
              { Variable = "$.activeReleaseCoordination.Item.ClaimMode.S", StringEqualsPath = "$.lifecycleClaim.Claim.Mode" },
            ]
            Next = "Select trusted lifecycle operation"
          },
          {
            And = [
              { Variable = "$.activeReleaseCoordination.Item.ClaimOwner.S", IsPresent = true },
              { Variable = "$.activeReleaseCoordination.Item.ClaimMode.S", IsPresent = true },
            ]
            Next = "Build exact competing lifecycle claim"
          },
        ]
        Default = "Acquire exact release lifecycle claim"
      }
      "Build exact competing lifecycle claim" = {
        Type = "Pass"
        Parameters = {
          "ExecutionArn.$" = "$.activeReleaseCoordination.Item.ClaimOwner.S"
          "Mode.$"         = "$.activeReleaseCoordination.Item.ClaimMode.S"
        }
        ResultPath = "$.competingLifecycleClaim"
        Next       = "Exact competing lifecycle claim is valid"
      }
      "Exact competing lifecycle claim is valid" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.competingLifecycleClaim.ExecutionArn", StringMatches = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:*" },
            {
              Or = [
                { Variable = "$.competingLifecycleClaim.Mode", StringEquals = "FINALIZE" },
                { Variable = "$.competingLifecycleClaim.Mode", StringEquals = "ROLLBACK" },
                { Variable = "$.competingLifecycleClaim.Mode", StringEquals = "RECOVER" },
              ]
            },
          ]
          Next = "Inspect exact competing lifecycle execution"
        }]
        Default = "Release lifecycle request rejected"
      }
      "Inspect exact competing lifecycle execution" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:sfn:describeExecution"
        TimeoutSeconds = 20
        Parameters = {
          "ExecutionArn.$" = "$.competingLifecycleClaim.ExecutionArn"
        }
        ResultSelector = {
          "Status.$" = "$.Status"
        }
        ResultPath = "$.competingLifecycleExecution"
        Next       = "Wait for competing lifecycle convergence"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.competingLifecycleInspectionError"
          Next        = "Release lifecycle request rejected"
        }]
      }
      "Wait for competing lifecycle convergence" = {
        Type    = "Wait"
        Seconds = 15
        Next    = "Load active release lock"
      }
      "Acquire exact release lifecycle claim" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "SET ClaimOwner = :claim_owner, ClaimMode = :claim_mode"
          ConditionExpression = "LockOwner = :lock_owner AND ReleaseId = :release AND ContractName = :contract AND Generation = :generation AND Phase = :ready AND attribute_not_exists(ClaimOwner)"
          ExpressionAttributeValues = {
            ":lock_owner"  = { "S.$" = "$.lifecycleClaim.Claim.DeployExecutionArn" }
            ":release"     = { "S.$" = "$.lifecycleClaim.Claim.ReleaseId" }
            ":contract"    = { "S.$" = "$.lifecycleClaim.Claim.ContractName" }
            ":generation"  = { "N.$" = "$.lifecycleClaim.Claim.Generation" }
            ":ready"       = { S = "CONTRACT_READY" }
            ":claim_owner" = { "S.$" = "$.lifecycleClaim.Claim.ExecutionArn" }
            ":claim_mode"  = { "S.$" = "$.lifecycleClaim.Claim.Mode" }
          }
        }
        ResultPath = null
        Next       = "Select trusted lifecycle operation"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.lifecycleClaimAcquisitionError"
          Next        = "Wait to read lifecycle claim acquisition"
        }]
      }
      "Wait to read lifecycle claim acquisition" = {
        Type    = "Wait"
        Seconds = 5
        Next    = "Load active release lock"
      }
      "Select trusted lifecycle operation" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.loaded.Pointer.Status", StringEquals = "AWAITING_SMOKE" },
            ]
            Next = "Build finalized release pointer"
          },
          {
            And = [
              { Variable = "$.Mode", StringEquals = "ROLLBACK" },
              { Variable = "$.loaded.Pointer.Status", StringEquals = "AWAITING_SMOKE" },
            ]
            Next = "Initialize trusted rollback state"
          },
          {
            And = [
              { Variable = "$.Mode", StringEquals = "FINALIZE" },
              { Variable = "$.loaded.Pointer.Status", StringEquals = "DEPLOYED" },
            ]
            Next = "Delete finalized release lock"
          },
          {
            And = [
              { Variable = "$.Mode", StringEquals = "ROLLBACK" },
              { Variable = "$.loaded.Pointer.Status", StringEquals = "ROLLED_BACK" },
            ]
            Next = "Delete rollback release lock"
          },
        ]
        Default = "Release lifecycle request rejected"
      }
      "Initialize trusted rollback state" = {
        Type = "Pass"
        Parameters = {
          "Contract.$"       = "$.immutable.Contract"
          "ReleaseLock.$"    = "$.loadedLock.Lock"
          "LifecycleClaim.$" = "$.lifecycleClaim.Claim"
          RollbackOutcome    = "SUCCEED"
        }
        ResultPath = "$"
        Next       = "Restore exact API"
      }
      "Run exact migration" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 900
        Parameters = {
          Cluster            = aws_ecs_cluster.main.arn
          "TaskDefinition.$" = "$.Contract.TaskDefinitions.Migration"
          LaunchType         = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.migration.id]
              Subnets        = aws_subnet.private[*].id
            }
          }
        }
        ResultSelector = {
          "FailureCount.$" = "States.ArrayLength($.Failures)"
          "TaskCount.$"    = "States.ArrayLength($.Tasks)"
          "Tasks.$"        = "$.Tasks"
        }
        ResultPath = "$.migrationRun"
        Next       = "Exact migration task started"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Migration container failed"
        }]
      }
      "Exact migration task started" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.migrationRun.FailureCount", NumericEquals = 0 },
            { Variable = "$.migrationRun.TaskCount", NumericEquals = 1 },
          ]
          Next = "Capture exact migration task ARN"
        }]
        Default = "Migration container failed"
      }
      "Capture exact migration task ARN" = {
        Type = "Pass"
        Parameters = {
          "TaskArn.$" = "$.migrationRun.Tasks[0].TaskArn"
        }
        ResultPath = "$.migrationRun"
        Next       = "Describe exact migration task"
      }
      "Describe exact migration task" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:describeTasks"
        TimeoutSeconds = 30
        Parameters = {
          Cluster   = aws_ecs_cluster.main.arn
          "Tasks.$" = "States.Array($.migrationRun.TaskArn)"
        }
        ResultSelector = {
          "FailureCount.$" = "States.ArrayLength($.Failures)"
          "TaskCount.$"    = "States.ArrayLength($.Tasks)"
          "Tasks.$"        = "$.Tasks"
        }
        ResultPath = "$.migrationResponse"
        Next       = "Exact migration task described"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Migration container failed"
        }]
      }
      "Exact migration task described" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.migrationResponse.FailureCount", NumericEquals = 0 },
            { Variable = "$.migrationResponse.TaskCount", NumericEquals = 1 },
          ]
          Next = "Select exact migration task"
        }]
        Default = "Migration container failed"
      }
      "Select exact migration task" = {
        Type = "Pass"
        Parameters = {
          "TaskDefinitionArn.$" = "$.migrationResponse.Tasks[0].TaskDefinitionArn"
          "LastStatus.$"        = "$.migrationResponse.Tasks[0].LastStatus"
          "ContainerCount.$"    = "States.ArrayLength($.migrationResponse.Tasks[0].Containers)"
          "Containers.$"        = "$.migrationResponse.Tasks[0].Containers"
        }
        ResultPath = "$.migration"
        Next       = "Exact migration container present"
      }
      "Exact migration container present" = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.migration.ContainerCount"
          NumericEquals = 1
          Next          = "Select exact migration container"
        }]
        Default = "Migration container failed"
      }
      "Select exact migration container" = {
        Type = "Pass"
        Parameters = {
          "ContainerName.$" = "$.migration.Containers[0].Name"
          "ExitCode.$"      = "$.migration.Containers[0].ExitCode"
        }
        ResultPath = "$.migrationContainer"
        Next       = "Migration container succeeded"
      }
      "Migration container succeeded" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.migration.TaskDefinitionArn", StringEqualsPath = "$.Contract.TaskDefinitions.Migration" },
            { Variable = "$.migration.LastStatus", StringEquals = "STOPPED" },
            { Variable = "$.migrationContainer.ContainerName", StringEquals = "migration" },
            { Variable = "$.migrationContainer.ExitCode", NumericEquals = 0 },
          ]
          Next = "Activate exact API"
        }]
        Default = "Migration container failed"
      }
      "Migration container failed" = {
        Type  = "Fail"
        Error = "MigrationContainerFailed"
        Cause = "The exact migration result is uncertain or failed; the lock is retained for deterministic watchdog recovery."
      }
      "Activate exact API" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:updateService"
        TimeoutSeconds = 15
        Parameters = {
          Cluster            = aws_ecs_cluster.main.arn
          Service            = aws_ecs_service.api.name
          "TaskDefinition.$" = "$.Contract.TaskDefinitions.Api"
        }
        ResultPath = null
        Next       = "Activate exact Web"
        Retry = [{
          ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.apiActivationError"
          Next        = "Restore exact API"
        }]
      }
      "Activate exact Web" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:updateService"
        TimeoutSeconds = 15
        Parameters = {
          Cluster            = aws_ecs_cluster.main.arn
          Service            = aws_ecs_service.web.name
          "TaskDefinition.$" = "$.Contract.TaskDefinitions.Web"
        }
        ResultPath = null
        Next       = "Activate exact Worker"
        Retry = [{
          ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.webActivationError"
          Next        = "Restore exact API"
        }]
      }
      "Activate exact Worker" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:updateService"
        TimeoutSeconds = 15
        Parameters = {
          Cluster            = aws_ecs_cluster.main.arn
          Service            = aws_ecs_service.worker.name
          "TaskDefinition.$" = "$.Contract.TaskDefinitions.Worker"
        }
        ResultPath = null
        Next       = "Activate exact Tenant Data Broker"
        Retry = [{
          ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.workerActivationError"
          Next        = "Restore exact API"
        }]
      }
      "Activate exact Tenant Data Broker" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:updateService"
        TimeoutSeconds = 15
        Parameters = {
          Cluster            = aws_ecs_cluster.main.arn
          Service            = aws_ecs_service.tenant_data_broker.name
          "TaskDefinition.$" = "$.Contract.TaskDefinitions.TenantDataBroker"
        }
        ResultPath = null
        Next       = "Initialize rollout stability attempts"
        Retry = [{
          ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.tenantDataBrokerActivationError"
          Next        = "Restore exact API"
        }]
      }
      "Initialize rollout stability attempts" = {
        Type       = "Pass"
        Result     = { Attempt = 0 }
        ResultPath = "$.stability"
        Next       = "Wait for exact release services"
      }
      "Wait for exact release services" = {
        Type    = "Wait"
        Seconds = 10
        Next    = "Describe exact release services"
      }
      "Describe exact release services" = {
        Type = "Parallel"
        Branches = [
          {
            StartAt = "Describe exact release API service"
            States = {
              "Describe exact release API service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 10
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.api.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact release API response count"
                Retry = [{
                  ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
                  IntervalSeconds = 2
                  BackoffRate     = 2
                  MaxAttempts     = 1
                }]
              }
              "Exact release API response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact release API service"
                }]
                Default = "Release API response invalid"
              }
              "Select exact release API service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Release API response invalid" = {
                Type  = "Fail"
                Error = "ReleaseApiServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe exact release Web service"
            States = {
              "Describe exact release Web service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 10
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.web.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact release Web response count"
                Retry = [{
                  ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
                  IntervalSeconds = 2
                  BackoffRate     = 2
                  MaxAttempts     = 1
                }]
              }
              "Exact release Web response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact release Web service"
                }]
                Default = "Release Web response invalid"
              }
              "Select exact release Web service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Release Web response invalid" = {
                Type  = "Fail"
                Error = "ReleaseWebServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe exact release Worker service"
            States = {
              "Describe exact release Worker service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 10
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.worker.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact release Worker response count"
                Retry = [{
                  ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
                  IntervalSeconds = 2
                  BackoffRate     = 2
                  MaxAttempts     = 1
                }]
              }
              "Exact release Worker response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact release Worker service"
                }]
                Default = "Release Worker response invalid"
              }
              "Select exact release Worker service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Release Worker response invalid" = {
                Type  = "Fail"
                Error = "ReleaseWorkerServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe exact release Tenant Data Broker service"
            States = {
              "Describe exact release Tenant Data Broker service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 10
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.tenant_data_broker.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact release Tenant Data Broker response count"
                Retry = [{
                  ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
                  IntervalSeconds = 2
                  BackoffRate     = 2
                  MaxAttempts     = 1
                }]
              }
              "Exact release Tenant Data Broker response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact release Tenant Data Broker service"
                }]
                Default = "Release Tenant Data Broker response invalid"
              }
              "Select exact release Tenant Data Broker service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Release Tenant Data Broker response invalid" = {
                Type  = "Fail"
                Error = "ReleaseTenantDataBrokerServiceDescriptionInvalid"
              }
            }
          },
        ]
        ResultSelector = {
          "Api.$"              = "$[0]"
          "Web.$"              = "$[1]"
          "Worker.$"           = "$[2]"
          "TenantDataBroker.$" = "$[3]"
        }
        ResultPath = "$.serviceResponses"
        Next       = "Exact release service response complete"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.serviceObservationError"
          Next        = "Restore exact API"
        }]
      }
      "Exact release service response complete" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.serviceResponses.Api.FailureCount", NumericEquals = 0 },
              { Variable = "$.serviceResponses.Api.ServiceCount", NumericEquals = 1 },
              { Variable = "$.serviceResponses.Web.FailureCount", NumericEquals = 0 },
              { Variable = "$.serviceResponses.Web.ServiceCount", NumericEquals = 1 },
              { Variable = "$.serviceResponses.Worker.FailureCount", NumericEquals = 0 },
              { Variable = "$.serviceResponses.Worker.ServiceCount", NumericEquals = 1 },
              { Variable = "$.serviceResponses.TenantDataBroker.FailureCount", NumericEquals = 0 },
              { Variable = "$.serviceResponses.TenantDataBroker.ServiceCount", NumericEquals = 1 },
            ]
            Next = "Select exact release service summaries"
          },
          { Variable = "$.stability.Attempt", NumericGreaterThanEquals = 15, Next = "Restore exact API" },
        ]
        Default = "Increment rollout stability attempt"
      }
      "Select exact release service summaries" = {
        Type = "Pass"
        Parameters = {
          FailureCount                               = 0
          ServiceCount                               = 4
          "ApiName.$"                                = "$.serviceResponses.Api.Service.ServiceName"
          "ApiTaskDefinition.$"                      = "$.serviceResponses.Api.Service.TaskDefinition"
          "ApiDesiredCount.$"                        = "$.serviceResponses.Api.Service.DesiredCount"
          "ApiRunningCount.$"                        = "$.serviceResponses.Api.Service.RunningCount"
          "ApiPendingCount.$"                        = "$.serviceResponses.Api.Service.PendingCount"
          "ApiPrimaryDeploymentCount.$"              = "States.ArrayLength($.serviceResponses.Api.Service.Deployments)"
          "ApiDeployments.$"                         = "$.serviceResponses.Api.Service.Deployments"
          "WebName.$"                                = "$.serviceResponses.Web.Service.ServiceName"
          "WebTaskDefinition.$"                      = "$.serviceResponses.Web.Service.TaskDefinition"
          "WebDesiredCount.$"                        = "$.serviceResponses.Web.Service.DesiredCount"
          "WebRunningCount.$"                        = "$.serviceResponses.Web.Service.RunningCount"
          "WebPendingCount.$"                        = "$.serviceResponses.Web.Service.PendingCount"
          "WebPrimaryDeploymentCount.$"              = "States.ArrayLength($.serviceResponses.Web.Service.Deployments)"
          "WebDeployments.$"                         = "$.serviceResponses.Web.Service.Deployments"
          "WorkerName.$"                             = "$.serviceResponses.Worker.Service.ServiceName"
          "WorkerTaskDefinition.$"                   = "$.serviceResponses.Worker.Service.TaskDefinition"
          "WorkerDesiredCount.$"                     = "$.serviceResponses.Worker.Service.DesiredCount"
          "WorkerRunningCount.$"                     = "$.serviceResponses.Worker.Service.RunningCount"
          "WorkerPendingCount.$"                     = "$.serviceResponses.Worker.Service.PendingCount"
          "WorkerPrimaryDeploymentCount.$"           = "States.ArrayLength($.serviceResponses.Worker.Service.Deployments)"
          "WorkerDeployments.$"                      = "$.serviceResponses.Worker.Service.Deployments"
          "TenantDataBrokerName.$"                   = "$.serviceResponses.TenantDataBroker.Service.ServiceName"
          "TenantDataBrokerTaskDefinition.$"         = "$.serviceResponses.TenantDataBroker.Service.TaskDefinition"
          "TenantDataBrokerDesiredCount.$"           = "$.serviceResponses.TenantDataBroker.Service.DesiredCount"
          "TenantDataBrokerRunningCount.$"           = "$.serviceResponses.TenantDataBroker.Service.RunningCount"
          "TenantDataBrokerPendingCount.$"           = "$.serviceResponses.TenantDataBroker.Service.PendingCount"
          "TenantDataBrokerPrimaryDeploymentCount.$" = "States.ArrayLength($.serviceResponses.TenantDataBroker.Service.Deployments)"
          "TenantDataBrokerDeployments.$"            = "$.serviceResponses.TenantDataBroker.Service.Deployments"
        }
        ResultPath = "$.services"
        Next       = "Exact release deployment count complete"
      }
      "Exact release deployment count complete" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.services.ApiPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.services.WebPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.services.WorkerPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.services.TenantDataBrokerPrimaryDeploymentCount", NumericEquals = 1 },
            ]
            Next = "Capture exact release deployment states"
          },
          { Variable = "$.stability.Attempt", NumericGreaterThanEquals = 15, Next = "Restore exact API" },
        ]
        Default = "Increment rollout stability attempt"
      }
      "Capture exact release deployment states" = {
        Type = "Pass"
        Parameters = {
          "ApiDeploymentStatus.$"              = "$.services.ApiDeployments[0].Status"
          "ApiRolloutState.$"                  = "$.services.ApiDeployments[0].RolloutState"
          "WebDeploymentStatus.$"              = "$.services.WebDeployments[0].Status"
          "WebRolloutState.$"                  = "$.services.WebDeployments[0].RolloutState"
          "WorkerDeploymentStatus.$"           = "$.services.WorkerDeployments[0].Status"
          "WorkerRolloutState.$"               = "$.services.WorkerDeployments[0].RolloutState"
          "TenantDataBrokerDeploymentStatus.$" = "$.services.TenantDataBrokerDeployments[0].Status"
          "TenantDataBrokerRolloutState.$"     = "$.services.TenantDataBrokerDeployments[0].RolloutState"
        }
        ResultPath = "$.deploymentStates"
        Next       = "Exact release services stable"
      }
      "Exact release services stable" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.services.FailureCount", NumericEquals = 0 },
              { Variable = "$.services.ServiceCount", NumericEquals = 4 },
              { Variable = "$.services.ApiName", StringEquals = aws_ecs_service.api.name },
              { Variable = "$.services.ApiTaskDefinition", StringEqualsPath = "$.Contract.TaskDefinitions.Api" },
              { Variable = "$.services.ApiDesiredCount", NumericEquals = 2 },
              { Variable = "$.services.ApiRunningCount", NumericEquals = 2 },
              { Variable = "$.services.ApiPendingCount", NumericEquals = 0 },
              { Variable = "$.services.ApiPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.deploymentStates.ApiDeploymentStatus", StringEquals = "PRIMARY" },
              { Variable = "$.deploymentStates.ApiRolloutState", StringEquals = "COMPLETED" },
              { Variable = "$.services.WebName", StringEquals = aws_ecs_service.web.name },
              { Variable = "$.services.WebTaskDefinition", StringEqualsPath = "$.Contract.TaskDefinitions.Web" },
              { Variable = "$.services.WebDesiredCount", NumericEquals = 2 },
              { Variable = "$.services.WebRunningCount", NumericEquals = 2 },
              { Variable = "$.services.WebPendingCount", NumericEquals = 0 },
              { Variable = "$.services.WebPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.deploymentStates.WebDeploymentStatus", StringEquals = "PRIMARY" },
              { Variable = "$.deploymentStates.WebRolloutState", StringEquals = "COMPLETED" },
              { Variable = "$.services.WorkerName", StringEquals = aws_ecs_service.worker.name },
              { Variable = "$.services.WorkerTaskDefinition", StringEqualsPath = "$.Contract.TaskDefinitions.Worker" },
              { Variable = "$.services.WorkerDesiredCount", NumericEquals = 2 },
              { Variable = "$.services.WorkerRunningCount", NumericEquals = 2 },
              { Variable = "$.services.WorkerPendingCount", NumericEquals = 0 },
              { Variable = "$.services.WorkerPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.deploymentStates.WorkerDeploymentStatus", StringEquals = "PRIMARY" },
              { Variable = "$.deploymentStates.WorkerRolloutState", StringEquals = "COMPLETED" },
              { Variable = "$.services.TenantDataBrokerName", StringEquals = aws_ecs_service.tenant_data_broker.name },
              { Variable = "$.services.TenantDataBrokerTaskDefinition", StringEqualsPath = "$.Contract.TaskDefinitions.TenantDataBroker" },
              { Variable = "$.services.TenantDataBrokerDesiredCount", NumericEquals = 2 },
              { Variable = "$.services.TenantDataBrokerRunningCount", NumericEquals = 2 },
              { Variable = "$.services.TenantDataBrokerPendingCount", NumericEquals = 0 },
              { Variable = "$.services.TenantDataBrokerPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.deploymentStates.TenantDataBrokerDeploymentStatus", StringEquals = "PRIMARY" },
              { Variable = "$.deploymentStates.TenantDataBrokerRolloutState", StringEquals = "COMPLETED" },
            ]
            Next = "Initialize API target health attempts"
          },
          {
            Variable                 = "$.stability.Attempt"
            NumericGreaterThanEquals = 15
            Next                     = "Restore exact API"
          },
        ]
        Default = "Increment rollout stability attempt"
      }
      "Increment rollout stability attempt" = {
        Type = "Pass"
        Parameters = {
          "Attempt.$" = "States.MathAdd($.stability.Attempt, 1)"
        }
        ResultPath = "$.stability"
        Next       = "Wait for exact release services"
      }
      "Initialize API target health attempts" = {
        Type       = "Pass"
        Result     = { Attempt = 0 }
        ResultPath = "$.apiTargetStability"
        Next       = "Describe exact API target health"
      }
      "Describe exact API target health" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:elasticloadbalancingv2:describeTargetHealth"
        TimeoutSeconds = 10
        Parameters = {
          TargetGroupArn = aws_lb_target_group.api.arn
        }
        ResultSelector = {
          "TargetCount.$" = "States.ArrayLength($.TargetHealthDescriptions)"
          "Targets.$"     = "$.TargetHealthDescriptions"
        }
        ResultPath = "$.apiTargets"
        Next       = "Exact API target count available"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.apiTargetObservationError"
          Next        = "Restore exact API"
        }]
      }
      "Exact API target count available" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.apiTargets.TargetCount", NumericEquals = 2, Next = "Capture exact API target states" },
          { Variable = "$.apiTargetStability.Attempt", NumericGreaterThanEquals = 15, Next = "Restore exact API" },
        ]
        Default = "Increment API target health attempt"
      }
      "Capture exact API target states" = {
        Type = "Pass"
        Parameters = {
          "TargetOneState.$" = "$.apiTargets.Targets[0].TargetHealth.State"
          "TargetTwoState.$" = "$.apiTargets.Targets[1].TargetHealth.State"
        }
        ResultPath = "$.apiTargetStates"
        Next       = "Exact API targets healthy"
      }
      "Exact API targets healthy" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.apiTargetStates.TargetOneState", StringEquals = "healthy" },
              { Variable = "$.apiTargetStates.TargetTwoState", StringEquals = "healthy" },
            ]
            Next = "Initialize Web target health attempts"
          },
          {
            Variable                 = "$.apiTargetStability.Attempt"
            NumericGreaterThanEquals = 15
            Next                     = "Restore exact API"
          },
        ]
        Default = "Increment API target health attempt"
      }
      "Increment API target health attempt" = {
        Type = "Pass"
        Parameters = {
          "Attempt.$" = "States.MathAdd($.apiTargetStability.Attempt, 1)"
        }
        ResultPath = "$.apiTargetStability"
        Next       = "Wait for exact API targets"
      }
      "Wait for exact API targets" = {
        Type    = "Wait"
        Seconds = 10
        Next    = "Describe exact API target health"
      }
      "Initialize Web target health attempts" = {
        Type       = "Pass"
        Result     = { Attempt = 0 }
        ResultPath = "$.webTargetStability"
        Next       = "Describe exact Web target health"
      }
      "Describe exact Web target health" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:elasticloadbalancingv2:describeTargetHealth"
        TimeoutSeconds = 10
        Parameters = {
          TargetGroupArn = aws_lb_target_group.web.arn
        }
        ResultSelector = {
          "TargetCount.$" = "States.ArrayLength($.TargetHealthDescriptions)"
          "Targets.$"     = "$.TargetHealthDescriptions"
        }
        ResultPath = "$.webTargets"
        Next       = "Exact Web target count available"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.webTargetObservationError"
          Next        = "Restore exact API"
        }]
      }
      "Exact Web target count available" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.webTargets.TargetCount", NumericEquals = 2, Next = "Capture exact Web target states" },
          { Variable = "$.webTargetStability.Attempt", NumericGreaterThanEquals = 15, Next = "Restore exact API" },
        ]
        Default = "Increment Web target health attempt"
      }
      "Capture exact Web target states" = {
        Type = "Pass"
        Parameters = {
          "TargetOneState.$" = "$.webTargets.Targets[0].TargetHealth.State"
          "TargetTwoState.$" = "$.webTargets.Targets[1].TargetHealth.State"
        }
        ResultPath = "$.webTargetStates"
        Next       = "Exact Web targets healthy"
      }
      "Exact Web targets healthy" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.webTargetStates.TargetOneState", StringEquals = "healthy" },
              { Variable = "$.webTargetStates.TargetTwoState", StringEquals = "healthy" },
            ]
            Next = "Initialize Tenant Data Broker target health attempts"
          },
          {
            Variable                 = "$.webTargetStability.Attempt"
            NumericGreaterThanEquals = 15
            Next                     = "Restore exact API"
          },
        ]
        Default = "Increment Web target health attempt"
      }
      "Increment Web target health attempt" = {
        Type = "Pass"
        Parameters = {
          "Attempt.$" = "States.MathAdd($.webTargetStability.Attempt, 1)"
        }
        ResultPath = "$.webTargetStability"
        Next       = "Wait for exact Web targets"
      }
      "Wait for exact Web targets" = {
        Type    = "Wait"
        Seconds = 10
        Next    = "Describe exact Web target health"
      }
      "Initialize Tenant Data Broker target health attempts" = {
        Type       = "Pass"
        Result     = { Attempt = 0 }
        ResultPath = "$.tenantDataBrokerTargetStability"
        Next       = "Describe exact Tenant Data Broker target health"
      }
      "Describe exact Tenant Data Broker target health" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:elasticloadbalancingv2:describeTargetHealth"
        TimeoutSeconds = 10
        Parameters = {
          TargetGroupArn = aws_lb_target_group.tenant_data_broker.arn
        }
        ResultSelector = {
          "TargetCount.$" = "States.ArrayLength($.TargetHealthDescriptions)"
          "Targets.$"     = "$.TargetHealthDescriptions"
        }
        ResultPath = "$.tenantDataBrokerTargets"
        Next       = "Exact Tenant Data Broker target count available"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.tenantDataBrokerTargetObservationError"
          Next        = "Restore exact API"
        }]
      }
      "Exact Tenant Data Broker target count available" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.tenantDataBrokerTargets.TargetCount", NumericEquals = 2, Next = "Capture exact Tenant Data Broker target states" },
          { Variable = "$.tenantDataBrokerTargetStability.Attempt", NumericGreaterThanEquals = 15, Next = "Restore exact API" },
        ]
        Default = "Increment Tenant Data Broker target health attempt"
      }
      "Capture exact Tenant Data Broker target states" = {
        Type = "Pass"
        Parameters = {
          "TargetOneState.$" = "$.tenantDataBrokerTargets.Targets[0].TargetHealth.State"
          "TargetTwoState.$" = "$.tenantDataBrokerTargets.Targets[1].TargetHealth.State"
        }
        ResultPath = "$.tenantDataBrokerTargetStates"
        Next       = "Exact Tenant Data Broker targets healthy"
      }
      "Exact Tenant Data Broker targets healthy" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.tenantDataBrokerTargetStates.TargetOneState", StringEquals = "healthy" },
              { Variable = "$.tenantDataBrokerTargetStates.TargetTwoState", StringEquals = "healthy" },
            ]
            Next = "Build awaiting smoke release pointer"
          },
          {
            Variable                 = "$.tenantDataBrokerTargetStability.Attempt"
            NumericGreaterThanEquals = 15
            Next                     = "Restore exact API"
          },
        ]
        Default = "Increment Tenant Data Broker target health attempt"
      }
      "Increment Tenant Data Broker target health attempt" = {
        Type = "Pass"
        Parameters = {
          "Attempt.$" = "States.MathAdd($.tenantDataBrokerTargetStability.Attempt, 1)"
        }
        ResultPath = "$.tenantDataBrokerTargetStability"
        Next       = "Wait for exact Tenant Data Broker targets"
      }
      "Wait for exact Tenant Data Broker targets" = {
        Type    = "Wait"
        Seconds = 10
        Next    = "Describe exact Tenant Data Broker target health"
      }
      "Build awaiting smoke release pointer" = {
        Type = "Pass"
        Parameters = {
          Pointer = {
            SchemaVersion    = "aeostudio.release-pointer.v1"
            Status           = "AWAITING_SMOKE"
            BrokerArn        = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release"
            "ReleaseId.$"    = "$.Contract.ReleaseId"
            "ContractName.$" = "$.Contract.ContractName"
          }
        }
        ResultPath = "$.awaitingSmoke"
        Next       = "Serialize awaiting smoke release pointer"
      }
      "Serialize awaiting smoke release pointer" = {
        Type = "Pass"
        Parameters = {
          "Pointer.$"     = "$.awaitingSmoke.Pointer"
          "PointerJson.$" = "States.JsonToString($.awaitingSmoke.Pointer)"
        }
        ResultPath = "$.awaitingSmoke"
        Next       = "Mark release awaiting smoke"
      }
      "Mark release awaiting smoke" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:putParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name      = local.release_pointer_name
          Type      = "String"
          "Value.$" = "$.awaitingSmoke.PointerJson"
          Overwrite = true
        }
        ResultPath = null
        Next       = "Record awaiting-smoke coordination pointer"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.awaitingSmokePointerError"
          Next        = "Read possibly awaiting-smoke release pointer"
        }]
      }
      "Read possibly awaiting-smoke release pointer" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name = local.release_pointer_name
        }
        ResultSelector = {
          "PointerJson.$" = "$.Parameter.Value"
        }
        ResultPath = "$.possiblyAwaitingSmokePointer"
        Next       = "Possibly awaiting-smoke release pointer matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.awaitingSmokePointerReadError"
          Next        = "Restore exact API"
        }]
      }
      "Possibly awaiting-smoke release pointer matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.possiblyAwaitingSmokePointer.PointerJson", IsPresent = true },
            { Variable = "$.possiblyAwaitingSmokePointer.PointerJson", StringEqualsPath = "$.awaitingSmoke.PointerJson" },
          ]
          Next = "Record awaiting-smoke coordination pointer"
        }]
        Default = "Restore exact API"
      }
      "Record awaiting-smoke coordination pointer" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "SET PointerStatus = :status, PointerReleaseId = :release, PointerContractName = :contract REMOVE ProductionFinalizationEvidenceSha256, GitHubEnvironmentEvidenceSha256, PromotionControlPlaneEvidenceSha256"
          ConditionExpression = "LockOwner = :lock_owner AND ReleaseId = :release AND ContractName = :contract AND Generation = :generation AND Phase = :ready AND attribute_not_exists(ClaimOwner)"
          ExpressionAttributeValues = {
            ":lock_owner" = { "S.$" = "$.ReleaseLock.DeployExecutionArn" }
            ":release"    = { "S.$" = "$.ReleaseLock.ReleaseId" }
            ":contract"   = { "S.$" = "$.ReleaseLock.ContractName" }
            ":generation" = { "N.$" = "$.ReleaseLock.Generation" }
            ":ready"      = { S = "CONTRACT_READY" }
            ":status"     = { S = "AWAITING_SMOKE" }
          }
        }
        ResultPath = null
        Next       = "Release awaiting smoke"
        Retry = [{
          ErrorEquals     = ["DynamoDb.InternalServerError", "DynamoDB.InternalServerError", "States.Timeout"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.coordinationPointerError"
          Next        = "Read awaiting-smoke coordination outcome"
        }]
      }
      "Read awaiting-smoke coordination outcome" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.awaitingSmokeCoordinationOutcome"
        Next       = "Select awaiting-smoke coordination outcome"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.awaitingSmokeCoordinationReadError"
          Next        = "Release rollback incomplete"
        }]
      }
      "Select awaiting-smoke coordination outcome" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.ReleaseId.S", IsPresent = true },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.ContractName.S", IsPresent = true },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.Phase.S", IsPresent = true },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.Generation.N", StringEqualsPath = "$.ReleaseLock.Generation" },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.LockOwner.S", StringEqualsPath = "$.ReleaseLock.DeployExecutionArn" },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.ReleaseId.S", StringEqualsPath = "$.ReleaseLock.ReleaseId" },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.ContractName.S", StringEqualsPath = "$.ReleaseLock.ContractName" },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.Phase.S", StringEquals = "CONTRACT_READY" },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.PointerStatus.S", StringEquals = "AWAITING_SMOKE" },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.PointerReleaseId.S", StringEqualsPath = "$.ReleaseLock.ReleaseId" },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.PointerContractName.S", StringEqualsPath = "$.ReleaseLock.ContractName" },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Release awaiting smoke"
          },
          {
            And = [
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.Generation.N", StringEqualsPath = "$.ReleaseLock.Generation" },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.LockOwner.S", StringEqualsPath = "$.ReleaseLock.DeployExecutionArn" },
              { Variable = "$.awaitingSmokeCoordinationOutcome.Item.ClaimOwner", IsPresent = false },
            ]
            Next = "Wait to retry awaiting-smoke coordination"
          },
        ]
        Default = "Release rollback incomplete"
      }
      "Wait to retry awaiting-smoke coordination" = {
        Type    = "Wait"
        Seconds = 5
        Next    = "Record awaiting-smoke coordination pointer"
      }
      "Release awaiting smoke" = {
        Type = "Succeed"
      }
      "Restore exact API" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:updateService"
        TimeoutSeconds = 15
        Parameters = {
          Cluster            = aws_ecs_cluster.main.arn
          Service            = aws_ecs_service.api.name
          "TaskDefinition.$" = "$.Contract.Rollback.Api"
        }
        ResultPath = null
        Next       = "Restore exact Web"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.apiRollbackError"
          Next        = "Restore exact Web"
        }]
      }
      "Restore exact Web" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:updateService"
        TimeoutSeconds = 15
        Parameters = {
          Cluster            = aws_ecs_cluster.main.arn
          Service            = aws_ecs_service.web.name
          "TaskDefinition.$" = "$.Contract.Rollback.Web"
        }
        ResultPath = null
        Next       = "Restore exact Worker"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.webRollbackError"
          Next        = "Restore exact Worker"
        }]
      }
      "Restore exact Worker" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:updateService"
        TimeoutSeconds = 15
        Parameters = {
          Cluster            = aws_ecs_cluster.main.arn
          Service            = aws_ecs_service.worker.name
          "TaskDefinition.$" = "$.Contract.Rollback.Worker"
        }
        ResultPath = null
        Next       = "Restore exact Tenant Data Broker"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.workerRollbackError"
          Next        = "Restore exact Tenant Data Broker"
        }]
      }
      "Restore exact Tenant Data Broker" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:updateService"
        TimeoutSeconds = 15
        Parameters = {
          Cluster            = aws_ecs_cluster.main.arn
          Service            = aws_ecs_service.tenant_data_broker.name
          "TaskDefinition.$" = "$.Contract.Rollback.TenantDataBroker"
        }
        ResultPath = null
        Next       = "Initialize rollback stability attempts"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.tenantDataBrokerRollbackError"
          Next        = "Initialize rollback stability attempts"
        }]
      }
      "Initialize rollback stability attempts" = {
        Type       = "Pass"
        Result     = { Attempt = 0 }
        ResultPath = "$.stability"
        Next       = "Wait for exact rollback services"
      }
      "Wait for exact rollback services" = {
        Type    = "Wait"
        Seconds = 10
        Next    = "Describe exact rollback services"
      }
      "Describe exact rollback services" = {
        Type = "Parallel"
        Branches = [
          {
            StartAt = "Describe exact restored API service"
            States = {
              "Describe exact restored API service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 10
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.api.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact restored API response count"
                Retry = [{
                  ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
                  IntervalSeconds = 2
                  BackoffRate     = 2
                  MaxAttempts     = 1
                }]
              }
              "Exact restored API response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact restored API service"
                }]
                Default = "Restored API response invalid"
              }
              "Select exact restored API service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Restored API response invalid" = {
                Type  = "Fail"
                Error = "RestoredApiServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe exact restored Web service"
            States = {
              "Describe exact restored Web service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 10
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.web.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact restored Web response count"
                Retry = [{
                  ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
                  IntervalSeconds = 2
                  BackoffRate     = 2
                  MaxAttempts     = 1
                }]
              }
              "Exact restored Web response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact restored Web service"
                }]
                Default = "Restored Web response invalid"
              }
              "Select exact restored Web service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Restored Web response invalid" = {
                Type  = "Fail"
                Error = "RestoredWebServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe exact restored Worker service"
            States = {
              "Describe exact restored Worker service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 10
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.worker.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact restored Worker response count"
                Retry = [{
                  ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
                  IntervalSeconds = 2
                  BackoffRate     = 2
                  MaxAttempts     = 1
                }]
              }
              "Exact restored Worker response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact restored Worker service"
                }]
                Default = "Restored Worker response invalid"
              }
              "Select exact restored Worker service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Restored Worker response invalid" = {
                Type  = "Fail"
                Error = "RestoredWorkerServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe exact restored Tenant Data Broker service"
            States = {
              "Describe exact restored Tenant Data Broker service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 10
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.tenant_data_broker.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact restored Tenant Data Broker response count"
                Retry = [{
                  ErrorEquals     = ["ECS.ServerException", "States.TaskFailed"]
                  IntervalSeconds = 2
                  BackoffRate     = 2
                  MaxAttempts     = 1
                }]
              }
              "Exact restored Tenant Data Broker response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact restored Tenant Data Broker service"
                }]
                Default = "Restored Tenant Data Broker response invalid"
              }
              "Select exact restored Tenant Data Broker service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Restored Tenant Data Broker response invalid" = {
                Type  = "Fail"
                Error = "RestoredTenantDataBrokerServiceDescriptionInvalid"
              }
            }
          },
        ]
        ResultSelector = {
          "Api.$"              = "$[0]"
          "Web.$"              = "$[1]"
          "Worker.$"           = "$[2]"
          "TenantDataBroker.$" = "$[3]"
        }
        ResultPath = "$.rollbackServiceResponses"
        Next       = "Exact rollback service response complete"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.rollbackServiceObservationError"
          Next        = "Release rollback incomplete"
        }]
      }
      "Read possibly rolled-back release pointer" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name = local.release_pointer_name
        }
        ResultSelector = {
          "PointerJson.$" = "$.Parameter.Value"
        }
        ResultPath = "$.possiblyRolledBackPointer"
        Next       = "Possibly rolled-back release pointer matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.rolledBackPointerReadError"
          Next        = "Release rollback incomplete"
        }]
      }
      "Possibly rolled-back release pointer matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.possiblyRolledBackPointer.PointerJson", IsPresent = true },
            { Variable = "$.possiblyRolledBackPointer.PointerJson", StringEqualsPath = "$.rolledBack.PointerJson" },
          ]
          Next = "Select rollback lock cleanup"
        }]
        Default = "Release rollback incomplete"
      }
      "Exact rollback service response complete" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.rollbackServiceResponses.Api.FailureCount", NumericEquals = 0 },
              { Variable = "$.rollbackServiceResponses.Api.ServiceCount", NumericEquals = 1 },
              { Variable = "$.rollbackServiceResponses.Web.FailureCount", NumericEquals = 0 },
              { Variable = "$.rollbackServiceResponses.Web.ServiceCount", NumericEquals = 1 },
              { Variable = "$.rollbackServiceResponses.Worker.FailureCount", NumericEquals = 0 },
              { Variable = "$.rollbackServiceResponses.Worker.ServiceCount", NumericEquals = 1 },
              { Variable = "$.rollbackServiceResponses.TenantDataBroker.FailureCount", NumericEquals = 0 },
              { Variable = "$.rollbackServiceResponses.TenantDataBroker.ServiceCount", NumericEquals = 1 },
            ]
            Next = "Select exact rollback service summaries"
          },
          { Variable = "$.stability.Attempt", NumericGreaterThanEquals = 15, Next = "Release rollback incomplete" },
        ]
        Default = "Increment rollback stability attempt"
      }
      "Select exact rollback service summaries" = {
        Type = "Pass"
        Parameters = {
          FailureCount                               = 0
          ServiceCount                               = 4
          "ApiName.$"                                = "$.rollbackServiceResponses.Api.Service.ServiceName"
          "ApiTaskDefinition.$"                      = "$.rollbackServiceResponses.Api.Service.TaskDefinition"
          "ApiDesiredCount.$"                        = "$.rollbackServiceResponses.Api.Service.DesiredCount"
          "ApiRunningCount.$"                        = "$.rollbackServiceResponses.Api.Service.RunningCount"
          "ApiPendingCount.$"                        = "$.rollbackServiceResponses.Api.Service.PendingCount"
          "ApiPrimaryDeploymentCount.$"              = "States.ArrayLength($.rollbackServiceResponses.Api.Service.Deployments)"
          "ApiDeployments.$"                         = "$.rollbackServiceResponses.Api.Service.Deployments"
          "WebName.$"                                = "$.rollbackServiceResponses.Web.Service.ServiceName"
          "WebTaskDefinition.$"                      = "$.rollbackServiceResponses.Web.Service.TaskDefinition"
          "WebDesiredCount.$"                        = "$.rollbackServiceResponses.Web.Service.DesiredCount"
          "WebRunningCount.$"                        = "$.rollbackServiceResponses.Web.Service.RunningCount"
          "WebPendingCount.$"                        = "$.rollbackServiceResponses.Web.Service.PendingCount"
          "WebPrimaryDeploymentCount.$"              = "States.ArrayLength($.rollbackServiceResponses.Web.Service.Deployments)"
          "WebDeployments.$"                         = "$.rollbackServiceResponses.Web.Service.Deployments"
          "WorkerName.$"                             = "$.rollbackServiceResponses.Worker.Service.ServiceName"
          "WorkerTaskDefinition.$"                   = "$.rollbackServiceResponses.Worker.Service.TaskDefinition"
          "WorkerDesiredCount.$"                     = "$.rollbackServiceResponses.Worker.Service.DesiredCount"
          "WorkerRunningCount.$"                     = "$.rollbackServiceResponses.Worker.Service.RunningCount"
          "WorkerPendingCount.$"                     = "$.rollbackServiceResponses.Worker.Service.PendingCount"
          "WorkerPrimaryDeploymentCount.$"           = "States.ArrayLength($.rollbackServiceResponses.Worker.Service.Deployments)"
          "WorkerDeployments.$"                      = "$.rollbackServiceResponses.Worker.Service.Deployments"
          "TenantDataBrokerName.$"                   = "$.rollbackServiceResponses.TenantDataBroker.Service.ServiceName"
          "TenantDataBrokerTaskDefinition.$"         = "$.rollbackServiceResponses.TenantDataBroker.Service.TaskDefinition"
          "TenantDataBrokerDesiredCount.$"           = "$.rollbackServiceResponses.TenantDataBroker.Service.DesiredCount"
          "TenantDataBrokerRunningCount.$"           = "$.rollbackServiceResponses.TenantDataBroker.Service.RunningCount"
          "TenantDataBrokerPendingCount.$"           = "$.rollbackServiceResponses.TenantDataBroker.Service.PendingCount"
          "TenantDataBrokerPrimaryDeploymentCount.$" = "States.ArrayLength($.rollbackServiceResponses.TenantDataBroker.Service.Deployments)"
          "TenantDataBrokerDeployments.$"            = "$.rollbackServiceResponses.TenantDataBroker.Service.Deployments"
        }
        ResultPath = "$.services"
        Next       = "Exact rollback deployment count complete"
      }
      "Exact rollback deployment count complete" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.services.ApiPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.services.WebPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.services.WorkerPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.services.TenantDataBrokerPrimaryDeploymentCount", NumericEquals = 1 },
            ]
            Next = "Capture exact rollback deployment states"
          },
          { Variable = "$.stability.Attempt", NumericGreaterThanEquals = 15, Next = "Release rollback incomplete" },
        ]
        Default = "Increment rollback stability attempt"
      }
      "Capture exact rollback deployment states" = {
        Type = "Pass"
        Parameters = {
          "ApiDeploymentStatus.$"              = "$.services.ApiDeployments[0].Status"
          "ApiRolloutState.$"                  = "$.services.ApiDeployments[0].RolloutState"
          "WebDeploymentStatus.$"              = "$.services.WebDeployments[0].Status"
          "WebRolloutState.$"                  = "$.services.WebDeployments[0].RolloutState"
          "WorkerDeploymentStatus.$"           = "$.services.WorkerDeployments[0].Status"
          "WorkerRolloutState.$"               = "$.services.WorkerDeployments[0].RolloutState"
          "TenantDataBrokerDeploymentStatus.$" = "$.services.TenantDataBrokerDeployments[0].Status"
          "TenantDataBrokerRolloutState.$"     = "$.services.TenantDataBrokerDeployments[0].RolloutState"
        }
        ResultPath = "$.deploymentStates"
        Next       = "Exact rollback services stable"
      }
      "Exact rollback services stable" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.services.FailureCount", NumericEquals = 0 },
              { Variable = "$.services.ServiceCount", NumericEquals = 4 },
              { Variable = "$.services.ApiName", StringEquals = aws_ecs_service.api.name },
              { Variable = "$.services.ApiTaskDefinition", StringEqualsPath = "$.Contract.Rollback.Api" },
              { Variable = "$.services.ApiDesiredCount", NumericEquals = 2 },
              { Variable = "$.services.ApiRunningCount", NumericEquals = 2 },
              { Variable = "$.services.ApiPendingCount", NumericEquals = 0 },
              { Variable = "$.services.ApiPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.deploymentStates.ApiDeploymentStatus", StringEquals = "PRIMARY" },
              { Variable = "$.deploymentStates.ApiRolloutState", StringEquals = "COMPLETED" },
              { Variable = "$.services.WebName", StringEquals = aws_ecs_service.web.name },
              { Variable = "$.services.WebTaskDefinition", StringEqualsPath = "$.Contract.Rollback.Web" },
              { Variable = "$.services.WebDesiredCount", NumericEquals = 2 },
              { Variable = "$.services.WebRunningCount", NumericEquals = 2 },
              { Variable = "$.services.WebPendingCount", NumericEquals = 0 },
              { Variable = "$.services.WebPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.deploymentStates.WebDeploymentStatus", StringEquals = "PRIMARY" },
              { Variable = "$.deploymentStates.WebRolloutState", StringEquals = "COMPLETED" },
              { Variable = "$.services.WorkerName", StringEquals = aws_ecs_service.worker.name },
              { Variable = "$.services.WorkerTaskDefinition", StringEqualsPath = "$.Contract.Rollback.Worker" },
              { Variable = "$.services.WorkerDesiredCount", NumericEquals = 2 },
              { Variable = "$.services.WorkerRunningCount", NumericEquals = 2 },
              { Variable = "$.services.WorkerPendingCount", NumericEquals = 0 },
              { Variable = "$.services.WorkerPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.deploymentStates.WorkerDeploymentStatus", StringEquals = "PRIMARY" },
              { Variable = "$.deploymentStates.WorkerRolloutState", StringEquals = "COMPLETED" },
              { Variable = "$.services.TenantDataBrokerName", StringEquals = aws_ecs_service.tenant_data_broker.name },
              { Variable = "$.services.TenantDataBrokerTaskDefinition", StringEqualsPath = "$.Contract.Rollback.TenantDataBroker" },
              { Variable = "$.services.TenantDataBrokerDesiredCount", NumericEquals = 2 },
              { Variable = "$.services.TenantDataBrokerRunningCount", NumericEquals = 2 },
              { Variable = "$.services.TenantDataBrokerPendingCount", NumericEquals = 0 },
              { Variable = "$.services.TenantDataBrokerPrimaryDeploymentCount", NumericEquals = 1 },
              { Variable = "$.deploymentStates.TenantDataBrokerDeploymentStatus", StringEquals = "PRIMARY" },
              { Variable = "$.deploymentStates.TenantDataBrokerRolloutState", StringEquals = "COMPLETED" },
            ]
            Next = "Initialize rollback API target health attempts"
          },
          {
            Variable                 = "$.stability.Attempt"
            NumericGreaterThanEquals = 15
            Next                     = "Release rollback incomplete"
          },
        ]
        Default = "Increment rollback stability attempt"
      }
      "Increment rollback stability attempt" = {
        Type = "Pass"
        Parameters = {
          "Attempt.$" = "States.MathAdd($.stability.Attempt, 1)"
        }
        ResultPath = "$.stability"
        Next       = "Wait for exact rollback services"
      }
      "Initialize rollback API target health attempts" = {
        Type       = "Pass"
        Result     = { Attempt = 0 }
        ResultPath = "$.apiTargetStability"
        Next       = "Describe exact rollback API target health"
      }
      "Describe exact rollback API target health" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:elasticloadbalancingv2:describeTargetHealth"
        TimeoutSeconds = 10
        Parameters = {
          TargetGroupArn = aws_lb_target_group.api.arn
        }
        ResultSelector = {
          "TargetCount.$" = "States.ArrayLength($.TargetHealthDescriptions)"
          "Targets.$"     = "$.TargetHealthDescriptions"
        }
        ResultPath = "$.apiTargets"
        Next       = "Exact rollback API target count available"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release rollback incomplete"
        }]
      }
      "Exact rollback API target count available" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.apiTargets.TargetCount", NumericEquals = 2, Next = "Capture exact rollback API target states" },
          { Variable = "$.apiTargetStability.Attempt", NumericGreaterThanEquals = 15, Next = "Release rollback incomplete" },
        ]
        Default = "Increment rollback API target health attempt"
      }
      "Capture exact rollback API target states" = {
        Type = "Pass"
        Parameters = {
          "TargetOneState.$" = "$.apiTargets.Targets[0].TargetHealth.State"
          "TargetTwoState.$" = "$.apiTargets.Targets[1].TargetHealth.State"
        }
        ResultPath = "$.apiTargetStates"
        Next       = "Exact rollback API targets healthy"
      }
      "Exact rollback API targets healthy" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.apiTargetStates.TargetOneState", StringEquals = "healthy" },
              { Variable = "$.apiTargetStates.TargetTwoState", StringEquals = "healthy" },
            ]
            Next = "Initialize rollback Web target health attempts"
          },
          {
            Variable                 = "$.apiTargetStability.Attempt"
            NumericGreaterThanEquals = 15
            Next                     = "Release rollback incomplete"
          },
        ]
        Default = "Increment rollback API target health attempt"
      }
      "Increment rollback API target health attempt" = {
        Type = "Pass"
        Parameters = {
          "Attempt.$" = "States.MathAdd($.apiTargetStability.Attempt, 1)"
        }
        ResultPath = "$.apiTargetStability"
        Next       = "Wait for exact rollback API targets"
      }
      "Wait for exact rollback API targets" = {
        Type    = "Wait"
        Seconds = 10
        Next    = "Describe exact rollback API target health"
      }
      "Initialize rollback Web target health attempts" = {
        Type       = "Pass"
        Result     = { Attempt = 0 }
        ResultPath = "$.webTargetStability"
        Next       = "Describe exact rollback Web target health"
      }
      "Describe exact rollback Web target health" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:elasticloadbalancingv2:describeTargetHealth"
        TimeoutSeconds = 10
        Parameters = {
          TargetGroupArn = aws_lb_target_group.web.arn
        }
        ResultSelector = {
          "TargetCount.$" = "States.ArrayLength($.TargetHealthDescriptions)"
          "Targets.$"     = "$.TargetHealthDescriptions"
        }
        ResultPath = "$.webTargets"
        Next       = "Exact rollback Web target count available"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release rollback incomplete"
        }]
      }
      "Exact rollback Web target count available" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.webTargets.TargetCount", NumericEquals = 2, Next = "Capture exact rollback Web target states" },
          { Variable = "$.webTargetStability.Attempt", NumericGreaterThanEquals = 15, Next = "Release rollback incomplete" },
        ]
        Default = "Increment rollback Web target health attempt"
      }
      "Capture exact rollback Web target states" = {
        Type = "Pass"
        Parameters = {
          "TargetOneState.$" = "$.webTargets.Targets[0].TargetHealth.State"
          "TargetTwoState.$" = "$.webTargets.Targets[1].TargetHealth.State"
        }
        ResultPath = "$.webTargetStates"
        Next       = "Exact rollback Web targets healthy"
      }
      "Exact rollback Web targets healthy" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.webTargetStates.TargetOneState", StringEquals = "healthy" },
              { Variable = "$.webTargetStates.TargetTwoState", StringEquals = "healthy" },
            ]
            Next = "Initialize rollback Tenant Data Broker target health attempts"
          },
          {
            Variable                 = "$.webTargetStability.Attempt"
            NumericGreaterThanEquals = 15
            Next                     = "Release rollback incomplete"
          },
        ]
        Default = "Increment rollback Web target health attempt"
      }
      "Increment rollback Web target health attempt" = {
        Type = "Pass"
        Parameters = {
          "Attempt.$" = "States.MathAdd($.webTargetStability.Attempt, 1)"
        }
        ResultPath = "$.webTargetStability"
        Next       = "Wait for exact rollback Web targets"
      }
      "Wait for exact rollback Web targets" = {
        Type    = "Wait"
        Seconds = 10
        Next    = "Describe exact rollback Web target health"
      }
      "Initialize rollback Tenant Data Broker target health attempts" = {
        Type       = "Pass"
        Result     = { Attempt = 0 }
        ResultPath = "$.tenantDataBrokerTargetStability"
        Next       = "Describe exact rollback Tenant Data Broker target health"
      }
      "Describe exact rollback Tenant Data Broker target health" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:elasticloadbalancingv2:describeTargetHealth"
        TimeoutSeconds = 10
        Parameters = {
          TargetGroupArn = aws_lb_target_group.tenant_data_broker.arn
        }
        ResultSelector = {
          "TargetCount.$" = "States.ArrayLength($.TargetHealthDescriptions)"
          "Targets.$"     = "$.TargetHealthDescriptions"
        }
        ResultPath = "$.tenantDataBrokerTargets"
        Next       = "Exact rollback Tenant Data Broker target count available"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 1
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Release rollback incomplete"
        }]
      }
      "Exact rollback Tenant Data Broker target count available" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.tenantDataBrokerTargets.TargetCount", NumericEquals = 2, Next = "Capture exact rollback Tenant Data Broker target states" },
          { Variable = "$.tenantDataBrokerTargetStability.Attempt", NumericGreaterThanEquals = 15, Next = "Release rollback incomplete" },
        ]
        Default = "Increment rollback Tenant Data Broker target health attempt"
      }
      "Capture exact rollback Tenant Data Broker target states" = {
        Type = "Pass"
        Parameters = {
          "TargetOneState.$" = "$.tenantDataBrokerTargets.Targets[0].TargetHealth.State"
          "TargetTwoState.$" = "$.tenantDataBrokerTargets.Targets[1].TargetHealth.State"
        }
        ResultPath = "$.tenantDataBrokerTargetStates"
        Next       = "Exact rollback Tenant Data Broker targets healthy"
      }
      "Exact rollback Tenant Data Broker targets healthy" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.tenantDataBrokerTargetStates.TargetOneState", StringEquals = "healthy" },
              { Variable = "$.tenantDataBrokerTargetStates.TargetTwoState", StringEquals = "healthy" },
            ]
            Next = "Build rolled-back release pointer"
          },
          {
            Variable                 = "$.tenantDataBrokerTargetStability.Attempt"
            NumericGreaterThanEquals = 15
            Next                     = "Release rollback incomplete"
          },
        ]
        Default = "Increment rollback Tenant Data Broker target health attempt"
      }
      "Increment rollback Tenant Data Broker target health attempt" = {
        Type = "Pass"
        Parameters = {
          "Attempt.$" = "States.MathAdd($.tenantDataBrokerTargetStability.Attempt, 1)"
        }
        ResultPath = "$.tenantDataBrokerTargetStability"
        Next       = "Wait for exact rollback Tenant Data Broker targets"
      }
      "Wait for exact rollback Tenant Data Broker targets" = {
        Type    = "Wait"
        Seconds = 10
        Next    = "Describe exact rollback Tenant Data Broker target health"
      }
      "Build rolled-back release pointer" = {
        Type = "Pass"
        Parameters = {
          Pointer = {
            SchemaVersion    = "aeostudio.release-pointer.v1"
            Status           = "ROLLED_BACK"
            BrokerArn        = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release"
            "ReleaseId.$"    = "$.Contract.ReleaseId"
            "ContractName.$" = "$.Contract.ContractName"
          }
        }
        ResultPath = "$.rolledBack"
        Next       = "Serialize rolled-back release pointer"
      }
      "Serialize rolled-back release pointer" = {
        Type = "Pass"
        Parameters = {
          "Pointer.$"     = "$.rolledBack.Pointer"
          "PointerJson.$" = "States.JsonToString($.rolledBack.Pointer)"
        }
        ResultPath = "$.rolledBack"
        Next       = "Mark release rolled back"
      }
      "Mark release rolled back" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:putParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name      = local.release_pointer_name
          Type      = "String"
          "Value.$" = "$.rolledBack.PointerJson"
          Overwrite = true
        }
        ResultPath = null
        Next       = "Select rollback lock cleanup"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.rolledBackPointerWriteError"
          Next        = "Read possibly rolled-back release pointer"
        }]
      }
      "Select rollback lock cleanup" = {
        Type = "Choice"
        Choices = [{
          Variable     = "$.RollbackOutcome"
          StringEquals = "SUCCEED"
          Next         = "Delete rollback release lock"
        }]
        Default = "Release failed and rolled back"
      }
      "Delete rollback release lock" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:updateItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          UpdateExpression    = "SET PointerStatus = :status, PointerReleaseId = :release, PointerContractName = :contract REMOVE LockOwner, ReleaseId, ContractName, Phase, ClaimOwner, ClaimMode, ProductionFinalizationEvidenceSha256, GitHubEnvironmentEvidenceSha256, PromotionControlPlaneEvidenceSha256"
          ConditionExpression = "LockOwner = :lock_owner AND ReleaseId = :release AND ContractName = :contract AND Generation = :generation AND Phase = :ready AND ClaimOwner = :claim_owner"
          ExpressionAttributeValues = {
            ":lock_owner"  = { "S.$" = "$.ReleaseLock.DeployExecutionArn" }
            ":release"     = { "S.$" = "$.ReleaseLock.ReleaseId" }
            ":contract"    = { "S.$" = "$.ReleaseLock.ContractName" }
            ":generation"  = { "N.$" = "$.ReleaseLock.Generation" }
            ":ready"       = { S = "CONTRACT_READY" }
            ":claim_owner" = { "S.$" = "$.LifecycleClaim.ExecutionArn" }
            ":status"      = { S = "ROLLED_BACK" }
          }
        }
        Next = "Rollback succeeded"
        Retry = [{
          ErrorEquals     = ["DynamoDb.InternalServerError", "DynamoDB.InternalServerError", "States.Timeout"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.rollbackLockCleanupError"
          Next        = "Read rollback lock cleanup outcome"
        }]
      }
      "Read rollback lock cleanup outcome" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.rollbackLockCleanupOutcome"
        Next       = "Select rollback lock cleanup outcome"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.rollbackLockCleanupReadError"
          Next        = "Release rollback incomplete"
        }]
      }
      "Select rollback lock cleanup outcome" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.rollbackLockCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.rollbackLockCleanupOutcome.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.rollbackLockCleanupOutcome.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.rollbackLockCleanupOutcome.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.rollbackLockCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.ReleaseLock.Generation" },
              { Variable = "$.rollbackLockCleanupOutcome.Item.PointerStatus.S", StringEquals = "ROLLED_BACK" },
              { Variable = "$.rollbackLockCleanupOutcome.Item.PointerReleaseId.S", StringEqualsPath = "$.ReleaseLock.ReleaseId" },
              { Variable = "$.rollbackLockCleanupOutcome.Item.PointerContractName.S", StringEqualsPath = "$.ReleaseLock.ContractName" },
              { Variable = "$.rollbackLockCleanupOutcome.Item.LockOwner", IsPresent = false },
              { Variable = "$.rollbackLockCleanupOutcome.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.rollbackLockCleanupOutcome.Item.Phase", IsPresent = false },
              { Variable = "$.rollbackLockCleanupOutcome.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.rollbackLockCleanupOutcome.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.rollbackLockCleanupOutcome.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Rollback succeeded"
          },
          {
            And = [
              { Variable = "$.rollbackLockCleanupOutcome.Item.Generation.N", IsPresent = true },
              { Variable = "$.rollbackLockCleanupOutcome.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.rollbackLockCleanupOutcome.Item.ClaimOwner.S", IsPresent = true },
              { Variable = "$.rollbackLockCleanupOutcome.Item.Generation.N", StringEqualsPath = "$.ReleaseLock.Generation" },
              { Variable = "$.rollbackLockCleanupOutcome.Item.LockOwner.S", StringEqualsPath = "$.ReleaseLock.DeployExecutionArn" },
              { Variable = "$.rollbackLockCleanupOutcome.Item.ClaimOwner.S", StringEqualsPath = "$.LifecycleClaim.ExecutionArn" },
            ]
            Next = "Wait to retry rollback lock cleanup"
          },
        ]
        Default = "Release rollback incomplete"
      }
      "Wait to retry rollback lock cleanup" = {
        Type    = "Wait"
        Seconds = 5
        Next    = "Delete rollback release lock"
      }
      "Rollback succeeded" = {
        Type = "Succeed"
      }
      "Release failed and rolled back" = {
        Type  = "Fail"
        Error = "ReleaseFailedRolledBack"
        Cause = "The exact release failed and all four services returned to retained revisions; the environment lock remains held for explicit recovery."
      }
      "Release rollback incomplete" = {
        Type  = "Fail"
        Error = "ReleaseRollbackIncomplete"
        Cause = "The exact release failed and the retained revisions did not become stable before the bounded deadline."
      }
    }
  })

  tags = local.common_tags
}

resource "aws_iam_role" "release_watchdog" {
  name               = "${local.name}-release-watchdog"
  assume_role_policy = data.aws_iam_policy_document.step_functions_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "release_watchdog" {
  statement {
    sid       = "InspectExactDeployExecution"
    effect    = "Allow"
    actions   = ["states:DescribeExecution"]
    resources = ["arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:*"]
  }

  statement {
    sid       = "StartExactReleaseCompensation"
    effect    = "Allow"
    actions   = ["states:StartExecution"]
    resources = ["arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release"]
  }

  statement {
    sid     = "ReadExactReleaseReconciliationState"
    effect  = "Allow"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/aeostudio/${var.environment}/release-contract",
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/aeostudio/${var.environment}/releases/*",
    ]
  }

  statement {
    sid       = "ReadExactReleaseCoordinationOwners"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.release_control.arn]
  }
}

resource "aws_iam_role_policy" "release_watchdog" {
  name   = "${local.name}-release-watchdog"
  role   = aws_iam_role.release_watchdog.id
  policy = data.aws_iam_policy_document.release_watchdog.json
}

resource "aws_sfn_state_machine" "release_watchdog" {
  name     = "${local.name}-release-watchdog"
  role_arn = aws_iam_role.release_watchdog.arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment        = "Durable AEOStudio release lease and compensation watchdog"
    StartAt        = "Validate exact watched release"
    TimeoutSeconds = 10800
    States = {
      "Validate exact watched release" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.DeployExecutionArn", StringMatches = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:*" },
            { Variable = "$.ReleaseId", IsString = true },
            { Not = { Variable = "$.ReleaseId", StringEquals = "" } },
          ]
          Next = "Validate bounded watched release ID"
        }]
        Default = "Watched release invalid"
      }
      "Validate bounded watched release ID" = {
        Type          = "Choice"
        QueryLanguage = "JSONata"
        Choices = [{
          Condition = "{% $length($states.input.ReleaseId) > 0 and $length($states.input.ReleaseId) <= 70 %}"
          Next      = "Inspect watched deploy execution"
        }]
        Default = "Watched release invalid"
      }
      "Watched release invalid" = {
        Type  = "Fail"
        Error = "WatchedReleaseInvalid"
        Cause = "The watchdog accepts only an exact deploy execution and non-empty release ID."
      }
      "Inspect watched deploy execution" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:sfn:describeExecution"
        TimeoutSeconds = 20
        Parameters = {
          "ExecutionArn.$" = "$.DeployExecutionArn"
        }
        ResultSelector = {
          "Status.$" = "$.Status"
        }
        ResultPath = "$.deploy"
        Next       = "Select watched deploy outcome"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Watchdog inspection failed"
        }]
      }
      "Select watched deploy outcome" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.deploy.Status", StringEquals = "RUNNING", Next = "Wait for watched deploy" },
          { Variable = "$.deploy.Status", StringEquals = "SUCCEEDED", Next = "Wait for smoke lease" },
          { Variable = "$.deploy.Status", StringEquals = "FAILED", Next = "Load exact watched release lock" },
          { Variable = "$.deploy.Status", StringEquals = "TIMED_OUT", Next = "Load exact watched release lock" },
          { Variable = "$.deploy.Status", StringEquals = "ABORTED", Next = "Load exact watched release lock" },
        ]
        Default = "Watchdog inspection failed"
      }
      "Wait for watched deploy" = {
        Type    = "Wait"
        Seconds = 30
        Next    = "Inspect watched deploy execution"
      }
      "Wait for smoke lease" = {
        Type    = "Wait"
        Seconds = 900
        Next    = "Load exact watched release lock"
      }
      "Load exact watched release lock" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.watchedLockResponse"
        Next       = "Watched release lock exists"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Watchdog inspection failed"
        }]
      }
      "Watched release lock exists" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.watchedLockResponse.Item.LockOwner", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.Phase", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.Generation.N", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.watchedLockResponse.Item.PointerContractName.S", StringMatches = "/aeostudio/${var.environment}/releases/*" },
              {
                Or = [
                  { Variable = "$.watchedLockResponse.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
                  { Variable = "$.watchedLockResponse.Item.PointerStatus.S", StringEquals = "ROLLED_BACK" },
                ]
              },
            ]
            Next = "Load compensated watched release pointer"
          },
          {
            And = [
              { Variable = "$.watchedLockResponse.Item.LockOwner", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.ClaimOwner", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.Phase", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.Generation.N", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.watchedLockResponse.Item.PointerContractName.S", StringMatches = "/aeostudio/${var.environment}/releases/*" },
              {
                Variable     = "$.watchedLockResponse.Item.PointerStatus.S"
                StringEquals = "PREPARATION_ABORTED"
              },
              { Variable = "$.watchedLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Watched release already compensated"
          },
          {
            And = [
              { Variable = "$.watchedLockResponse.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.ReleaseId.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.ContractName.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.Generation.N", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.Phase.S", IsPresent = true },
            ]
            Next = "Select exact watched release lock"
          },
          {
            Variable  = "$.watchedLockResponse.Item.LockOwner"
            IsPresent = true
            Next      = "Watchdog reconciliation rejected"
          },
          {
            Variable  = "$.watchedLockResponse.Item.ClaimOwner"
            IsPresent = true
            Next      = "Load orphan watched lifecycle claim"
          },
        ]
        Default = "Watchdog reconciliation rejected"
      }
      "Load compensated watched release pointer" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name = local.release_pointer_name
        }
        ResultSelector = {
          "Pointer.$" = "States.StringToJson($.Parameter.Value)"
        }
        ResultPath = "$.compensatedWatchedPointer"
        Next       = "Compensated watched release pointer matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Watchdog reconciliation rejected"
        }]
      }
      "Compensated watched release pointer matches" = {
        Type = "Choice"
        Choices = concat(
          var.environment == "production" ? [{
            And = [
              { Variable = "$.compensatedWatchedPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.compensatedWatchedPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.compensatedWatchedPointer.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.compensatedWatchedPointer.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.compensatedWatchedPointer.Pointer.ReleaseId", StringEqualsPath = "$.watchedLockResponse.Item.PointerReleaseId.S" },
              { Variable = "$.compensatedWatchedPointer.Pointer.ContractName", StringEqualsPath = "$.watchedLockResponse.Item.PointerContractName.S" },
              { Variable = "$.compensatedWatchedPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256", IsPresent = true },
              { Variable = "$.compensatedWatchedPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", IsPresent = true },
              { Variable = "$.compensatedWatchedPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.ProductionFinalizationEvidenceSha256.S", StringEqualsPath = "$.compensatedWatchedPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
              { Variable = "$.watchedLockResponse.Item.GitHubEnvironmentEvidenceSha256.S", StringEqualsPath = "$.compensatedWatchedPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
              { Variable = "$.watchedLockResponse.Item.PromotionControlPlaneEvidenceSha256.S", StringEqualsPath = "$.compensatedWatchedPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
            ]
            Next = "Watched release already compensated"
          }] : [],
          var.environment == "staging" ? [{
            And = [
              { Variable = "$.compensatedWatchedPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.compensatedWatchedPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.compensatedWatchedPointer.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.compensatedWatchedPointer.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.compensatedWatchedPointer.Pointer.ReleaseId", StringEqualsPath = "$.watchedLockResponse.Item.PointerReleaseId.S" },
              { Variable = "$.compensatedWatchedPointer.Pointer.ContractName", StringEqualsPath = "$.watchedLockResponse.Item.PointerContractName.S" },
              { Variable = "$.compensatedWatchedPointer.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Watched release already compensated"
          }] : [],
          [{
            And = [
              { Variable = "$.compensatedWatchedPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.compensatedWatchedPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.compensatedWatchedPointer.Pointer.Status", StringEquals = "ROLLED_BACK" },
              { Variable = "$.compensatedWatchedPointer.Pointer.ReleaseId", StringEqualsPath = "$.ReleaseId" },
              { Variable = "$.compensatedWatchedPointer.Pointer.ReleaseId", StringEqualsPath = "$.watchedLockResponse.Item.PointerReleaseId.S" },
              { Variable = "$.compensatedWatchedPointer.Pointer.ContractName", StringEqualsPath = "$.watchedLockResponse.Item.PointerContractName.S" },
              { Variable = "$.compensatedWatchedPointer.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Watched release already compensated"
          }]
        )
        Default = "Watchdog reconciliation rejected"
      }
      "Select exact watched release lock" = {
        Type = "Pass"
        Parameters = {
          Lock = {
            "DeployExecutionArn.$" = "$.watchedLockResponse.Item.LockOwner.S"
            "ReleaseId.$"          = "$.watchedLockResponse.Item.ReleaseId.S"
            "ContractName.$"       = "$.watchedLockResponse.Item.ContractName.S"
            "Generation.$"         = "$.watchedLockResponse.Item.Generation.N"
            "Phase.$"              = "$.watchedLockResponse.Item.Phase.S"
          }
        }
        ResultPath = "$.watchedLock"
        Next       = "Exact watched release lock matches"
      }
      "Load orphan watched lifecycle claim" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:dynamodb:getItem"
        TimeoutSeconds = 20
        Parameters = {
          TableName = aws_dynamodb_table.release_control.name
          Key = {
            CoordinationKey = { S = "ENVIRONMENT" }
          }
          ConsistentRead = true
        }
        ResultPath = "$.orphanCoordination"
        Next       = "Orphan watched lifecycle claim exists"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Watchdog inspection failed"
        }]
      }
      "Orphan watched lifecycle claim exists" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.orphanCoordination.Item.ClaimOwner.S", IsPresent = true },
              { Variable = "$.orphanCoordination.Item.ClaimMode.S", IsPresent = true },
              { Variable = "$.orphanCoordination.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.orphanCoordination.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.orphanCoordination.Item.Generation.N", IsPresent = true },
            ]
            Next = "Select exact orphan watched lifecycle claim"
          },
          {
            Variable  = "$.orphanCoordination.Item.ClaimOwner"
            IsPresent = true
            Next      = "Watchdog reconciliation rejected"
          },
        ]
        Default = "Load exact watched release lock"
      }
      "Select exact orphan watched lifecycle claim" = {
        Type = "Pass"
        Parameters = {
          Claim = {
            "ExecutionArn.$" = "$.orphanCoordination.Item.ClaimOwner.S"
            "Mode.$"         = "$.orphanCoordination.Item.ClaimMode.S"
            "ReleaseId.$"    = "$.orphanCoordination.Item.PointerReleaseId.S"
            "ContractName.$" = "$.orphanCoordination.Item.PointerContractName.S"
            "Generation.$"   = "$.orphanCoordination.Item.Generation.N"
          }
        }
        ResultPath = "$.orphanLifecycleClaim"
        Next       = "Exact orphan watched lifecycle claim matches"
      }
      "Exact orphan watched lifecycle claim matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.orphanLifecycleClaim.Claim.ExecutionArn", StringMatches = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:*" },
            { Variable = "$.orphanLifecycleClaim.Claim.ReleaseId", StringEqualsPath = "$.ReleaseId" },
            { Variable = "$.orphanLifecycleClaim.Claim.ContractName", StringMatches = "/aeostudio/${var.environment}/releases/*" },
          ]
          Next = "Inspect orphan watched lifecycle execution"
        }]
        Default = "Watchdog reconciliation rejected"
      }
      "Inspect orphan watched lifecycle execution" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:sfn:describeExecution"
        TimeoutSeconds = 20
        Parameters = {
          "ExecutionArn.$" = "$.orphanLifecycleClaim.Claim.ExecutionArn"
        }
        ResultSelector = {
          "Status.$" = "$.Status"
        }
        ResultPath = "$.orphanLifecycleExecution"
        Next       = "Select orphan watched lifecycle outcome"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Watchdog inspection failed"
        }]
      }
      "Select orphan watched lifecycle outcome" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.orphanLifecycleExecution.Status", StringEquals = "RUNNING", Next = "Wait for orphan lifecycle operation" },
          { Variable = "$.orphanLifecycleExecution.Status", StringEquals = "FAILED", Next = "Build exact recovery input" },
          { Variable = "$.orphanLifecycleExecution.Status", StringEquals = "TIMED_OUT", Next = "Build exact recovery input" },
          { Variable = "$.orphanLifecycleExecution.Status", StringEquals = "ABORTED", Next = "Build exact recovery input" },
          { Variable = "$.orphanLifecycleExecution.Status", StringEquals = "SUCCEEDED", Next = "Build exact recovery input" },
        ]
        Default = "Watchdog reconciliation rejected"
      }
      "Wait for orphan lifecycle operation" = {
        Type    = "Wait"
        Seconds = 30
        Next    = "Load exact watched release lock"
      }
      "Watched release already compensated" = {
        Type = "Succeed"
      }
      "Exact watched release lock matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.DeployExecutionArn", StringEqualsPath = "$.watchedLock.Lock.DeployExecutionArn" },
            { Variable = "$.ReleaseId", StringEqualsPath = "$.watchedLock.Lock.ReleaseId" },
            { Variable = "$.watchedLock.Lock.ContractName", StringMatches = "/aeostudio/${var.environment}/releases/*" },
          ]
          Next = "Select watched release coordination phase"
        }]
        Default = "Watchdog reconciliation rejected"
      }
      "Select watched release coordination phase" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.watchedLock.Lock.Phase", StringEquals = "PREPARING" },
              { Variable = "$.watchedLockResponse.Item.ClaimOwner", IsPresent = false },
              {
                Or = [
                  { Variable = "$.deploy.Status", StringEquals = "FAILED" },
                  { Variable = "$.deploy.Status", StringEquals = "TIMED_OUT" },
                  { Variable = "$.deploy.Status", StringEquals = "ABORTED" },
                ]
              },
            ]
            Next = "Record exact failed-deploy recovery"
          },
          {
            Variable     = "$.watchedLock.Lock.Phase"
            StringEquals = "CONTRACT_READY"
            Next         = "Load exact watched release contract"
          },
        ]
        Default = "Watchdog reconciliation rejected"
      }
      "Load exact watched release contract" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          "Name.$" = "$.watchedLock.Lock.ContractName"
        }
        ResultSelector = {
          "Contract.$" = "States.StringToJson($.Parameter.Value)"
        }
        ResultPath = "$.watchedContract"
        Next       = "Exact watched release contract matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Watchdog reconciliation rejected"
        }]
      }
      "Exact watched release contract matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.watchedContract.Contract.ReleaseId", StringEqualsPath = "$.watchedLock.Lock.ReleaseId" },
            { Variable = "$.watchedContract.Contract.ContractName", StringEqualsPath = "$.watchedLock.Lock.ContractName" },
            { Variable = "$.watchedContract.Contract.Environment", StringEquals = var.environment },
            { Variable = "$.watchedContract.Contract.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
          ]
          Next = "Load exact watched release pointer"
        }]
        Default = "Watchdog reconciliation rejected"
      }
      "Load exact watched release pointer" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ssm:getParameter"
        TimeoutSeconds = 20
        Parameters = {
          Name = local.release_pointer_name
        }
        ResultSelector = {
          "Pointer.$" = "States.StringToJson($.Parameter.Value)"
        }
        ResultPath = "$.watchedPointer"
        Next       = "Select exact watched release outcome"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Watchdog reconciliation rejected"
        }]
      }
      "Select exact watched release outcome" = {
        Type = "Choice"
        Choices = concat(
          [{
            Or = [
              { Variable = "$.deploy.Status", StringEquals = "FAILED" },
              { Variable = "$.deploy.Status", StringEquals = "TIMED_OUT" },
              { Variable = "$.deploy.Status", StringEquals = "ABORTED" },
            ]
            Next = "Record exact failed-deploy recovery"
          }],
          var.environment == "production" ? [{
            And = [
              { Variable = "$.watchedLockResponse.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.watchedPointer.Pointer.ReleaseId" },
              { Variable = "$.watchedLockResponse.Item.PointerContractName.S", StringEqualsPath = "$.watchedPointer.Pointer.ContractName" },
              { Variable = "$.watchedPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.watchedPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.watchedPointer.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.watchedPointer.Pointer.ReleaseId", StringEqualsPath = "$.watchedLock.Lock.ReleaseId" },
              { Variable = "$.watchedPointer.Pointer.ContractName", StringEqualsPath = "$.watchedLock.Lock.ContractName" },
              { Variable = "$.watchedPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256", IsPresent = true },
              { Variable = "$.watchedPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256", IsPresent = true },
              { Variable = "$.watchedPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256", IsPresent = true },
              {
                Or = [
                  {
                    And = [
                      { Variable = "$.watchedLockResponse.Item.PointerStatus.S", StringEquals = "AWAITING_SMOKE" },
                      { Variable = "$.watchedLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
                      { Variable = "$.watchedLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
                      { Variable = "$.watchedLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
                    ]
                  },
                  {
                    And = [
                      { Variable = "$.watchedLockResponse.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
                      { Variable = "$.watchedLockResponse.Item.ProductionFinalizationEvidenceSha256.S", StringEqualsPath = "$.watchedPointer.Pointer.FinalizationEvidence.ProductionFinalizationEvidenceSha256" },
                      { Variable = "$.watchedLockResponse.Item.GitHubEnvironmentEvidenceSha256.S", StringEqualsPath = "$.watchedPointer.Pointer.FinalizationEvidence.GitHubEnvironmentEvidenceSha256" },
                      { Variable = "$.watchedLockResponse.Item.PromotionControlPlaneEvidenceSha256.S", StringEqualsPath = "$.watchedPointer.Pointer.FinalizationEvidence.PromotionControlPlaneEvidenceSha256" },
                    ]
                  },
                ]
              },
            ]
            Next = "Record exact terminal recovery"
          }] : [],
          var.environment == "staging" ? [{
            And = [
              { Variable = "$.watchedLockResponse.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.watchedPointer.Pointer.ReleaseId" },
              { Variable = "$.watchedLockResponse.Item.PointerContractName.S", StringEqualsPath = "$.watchedPointer.Pointer.ContractName" },
              {
                Or = [
                  { Variable = "$.watchedLockResponse.Item.PointerStatus.S", StringEquals = "AWAITING_SMOKE" },
                  { Variable = "$.watchedLockResponse.Item.PointerStatus.S", StringEquals = "DEPLOYED" },
                ]
              },
              { Variable = "$.watchedPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.watchedPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.watchedPointer.Pointer.Status", StringEquals = "DEPLOYED" },
              { Variable = "$.watchedPointer.Pointer.ReleaseId", StringEqualsPath = "$.watchedLock.Lock.ReleaseId" },
              { Variable = "$.watchedPointer.Pointer.ContractName", StringEqualsPath = "$.watchedLock.Lock.ContractName" },
              { Variable = "$.watchedPointer.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Record exact terminal recovery"
          }] : [],
          [{
            And = [
              { Variable = "$.watchedLockResponse.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerStatus.S", StringEqualsPath = "$.watchedPointer.Pointer.Status" },
              { Variable = "$.watchedLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.watchedPointer.Pointer.ReleaseId" },
              { Variable = "$.watchedLockResponse.Item.PointerContractName.S", StringEqualsPath = "$.watchedPointer.Pointer.ContractName" },
              { Variable = "$.watchedPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.watchedPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.watchedPointer.Pointer.Status", StringEquals = "ROLLED_BACK" },
              { Variable = "$.watchedPointer.Pointer.ReleaseId", StringEqualsPath = "$.watchedLock.Lock.ReleaseId" },
              { Variable = "$.watchedPointer.Pointer.ContractName", StringEqualsPath = "$.watchedLock.Lock.ContractName" },
              { Variable = "$.watchedPointer.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
            ]
            Next = "Record exact terminal recovery"
          }],
          [{
            And = [
              { Variable = "$.watchedLockResponse.Item.PointerStatus.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerReleaseId.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerContractName.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.PointerStatus.S", StringEqualsPath = "$.watchedPointer.Pointer.Status" },
              { Variable = "$.watchedLockResponse.Item.PointerReleaseId.S", StringEqualsPath = "$.watchedPointer.Pointer.ReleaseId" },
              { Variable = "$.watchedLockResponse.Item.PointerContractName.S", StringEqualsPath = "$.watchedPointer.Pointer.ContractName" },
              { Variable = "$.watchedPointer.Pointer.SchemaVersion", StringEquals = "aeostudio.release-pointer.v1" },
              { Variable = "$.watchedPointer.Pointer.BrokerArn", StringEquals = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release" },
              { Variable = "$.watchedPointer.Pointer.Status", StringEquals = "AWAITING_SMOKE" },
              { Variable = "$.watchedPointer.Pointer.ReleaseId", StringEqualsPath = "$.watchedLock.Lock.ReleaseId" },
              { Variable = "$.watchedPointer.Pointer.ContractName", StringEqualsPath = "$.watchedLock.Lock.ContractName" },
              { Variable = "$.watchedPointer.Pointer.FinalizationEvidence", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.ProductionFinalizationEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.GitHubEnvironmentEvidenceSha256", IsPresent = false },
              { Variable = "$.watchedLockResponse.Item.PromotionControlPlaneEvidenceSha256", IsPresent = false },
              { Variable = "$.deploy.Status", StringEquals = "SUCCEEDED" },
            ]
            Next = "Record exact smoke-timeout recovery"
          }]
        )
        Default = "Watchdog reconciliation rejected"
      }
      "Record exact smoke-timeout recovery" = {
        Type       = "Pass"
        Result     = { Mode = "RECOVER" }
        ResultPath = "$.reconciliation"
        Next       = "Load exact watched lifecycle claim"
      }
      "Record exact terminal recovery" = {
        Type       = "Pass"
        Result     = { Mode = "RECOVER" }
        ResultPath = "$.reconciliation"
        Next       = "Load exact watched lifecycle claim"
      }
      "Record exact failed-deploy recovery" = {
        Type       = "Pass"
        Result     = { Mode = "RECOVER" }
        ResultPath = "$.reconciliation"
        Next       = "Load exact watched lifecycle claim"
      }
      "Load exact watched lifecycle claim" = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.watchedLockResponse.Item.ClaimOwner.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.ClaimMode.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.LockOwner.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.ReleaseId.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.ContractName.S", IsPresent = true },
              { Variable = "$.watchedLockResponse.Item.Generation.N", IsPresent = true },
            ]
            Next = "Select exact watched lifecycle claim"
          },
        ]
        Default = "Build exact recovery input"
      }
      "Select exact watched lifecycle claim" = {
        Type = "Pass"
        Parameters = {
          Claim = {
            "ExecutionArn.$"       = "$.watchedLockResponse.Item.ClaimOwner.S"
            "Mode.$"               = "$.watchedLockResponse.Item.ClaimMode.S"
            "DeployExecutionArn.$" = "$.watchedLockResponse.Item.LockOwner.S"
            "ReleaseId.$"          = "$.watchedLockResponse.Item.ReleaseId.S"
            "ContractName.$"       = "$.watchedLockResponse.Item.ContractName.S"
            "Generation.$"         = "$.watchedLockResponse.Item.Generation.N"
          }
        }
        ResultPath = "$.watchedLifecycleClaim"
        Next       = "Exact watched lifecycle claim matches"
      }
      "Exact watched lifecycle claim matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.watchedLifecycleClaim.Claim.ExecutionArn", StringMatches = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:*" },
            { Variable = "$.watchedLifecycleClaim.Claim.DeployExecutionArn", StringEqualsPath = "$.watchedLock.Lock.DeployExecutionArn" },
            { Variable = "$.watchedLifecycleClaim.Claim.ReleaseId", StringEqualsPath = "$.watchedLock.Lock.ReleaseId" },
            { Variable = "$.watchedLifecycleClaim.Claim.ContractName", StringEqualsPath = "$.watchedLock.Lock.ContractName" },
            { Variable = "$.watchedLifecycleClaim.Claim.Generation", StringEqualsPath = "$.watchedLock.Lock.Generation" },
          ]
          Next = "Inspect watched lifecycle execution"
        }]
        Default = "Watchdog reconciliation rejected"
      }
      "Inspect watched lifecycle execution" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:sfn:describeExecution"
        TimeoutSeconds = 20
        Parameters = {
          "ExecutionArn.$" = "$.watchedLifecycleClaim.Claim.ExecutionArn"
        }
        ResultSelector = {
          "Status.$" = "$.Status"
        }
        ResultPath = "$.lifecycleExecution"
        Next       = "Select watched lifecycle outcome"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Watchdog reconciliation rejected"
        }]
      }
      "Select watched lifecycle outcome" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.lifecycleExecution.Status", StringEquals = "RUNNING", Next = "Wait for active lifecycle operation" },
          { Variable = "$.lifecycleExecution.Status", StringEquals = "FAILED", Next = "Record exact lifecycle recovery" },
          { Variable = "$.lifecycleExecution.Status", StringEquals = "TIMED_OUT", Next = "Record exact lifecycle recovery" },
          { Variable = "$.lifecycleExecution.Status", StringEquals = "ABORTED", Next = "Record exact lifecycle recovery" },
          { Variable = "$.lifecycleExecution.Status", StringEquals = "SUCCEEDED", Next = "Record exact lifecycle recovery" },
        ]
        Default = "Watchdog reconciliation rejected"
      }
      "Wait for active lifecycle operation" = {
        Type    = "Wait"
        Seconds = 30
        Next    = "Load exact watched release lock"
      }
      "Record exact lifecycle recovery" = {
        Type       = "Pass"
        Result     = { Mode = "RECOVER" }
        ResultPath = "$.reconciliation"
        Next       = "Build exact recovery input"
      }
      "Build exact recovery input" = {
        Type = "Pass"
        Parameters = {
          Input = {
            Mode                   = "RECOVER"
            "ReleaseId.$"          = "$.ReleaseId"
            "DeployExecutionArn.$" = "$.DeployExecutionArn"
          }
        }
        ResultPath = "$.reconciliationLaunch"
        Next       = "Build exact reconciliation execution"
      }
      "Build exact reconciliation execution" = {
        Type = "Pass"
        Parameters = {
          "Name.$"         = "States.Format('reconcile-{}', $.ReleaseId)"
          "ExecutionArn.$" = "States.Format('arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-release:reconcile-{}', $.ReleaseId)"
          "Input.$"        = "$.reconciliationLaunch.Input"
        }
        ResultPath = "$.reconciliationExecution"
        Next       = "Start exact reconciliation execution"
      }
      "Start exact reconciliation execution" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::states:startExecution"
        TimeoutSeconds = 20
        Parameters = {
          StateMachineArn = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release"
          "Name.$"        = "$.reconciliationExecution.Name"
          "Input.$"       = "$.reconciliationExecution.Input"
        }
        ResultSelector = {
          "ExecutionArn.$" = "$.ExecutionArn"
        }
        ResultPath = "$.reconciliationStart"
        Next       = "Exact reconciliation start response matches"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.reconciliationStartError"
          Next        = "Wait for reconciliation execution"
        }]
      }
      "Exact reconciliation start response matches" = {
        Type = "Choice"
        Choices = [{
          Variable         = "$.reconciliationStart.ExecutionArn"
          StringEqualsPath = "$.reconciliationExecution.ExecutionArn"
          Next             = "Wait for reconciliation execution"
        }]
        Default = "Watchdog compensation failed"
      }
      "Wait for reconciliation execution" = {
        Type    = "Wait"
        Seconds = 15
        Next    = "Inspect reconciliation execution"
      }
      "Inspect reconciliation execution" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:sfn:describeExecution"
        TimeoutSeconds = 20
        Parameters = {
          "ExecutionArn.$" = "$.reconciliationExecution.ExecutionArn"
        }
        ResultSelector = {
          "Status.$" = "$.Status"
          "Input.$"  = "States.StringToJson($.Input)"
        }
        ResultPath = "$.reconciliationStatus"
        Next       = "Exact reconciliation execution matches"
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [
          {
            ErrorEquals = ["Sfn.ExecutionDoesNotExist", "SFN.ExecutionDoesNotExist"]
            ResultPath  = "$.reconciliationNotStarted"
            Next        = "Wait to retry exact reconciliation start"
          },
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = "$.reconciliationInspectionError"
            Next        = "Wait for reconciliation execution"
          },
        ]
      }
      "Wait to retry exact reconciliation start" = {
        Type    = "Wait"
        Seconds = 5
        Next    = "Start exact reconciliation execution"
      }
      "Exact reconciliation execution matches" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.reconciliationExecution.Input.Mode", StringEquals = "RECOVER" },
            { Variable = "$.reconciliationStatus.Input.Mode", StringEquals = "RECOVER" },
            { Variable = "$.reconciliationStatus.Input.Mode", StringEqualsPath = "$.reconciliationExecution.Input.Mode" },
            { Variable = "$.reconciliationStatus.Input.ReleaseId", StringEqualsPath = "$.reconciliationExecution.Input.ReleaseId" },
            { Variable = "$.reconciliationStatus.Input.DeployExecutionArn", StringEqualsPath = "$.reconciliationExecution.Input.DeployExecutionArn" },
          ]
          Next = "Validate exact reconciliation input shape"
        }]
        Default = "Watchdog compensation failed"
      }
      "Validate exact reconciliation input shape" = {
        Type          = "Choice"
        QueryLanguage = "JSONata"
        Choices = [{
          Condition = "{% $type($states.input.reconciliationStatus.Input) = 'object' and $count($keys($states.input.reconciliationStatus.Input)) = 3 %}"
          Next      = "Select reconciliation execution outcome"
        }]
        Default = "Watchdog compensation failed"
      }
      "Select reconciliation execution outcome" = {
        Type = "Choice"
        Choices = [
          { Variable = "$.reconciliationStatus.Status", StringEquals = "RUNNING", Next = "Wait for reconciliation execution" },
          { Variable = "$.reconciliationStatus.Status", StringEquals = "SUCCEEDED", Next = "Watchdog reconciliation succeeded" },
          { Variable = "$.reconciliationStatus.Status", StringEquals = "FAILED", Next = "Watchdog compensation failed" },
          { Variable = "$.reconciliationStatus.Status", StringEquals = "TIMED_OUT", Next = "Watchdog compensation failed" },
          { Variable = "$.reconciliationStatus.Status", StringEquals = "ABORTED", Next = "Watchdog compensation failed" },
        ]
        Default = "Watchdog compensation failed"
      }
      "Watchdog reconciliation succeeded" = {
        Type = "Succeed"
      }
      "Watchdog inspection failed" = {
        Type  = "Fail"
        Error = "ReleaseWatchdogInspectionFailed"
        Cause = "The watchdog could not determine the terminal deploy status."
      }
      "Watchdog reconciliation rejected" = {
        Type  = "Fail"
        Error = "ReleaseWatchdogReconciliationRejected"
        Cause = "The watchdog found a lock, contract, pointer, or lifecycle claim that did not belong to the exact watched release."
      }
      "Watchdog compensation failed" = {
        Type  = "Fail"
        Error = "ReleaseWatchdogCompensationFailed"
        Cause = "The watchdog could not durably start the fixed recovery capability."
      }
    }
  })

  tags = local.common_tags
}

resource "aws_iam_role" "bootstrap_orchestrator" {
  name               = "${local.name}-bootstrap-orchestrator"
  assume_role_policy = data.aws_iam_policy_document.step_functions_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "bootstrap_orchestrator" {
  statement {
    sid     = "InspectZeroServiceBootstrapGate"
    effect  = "Allow"
    actions = ["ecs:DescribeServices"]
    resources = [
      aws_ecs_service.api.id,
      aws_ecs_service.tenant_data_broker.id,
      aws_ecs_service.web.id,
      aws_ecs_service.worker.id,
    ]
  }

  statement {
    sid     = "RunExactBootstrapAndMigrationTasks"
    effect  = "Allow"
    actions = ["ecs:RunTask"]
    resources = [
      aws_ecs_task_definition.bootstrap.arn,
      aws_ecs_task_definition.migration.arn,
    ]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid    = "InspectAndStopBootstrapBrokerTasks"
    effect = "Allow"
    actions = [
      "ecs:DescribeTasks",
      "ecs:StopTask",
    ]
    resources = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task/${local.name}/*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid     = "PassExactBootstrapAndMigrationRoles"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.bootstrap_execution.arn,
      aws_iam_role.bootstrap.arn,
      aws_iam_role.migration_execution.arn,
      aws_iam_role.migration.arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid    = "ObserveSynchronousBootstrapTasks"
    effect = "Allow"
    actions = [
      "events:DescribeRule",
      "events:PutRule",
      "events:PutTargets",
    ]
    resources = ["arn:aws:events:${var.region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForECSTaskRule"]
  }
}

resource "aws_iam_role_policy" "bootstrap_orchestrator" {
  name   = "${local.name}-bootstrap-orchestrator"
  role   = aws_iam_role.bootstrap_orchestrator.id
  policy = data.aws_iam_policy_document.bootstrap_orchestrator.json
}

resource "aws_sfn_state_machine" "bootstrap" {
  name     = "${local.name}-bootstrap"
  role_arn = aws_iam_role.bootstrap_orchestrator.arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment        = "Fixed one-time AEOStudio bootstrap capability broker"
    StartAt        = "Initialize trusted bootstrap input"
    TimeoutSeconds = 2100
    States = {
      "Initialize trusted bootstrap input" = {
        Type       = "Pass"
        Result     = {}
        ResultPath = "$"
        Next       = "Describe zero-service bootstrap gate"
      }
      "Describe zero-service bootstrap gate" = {
        Type = "Parallel"
        Branches = [
          {
            StartAt = "Describe zero-service API service"
            States = {
              "Describe zero-service API service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 30
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.api.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact zero-service API response count"
              }
              "Exact zero-service API response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact zero-service API service"
                }]
                Default = "Zero-service API response invalid"
              }
              "Select exact zero-service API service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Zero-service API response invalid" = {
                Type  = "Fail"
                Error = "BootstrapApiServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe zero-service Web service"
            States = {
              "Describe zero-service Web service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 30
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.web.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact zero-service Web response count"
              }
              "Exact zero-service Web response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact zero-service Web service"
                }]
                Default = "Zero-service Web response invalid"
              }
              "Select exact zero-service Web service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Zero-service Web response invalid" = {
                Type  = "Fail"
                Error = "BootstrapWebServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe zero-service Worker service"
            States = {
              "Describe zero-service Worker service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 30
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.worker.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact zero-service Worker response count"
              }
              "Exact zero-service Worker response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact zero-service Worker service"
                }]
                Default = "Zero-service Worker response invalid"
              }
              "Select exact zero-service Worker service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Zero-service Worker response invalid" = {
                Type  = "Fail"
                Error = "BootstrapWorkerServiceDescriptionInvalid"
              }
            }
          },
          {
            StartAt = "Describe zero-service Tenant Data Broker service"
            States = {
              "Describe zero-service Tenant Data Broker service" = {
                Type           = "Task"
                Resource       = "arn:aws:states:::aws-sdk:ecs:describeServices"
                TimeoutSeconds = 30
                Parameters = {
                  Cluster  = aws_ecs_cluster.main.arn
                  Services = [aws_ecs_service.tenant_data_broker.name]
                }
                ResultSelector = {
                  "FailureCount.$" = "States.ArrayLength($.Failures)"
                  "ServiceCount.$" = "States.ArrayLength($.Services)"
                  "Services.$"     = "$.Services"
                }
                Next = "Exact zero-service Tenant Data Broker response count"
              }
              "Exact zero-service Tenant Data Broker response count" = {
                Type = "Choice"
                Choices = [{
                  And = [
                    { Variable = "$.FailureCount", NumericEquals = 0 },
                    { Variable = "$.ServiceCount", NumericEquals = 1 },
                  ]
                  Next = "Select exact zero-service Tenant Data Broker service"
                }]
                Default = "Zero-service Tenant Data Broker response invalid"
              }
              "Select exact zero-service Tenant Data Broker service" = {
                Type = "Pass"
                Parameters = {
                  FailureCount = 0
                  ServiceCount = 1
                  "Service.$"  = "$.Services[0]"
                }
                End = true
              }
              "Zero-service Tenant Data Broker response invalid" = {
                Type  = "Fail"
                Error = "BootstrapTenantDataBrokerServiceDescriptionInvalid"
              }
            }
          },
        ]
        ResultSelector = {
          "Api.$"              = "$[0]"
          "Web.$"              = "$[1]"
          "Worker.$"           = "$[2]"
          "TenantDataBroker.$" = "$[3]"
        }
        ResultPath = "$.serviceResponses"
        Next       = "Exact bootstrap service response complete"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Bootstrap zero-service gate failed"
        }]
      }
      "Exact bootstrap service response complete" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.serviceResponses.Api.FailureCount", NumericEquals = 0 },
            { Variable = "$.serviceResponses.Api.ServiceCount", NumericEquals = 1 },
            { Variable = "$.serviceResponses.Web.FailureCount", NumericEquals = 0 },
            { Variable = "$.serviceResponses.Web.ServiceCount", NumericEquals = 1 },
            { Variable = "$.serviceResponses.Worker.FailureCount", NumericEquals = 0 },
            { Variable = "$.serviceResponses.Worker.ServiceCount", NumericEquals = 1 },
            { Variable = "$.serviceResponses.TenantDataBroker.FailureCount", NumericEquals = 0 },
            { Variable = "$.serviceResponses.TenantDataBroker.ServiceCount", NumericEquals = 1 },
          ]
          Next = "Select exact bootstrap service summaries"
        }]
        Default = "Bootstrap zero-service gate failed"
      }
      "Select exact bootstrap service summaries" = {
        Type = "Pass"
        Parameters = {
          FailureCount                     = 0
          ServiceCount                     = 4
          "ApiName.$"                      = "$.serviceResponses.Api.Service.ServiceName"
          "ApiDesiredCount.$"              = "$.serviceResponses.Api.Service.DesiredCount"
          "ApiRunningCount.$"              = "$.serviceResponses.Api.Service.RunningCount"
          "ApiPendingCount.$"              = "$.serviceResponses.Api.Service.PendingCount"
          "WebName.$"                      = "$.serviceResponses.Web.Service.ServiceName"
          "WebDesiredCount.$"              = "$.serviceResponses.Web.Service.DesiredCount"
          "WebRunningCount.$"              = "$.serviceResponses.Web.Service.RunningCount"
          "WebPendingCount.$"              = "$.serviceResponses.Web.Service.PendingCount"
          "WorkerName.$"                   = "$.serviceResponses.Worker.Service.ServiceName"
          "WorkerDesiredCount.$"           = "$.serviceResponses.Worker.Service.DesiredCount"
          "WorkerRunningCount.$"           = "$.serviceResponses.Worker.Service.RunningCount"
          "WorkerPendingCount.$"           = "$.serviceResponses.Worker.Service.PendingCount"
          "TenantDataBrokerName.$"         = "$.serviceResponses.TenantDataBroker.Service.ServiceName"
          "TenantDataBrokerDesiredCount.$" = "$.serviceResponses.TenantDataBroker.Service.DesiredCount"
          "TenantDataBrokerRunningCount.$" = "$.serviceResponses.TenantDataBroker.Service.RunningCount"
          "TenantDataBrokerPendingCount.$" = "$.serviceResponses.TenantDataBroker.Service.PendingCount"
        }
        ResultPath = "$.services"
        Next       = "All services are stopped"
      }
      "All services are stopped" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.services.FailureCount", NumericEquals = 0 },
            { Variable = "$.services.ServiceCount", NumericEquals = 4 },
            { Variable = "$.services.ApiName", StringEquals = aws_ecs_service.api.name },
            { Variable = "$.services.ApiDesiredCount", NumericEquals = 0 },
            { Variable = "$.services.ApiRunningCount", NumericEquals = 0 },
            { Variable = "$.services.ApiPendingCount", NumericEquals = 0 },
            { Variable = "$.services.WebName", StringEquals = aws_ecs_service.web.name },
            { Variable = "$.services.WebDesiredCount", NumericEquals = 0 },
            { Variable = "$.services.WebRunningCount", NumericEquals = 0 },
            { Variable = "$.services.WebPendingCount", NumericEquals = 0 },
            { Variable = "$.services.WorkerName", StringEquals = aws_ecs_service.worker.name },
            { Variable = "$.services.WorkerDesiredCount", NumericEquals = 0 },
            { Variable = "$.services.WorkerRunningCount", NumericEquals = 0 },
            { Variable = "$.services.WorkerPendingCount", NumericEquals = 0 },
            { Variable = "$.services.TenantDataBrokerName", StringEquals = aws_ecs_service.tenant_data_broker.name },
            { Variable = "$.services.TenantDataBrokerDesiredCount", NumericEquals = 0 },
            { Variable = "$.services.TenantDataBrokerRunningCount", NumericEquals = 0 },
            { Variable = "$.services.TenantDataBrokerPendingCount", NumericEquals = 0 },
          ]
          Next = "Run exact bootstrap"
        }]
        Default = "Bootstrap zero-service gate failed"
      }
      "Bootstrap zero-service gate failed" = {
        Type  = "Fail"
        Error = "BootstrapRequiresZeroServices"
        Cause = "Web, API, Worker, and Tenant Data Broker must all have desired, running, and pending count zero."
      }
      "Run exact bootstrap" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 900
        Parameters = {
          Cluster        = aws_ecs_cluster.main.arn
          TaskDefinition = aws_ecs_task_definition.bootstrap.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.migration.id]
              Subnets        = aws_subnet.private[*].id
            }
          }
        }
        ResultSelector = {
          "FailureCount.$" = "States.ArrayLength($.Failures)"
          "TaskCount.$"    = "States.ArrayLength($.Tasks)"
          "Tasks.$"        = "$.Tasks"
        }
        ResultPath = "$.bootstrapRun"
        Next       = "Exact bootstrap task started"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Bootstrap container failed"
        }]
      }
      "Exact bootstrap task started" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.bootstrapRun.FailureCount", NumericEquals = 0 },
            { Variable = "$.bootstrapRun.TaskCount", NumericEquals = 1 },
          ]
          Next = "Capture exact bootstrap task ARN"
        }]
        Default = "Bootstrap container failed"
      }
      "Capture exact bootstrap task ARN" = {
        Type = "Pass"
        Parameters = {
          "TaskArn.$" = "$.bootstrapRun.Tasks[0].TaskArn"
        }
        ResultPath = "$.bootstrapRun"
        Next       = "Describe exact bootstrap task"
      }
      "Describe exact bootstrap task" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:describeTasks"
        TimeoutSeconds = 30
        Parameters = {
          Cluster   = aws_ecs_cluster.main.arn
          "Tasks.$" = "States.Array($.bootstrapRun.TaskArn)"
        }
        ResultSelector = {
          "FailureCount.$" = "States.ArrayLength($.Failures)"
          "TaskCount.$"    = "States.ArrayLength($.Tasks)"
          "Tasks.$"        = "$.Tasks"
        }
        ResultPath = "$.bootstrapResponse"
        Next       = "Exact bootstrap task described"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Bootstrap container failed"
        }]
      }
      "Exact bootstrap task described" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.bootstrapResponse.FailureCount", NumericEquals = 0 },
            { Variable = "$.bootstrapResponse.TaskCount", NumericEquals = 1 },
          ]
          Next = "Select exact bootstrap task"
        }]
        Default = "Bootstrap container failed"
      }
      "Select exact bootstrap task" = {
        Type = "Pass"
        Parameters = {
          "TaskDefinitionArn.$" = "$.bootstrapResponse.Tasks[0].TaskDefinitionArn"
          "LastStatus.$"        = "$.bootstrapResponse.Tasks[0].LastStatus"
          "ContainerCount.$"    = "States.ArrayLength($.bootstrapResponse.Tasks[0].Containers)"
          "Containers.$"        = "$.bootstrapResponse.Tasks[0].Containers"
        }
        ResultPath = "$.bootstrap"
        Next       = "Exact bootstrap container present"
      }
      "Exact bootstrap container present" = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.bootstrap.ContainerCount"
          NumericEquals = 1
          Next          = "Select exact bootstrap container"
        }]
        Default = "Bootstrap container failed"
      }
      "Select exact bootstrap container" = {
        Type = "Pass"
        Parameters = {
          FailureCount          = 0
          ContainerCount        = 1
          "TaskDefinitionArn.$" = "$.bootstrap.TaskDefinitionArn"
          "LastStatus.$"        = "$.bootstrap.LastStatus"
          "ContainerName.$"     = "$.bootstrap.Containers[0].Name"
          "ExitCode.$"          = "$.bootstrap.Containers[0].ExitCode"
        }
        ResultPath = "$.bootstrap"
        Next       = "Bootstrap container succeeded"
      }
      "Bootstrap container succeeded" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.bootstrap.FailureCount", NumericEquals = 0 },
            { Variable = "$.bootstrap.ContainerCount", NumericEquals = 1 },
            { Variable = "$.bootstrap.TaskDefinitionArn", StringEquals = aws_ecs_task_definition.bootstrap.arn },
            { Variable = "$.bootstrap.LastStatus", StringEquals = "STOPPED" },
            { Variable = "$.bootstrap.ContainerName", StringEquals = "bootstrap" },
            { Variable = "$.bootstrap.ExitCode", NumericEquals = 0 },
          ]
          Next = "Run exact bootstrap migration"
        }]
        Default = "Bootstrap container failed"
      }
      "Bootstrap container failed" = {
        Type  = "Fail"
        Error = "BootstrapContainerFailed"
        Cause = "The exact bootstrap task did not stop with one successful container."
      }
      "Run exact bootstrap migration" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 900
        Parameters = {
          Cluster        = aws_ecs_cluster.main.arn
          TaskDefinition = aws_ecs_task_definition.migration.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.migration.id]
              Subnets        = aws_subnet.private[*].id
            }
          }
        }
        ResultSelector = {
          "FailureCount.$" = "States.ArrayLength($.Failures)"
          "TaskCount.$"    = "States.ArrayLength($.Tasks)"
          "Tasks.$"        = "$.Tasks"
        }
        ResultPath = "$.migrationRun"
        Next       = "Exact bootstrap migration task started"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Bootstrap migration container failed"
        }]
      }
      "Exact bootstrap migration task started" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.migrationRun.FailureCount", NumericEquals = 0 },
            { Variable = "$.migrationRun.TaskCount", NumericEquals = 1 },
          ]
          Next = "Capture exact bootstrap migration task ARN"
        }]
        Default = "Bootstrap migration container failed"
      }
      "Capture exact bootstrap migration task ARN" = {
        Type = "Pass"
        Parameters = {
          "TaskArn.$" = "$.migrationRun.Tasks[0].TaskArn"
        }
        ResultPath = "$.migrationRun"
        Next       = "Describe exact bootstrap migration task"
      }
      "Describe exact bootstrap migration task" = {
        Type           = "Task"
        Resource       = "arn:aws:states:::aws-sdk:ecs:describeTasks"
        TimeoutSeconds = 30
        Parameters = {
          Cluster   = aws_ecs_cluster.main.arn
          "Tasks.$" = "States.Array($.migrationRun.TaskArn)"
        }
        ResultSelector = {
          "FailureCount.$" = "States.ArrayLength($.Failures)"
          "TaskCount.$"    = "States.ArrayLength($.Tasks)"
          "Tasks.$"        = "$.Tasks"
        }
        ResultPath = "$.migrationResponse"
        Next       = "Exact bootstrap migration task described"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Bootstrap migration container failed"
        }]
      }
      "Exact bootstrap migration task described" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.migrationResponse.FailureCount", NumericEquals = 0 },
            { Variable = "$.migrationResponse.TaskCount", NumericEquals = 1 },
          ]
          Next = "Select exact bootstrap migration task"
        }]
        Default = "Bootstrap migration container failed"
      }
      "Select exact bootstrap migration task" = {
        Type = "Pass"
        Parameters = {
          "TaskDefinitionArn.$" = "$.migrationResponse.Tasks[0].TaskDefinitionArn"
          "LastStatus.$"        = "$.migrationResponse.Tasks[0].LastStatus"
          "ContainerCount.$"    = "States.ArrayLength($.migrationResponse.Tasks[0].Containers)"
          "Containers.$"        = "$.migrationResponse.Tasks[0].Containers"
        }
        ResultPath = "$.migration"
        Next       = "Exact bootstrap migration container present"
      }
      "Exact bootstrap migration container present" = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.migration.ContainerCount"
          NumericEquals = 1
          Next          = "Select exact bootstrap migration container"
        }]
        Default = "Bootstrap migration container failed"
      }
      "Select exact bootstrap migration container" = {
        Type = "Pass"
        Parameters = {
          FailureCount          = 0
          ContainerCount        = 1
          "TaskDefinitionArn.$" = "$.migration.TaskDefinitionArn"
          "LastStatus.$"        = "$.migration.LastStatus"
          "ContainerName.$"     = "$.migration.Containers[0].Name"
          "ExitCode.$"          = "$.migration.Containers[0].ExitCode"
        }
        ResultPath = "$.migration"
        Next       = "Bootstrap migration container succeeded"
      }
      "Bootstrap migration container succeeded" = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.migration.FailureCount", NumericEquals = 0 },
            { Variable = "$.migration.ContainerCount", NumericEquals = 1 },
            { Variable = "$.migration.TaskDefinitionArn", StringEquals = aws_ecs_task_definition.migration.arn },
            { Variable = "$.migration.LastStatus", StringEquals = "STOPPED" },
            { Variable = "$.migration.ContainerName", StringEquals = "migration" },
            { Variable = "$.migration.ExitCode", NumericEquals = 0 },
          ]
          Next = "Bootstrap succeeded"
        }]
        Default = "Bootstrap migration container failed"
      }
      "Bootstrap migration container failed" = {
        Type  = "Fail"
        Error = "BootstrapMigrationContainerFailed"
        Cause = "The exact migration task did not stop with one successful container."
      }
      "Bootstrap succeeded" = {
        Type = "Succeed"
      }
    }
  })

  tags = local.common_tags
}

resource "aws_ssm_parameter" "release_contract" {
  name = local.release_pointer_name
  type = "String"
  value = jsonencode({
    SchemaVersion = "aeostudio.release-pointer.v1"
    Status        = "UNINITIALIZED"
    BrokerArn     = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-release"
  })

  tags = local.common_tags

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "bootstrap_contract" {
  name = local.bootstrap_contract_name
  type = "String"
  value = jsonencode({
    SchemaVersion = "aeostudio.bootstrap-contract.v1"
    Environment   = var.environment
    Region        = var.region
    AccountId     = data.aws_caller_identity.current.account_id
    ApiDigest     = var.api_image_digest
    ApiImage      = "${data.aws_ecr_repository.api.repository_url}@${var.api_image_digest}"
    BootstrapTask = aws_ecs_task_definition.bootstrap.arn
    MigrationTask = aws_ecs_task_definition.migration.arn
    BrokerArn     = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-bootstrap"
    ClusterArn    = aws_ecs_cluster.main.arn
  })

  tags = local.common_tags
}
