data "aws_ecr_repository" "web" {
  name = "aeostudio-web"
}

data "aws_ecr_repository" "api" {
  name = "aeostudio-api"
}

data "aws_ecr_repository" "worker" {
  name = "aeostudio-worker"
}

data "aws_ecr_repository" "adot" {
  name = "aeostudio-adot"
}

locals {
  adot_image_digest  = split("@", var.adot_image)[1]
  adot_private_image = "${data.aws_ecr_repository.adot.repository_url}@${local.adot_image_digest}"
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${local.name}/web"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "tenant_data_broker" {
  name              = "/ecs/${local.name}/tenant-data-broker"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "adot" {
  name              = "/ecs/${local.name}/adot"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.common_tags
}

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enhanced"
  }

  tags = local.common_tags
}

# The product's tenant UI and public verification surfaces are intentionally Internet-facing.
# trivy:ignore:AWS-0053:exp:2027-07-24
resource "aws_lb" "main" {
  name               = local.name
  internal           = false
  load_balancer_type = "application"
  ip_address_type    = "ipv4"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = true
  drop_invalid_header_fields = true

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = "alb-access"
    enabled = true
  }

  depends_on = [aws_s3_bucket_policy.alb_logs]

  tags = local.common_tags
}

resource "aws_lb" "tenant_data_broker" {
  name               = "${local.name}-broker"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.internal_alb.id]
  subnets            = aws_subnet.private[*].id

  enable_deletion_protection = true
  drop_invalid_header_fields = true

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = "alb-access"
    enabled = true
  }

  depends_on = [aws_s3_bucket_policy.alb_logs]

  tags = merge(local.common_tags, { Service = "tenant-data-broker" })
}

resource "aws_lb_target_group" "web" {
  name                 = "${local.name}-web"
  port                 = 3100
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/"
    matcher             = "200-399"
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.common_tags
}

resource "aws_lb_target_group" "api" {
  name                 = "${local.name}-api"
  port                 = 3200
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/ready"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.common_tags
}

resource "aws_lb_target_group" "tenant_data_broker" {
  name                 = "${local.name}-broker"
  port                 = 3300
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/internal/healthz"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = merge(local.common_tags, { Service = "tenant-data-broker" })
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.public.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "deny_public_internal" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 1

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":\"NOT_FOUND\"}"
      status_code  = "404"
    }
  }

  condition {
    path_pattern {
      values = ["/internal/*"]
    }
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      values = ["/api/*", "/health", "/ready"]
    }
  }
}

resource "aws_lb_listener" "tenant_data_broker_https" {
  load_balancer_arn = aws_lb.tenant_data_broker.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.tenant_data_broker.certificate_arn

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":\"NOT_FOUND\"}"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "tenant_data_broker_api" {
  listener_arn = aws_lb_listener.tenant_data_broker_https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.tenant_data_broker.arn
  }

  condition {
    path_pattern {
      values = ["/internal/v1/tenant-data"]
    }
  }

  condition {
    http_request_method {
      values = ["POST"]
    }
  }
}

resource "aws_lb_listener_rule" "tenant_data_broker_health" {
  listener_arn = aws_lb_listener.tenant_data_broker_https.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.tenant_data_broker.arn
  }

  condition {
    path_pattern {
      values = ["/internal/healthz"]
    }
  }

  condition {
    http_request_method {
      values = ["GET"]
    }
  }
}

locals {
  adot_environment = [
    { name = "AWS_REGION", value = var.region },
    { name = "OTEL_RESOURCE_ATTRIBUTES", value = "deployment.environment=${var.environment},service.namespace=aeostudio" },
  ]

  adot_log_configuration = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.adot.name
      awslogs-region        = var.region
      awslogs-stream-prefix = "collector"
    }
  }
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.web.arn
  skip_destroy             = true

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "web"
      image     = "${data.aws_ecr_repository.web.repository_url}@${var.web_image_digest}"
      essential = true
      portMappings = [{
        containerPort = 3100
        hostPort      = 3100
        protocol      = "tcp"
      }]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "NEXT_MANUAL_SIG_HANDLE", value = "true" },
        { name = "PORT", value = "3100" },
        { name = "API_INTERNAL_ORIGIN", value = local.public_origin },
        { name = "API_PUBLIC_ORIGIN", value = local.public_origin },
        { name = "WEB_ORIGIN", value = local.public_origin },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://127.0.0.1:4318" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.web.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "web"
        }
      }
    },
    {
      name             = "adot"
      image            = local.adot_private_image
      essential        = true
      command          = ["--config=/etc/ecs/ecs-default-config.yaml"]
      environment      = local.adot_environment
      logConfiguration = local.adot_log_configuration
    },
  ])

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.api_execution.arn
  task_role_arn            = aws_iam_role.api.arn
  skip_destroy             = true

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = "${data.aws_ecr_repository.api.repository_url}@${var.api_image_digest}"
      essential = true
      portMappings = [{
        containerPort = 3200
        hostPort      = 3200
        protocol      = "tcp"
      }]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3200" },
        { name = "API_DATABASE_POOL_MAX", value = "5" },
        { name = "AWS_REGION", value = var.region },
        { name = "AWS_ACCOUNT_ID", value = data.aws_caller_identity.current.account_id },
        { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.id },
        { name = "AUDIT_EVIDENCE_BUCKET", value = aws_s3_bucket.audit_evidence.id },
        { name = "S3_KMS_KEY_ARN", value = aws_kms_key.data.arn },
        { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.main.id },
        { name = "OIDC_ISSUER_URL", value = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}" },
        { name = "OIDC_CLIENT_ID", value = aws_cognito_user_pool_client.web.id },
        { name = "OIDC_REDIRECT_URI", value = "${local.public_origin}/api/v1/auth/callback" },
        { name = "WEB_ORIGIN", value = local.public_origin },
        { name = "TENANT_DATA_BROKER_ENDPOINT", value = local.tenant_data_broker_endpoint },
        { name = "TENANT_DATA_BROKER_AUDIENCE", value = local.tenant_data_broker_hostname },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://127.0.0.1:4318" },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.runtime_database_url.arn },
        { name = "SESSION_ENCRYPTION_KEY", valueFrom = aws_secretsmanager_secret.session_encryption_key.arn },
        { name = "DELETION_RECEIPT_SIGNING_KEY", valueFrom = aws_secretsmanager_secret.deletion_receipt_signing_key.arn },
        { name = "TENANT_DATA_BROKER_HMAC_KEY_RING", valueFrom = aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "api"
        }
      }
    },
    {
      name             = "adot"
      image            = local.adot_private_image
      essential        = true
      command          = ["--config=/etc/ecs/ecs-default-config.yaml"]
      environment      = local.adot_environment
      logConfiguration = local.adot_log_configuration
    },
  ])

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 4096
  memory                   = 8192
  execution_role_arn       = aws_iam_role.worker_execution.arn
  task_role_arn            = aws_iam_role.worker.arn
  skip_destroy             = true

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = "${data.aws_ecr_repository.worker.repository_url}@${var.worker_image_digest}"
      essential = true
      environment = concat([
        { name = "NODE_ENV", value = "production" },
        { name = "AEO_ENVIRONMENT", value = var.environment },
        { name = "AWS_REGION", value = var.region },
        { name = "AWS_ACCOUNT_ID", value = data.aws_caller_identity.current.account_id },
        { name = "WORKER_MAX_CONCURRENT_JOBS", value = "32" },
        { name = "CRAWL_CONSUMER_CONCURRENCY", value = "2" },
        { name = "GENERATION_CONSUMER_CONCURRENCY", value = "25" },
        { name = "PUBLISH_CONSUMER_CONCURRENCY", value = "2" },
        { name = "MEASUREMENT_CONSUMER_CONCURRENCY", value = "3" },
        { name = "WORKLOAD_DATABASE_POOL_MAX", value = "29" },
        { name = "MEASUREMENT_DATABASE_POOL_MAX", value = "3" },
        { name = "OUTBOX_DATABASE_POOL_MAX", value = "2" },
        { name = "PRIVACY_DATABASE_POOL_MAX", value = "2" },
        { name = "RUNTIME_ISSUER_DATABASE_POOL_MAX", value = "2" },
        { name = "LIFECYCLE_ISSUER_DATABASE_POOL_MAX", value = "2" },
        { name = "CRAWL_QUEUE_URL", value = aws_sqs_queue.crawl.url },
        { name = "GENERATION_QUEUE_URL", value = aws_sqs_queue.generation.url },
        { name = "PUBLISH_QUEUE_URL", value = aws_sqs_queue.publish.url },
        { name = "MEASUREMENT_QUEUE_URL", value = aws_sqs_queue.measurement.url },
        { name = "AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT", value = "sqs" },
        { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.id },
        { name = "AUDIT_EVIDENCE_BUCKET", value = aws_s3_bucket.audit_evidence.id },
        { name = "S3_KMS_KEY_ARN", value = aws_kms_key.data.arn },
        { name = "BACKUP_VAULT_NAME", value = aws_backup_vault.main.name },
        { name = "RDS_INSTANCE_ARN", value = aws_db_instance.main.arn },
        { name = "RDS_INSTANCE_IDENTIFIER", value = aws_db_instance.main.identifier },
        { name = "TENANT_DATA_BROKER_ENDPOINT", value = local.tenant_data_broker_endpoint },
        { name = "TENANT_DATA_BROKER_AUDIENCE", value = local.tenant_data_broker_hostname },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://127.0.0.1:4318" },
        ], var.environment == "staging" ? [
        { name = "GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX", value = "0050" },
        { name = "GENERATION_CAPACITY_PROBE_HOLD_MS", value = "10000" },
      ] : [])
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.runtime_database_url.arn },
        { name = "LIFECYCLE_DATABASE_URL", valueFrom = aws_secretsmanager_secret.lifecycle_database_url.arn },
        { name = "SESSION_ENCRYPTION_KEY", valueFrom = aws_secretsmanager_secret.session_encryption_key.arn },
        { name = "TENANT_DATA_BROKER_HMAC_KEY_RING", valueFrom = aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "worker"
        }
      }
    },
    {
      name             = "adot"
      image            = local.adot_private_image
      essential        = true
      command          = ["--config=/etc/ecs/ecs-default-config.yaml"]
      environment      = local.adot_environment
      logConfiguration = local.adot_log_configuration
    },
  ])

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "tenant_data_broker" {
  family                   = "${local.name}-tenant-data-broker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.tenant_data_broker_execution.arn
  task_role_arn            = aws_iam_role.tenant_data_broker.arn
  skip_destroy             = true

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "tenant-data-broker"
      image     = "${data.aws_ecr_repository.worker.repository_url}@${var.worker_image_digest}"
      essential = true
      portMappings = [{
        containerPort = 3300
        hostPort      = 3300
        protocol      = "tcp"
      }]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "AWS_REGION", value = var.region },
        { name = "AWS_ACCOUNT_ID", value = data.aws_caller_identity.current.account_id },
        { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.id },
        { name = "AUDIT_EVIDENCE_BUCKET", value = aws_s3_bucket.audit_evidence.id },
        { name = "S3_KMS_KEY_ARN", value = aws_kms_key.data.arn },
        { name = "AEOSTUDIO_WORKER_MODE", value = "tenant-data-broker" },
        { name = "TENANT_DATA_BROKER_DATABASE_POOL_MAX", value = "5" },
        { name = "PORT", value = "3300" },
        { name = "TENANT_DATA_BROKER_AUDIENCE", value = local.tenant_data_broker_hostname },
        { name = "OTEL_SERVICE_NAME", value = "aeostudio-tenant-data-broker" },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://127.0.0.1:4318" },
      ]
      secrets = [
        { name = "TENANT_DATA_BROKER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.tenant_data_broker_database_url.arn },
        { name = "TENANT_DATA_BROKER_HMAC_KEY_RING", valueFrom = aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.tenant_data_broker.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "tenant-data-broker"
        }
      }
    },
    {
      name             = "adot"
      image            = local.adot_private_image
      essential        = true
      command          = ["--config=/etc/ecs/ecs-default-config.yaml"]
      environment      = local.adot_environment
      logConfiguration = local.adot_log_configuration
    },
  ])

  tags = merge(local.common_tags, { Service = "tenant-data-broker" })
}

resource "aws_ecs_task_definition" "bootstrap" {
  family                   = "${local.name}-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.bootstrap_execution.arn
  task_role_arn            = aws_iam_role.bootstrap.arn

  container_definitions = jsonencode([{
    name      = "bootstrap"
    image     = "${data.aws_ecr_repository.api.repository_url}@${var.api_image_digest}"
    essential = true
    command   = ["node", "packages/db/dist/bootstrap-main.js"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "AWS_REGION", value = var.region },
      { name = "AEO_ENVIRONMENT", value = var.environment },
      { name = "AEO_DATABASE_NAME", value = aws_db_instance.main.db_name },
      { name = "BOOTSTRAP_CONFIRMATION", value = "bootstrap:${var.environment}" },
      { name = "RDS_MASTER_SECRET_ARN", value = aws_db_instance.main.master_user_secret[0].secret_arn },
      { name = "RUNTIME_DATABASE_URL_SECRET_ARN", value = aws_secretsmanager_secret.runtime_database_url.arn },
      { name = "LIFECYCLE_DATABASE_URL_SECRET_ARN", value = aws_secretsmanager_secret.lifecycle_database_url.arn },
      { name = "ADMIN_DATABASE_URL_SECRET_ARN", value = aws_secretsmanager_secret.admin_database_url.arn },
      { name = "TENANT_DATA_BROKER_DATABASE_URL_SECRET_ARN", value = aws_secretsmanager_secret.tenant_data_broker_database_url.arn },
      { name = "TENANT_DATA_BROKER_HMAC_KEY_RING_SECRET_ARN", value = aws_secretsmanager_secret.tenant_data_broker_hmac_key_ring.arn },
      { name = "SESSION_ENCRYPTION_KEY_SECRET_ARN", value = aws_secretsmanager_secret.session_encryption_key.arn },
      { name = "DELETION_RECEIPT_SIGNING_KEY_SECRET_ARN", value = aws_secretsmanager_secret.deletion_receipt_signing_key.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "bootstrap"
      }
    }
  }])

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "migration" {
  family                   = "${local.name}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.migration_execution.arn
  task_role_arn            = aws_iam_role.migration.arn

  container_definitions = jsonencode([{
    name      = "migration"
    image     = "${data.aws_ecr_repository.api.repository_url}@${var.api_image_digest}"
    essential = true
    # The package exposes start:migrate; the runtime image invokes its compiled entry directly.
    command = ["node", "packages/db/dist/migrate-main.js"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "MIGRATION_DATABASE_POOL_MAX", value = "1" },
      { name = "AWS_REGION", value = var.region },
      { name = "AWS_ACCOUNT_ID", value = data.aws_caller_identity.current.account_id },
      { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.id },
      { name = "AUDIT_EVIDENCE_BUCKET", value = aws_s3_bucket.audit_evidence.id },
      { name = "S3_KMS_KEY_ARN", value = aws_kms_key.data.arn },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.admin_database_url.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "migration"
      }
    }
  }])

  tags = local.common_tags
}

resource "aws_ecs_service" "web" {
  name            = "${local.name}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.bootstrap_complete ? 2 : 0
  launch_type     = "FARGATE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3100
  }

  depends_on = [aws_lb_listener.https]
  tags       = local.common_tags

  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_ecs_service" "api" {
  name                               = "${local.name}-api"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.bootstrap_complete ? 2 : 0
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 150

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3200
  }

  depends_on = [aws_lb_listener_rule.api]
  tags       = local.common_tags

  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_ecs_service" "worker" {
  name                               = "${local.name}-worker"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.bootstrap_complete ? 2 : 0
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 150

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  tags = local.common_tags

  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_ecs_service" "tenant_data_broker" {
  name                               = "${local.name}-tenant-data-broker"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.tenant_data_broker.arn
  desired_count                      = var.bootstrap_complete ? 2 : 0
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 150

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tenant_data_broker.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.tenant_data_broker.arn
    container_name   = "tenant-data-broker"
    container_port   = 3300
  }

  depends_on = [aws_lb_listener.tenant_data_broker_https]
  tags       = merge(local.common_tags, { Service = "tenant-data-broker" })

  lifecycle {
    ignore_changes = [task_definition]
  }
}
