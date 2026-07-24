data "aws_iam_policy_document" "data_key" {
  statement {
    sid       = "AccountAdministration"
    effect    = "Allow"
    actions   = local.kms_admin_actions
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid    = "CloudWatchLogsEncryption"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${local.name}/*"]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "${local.name} data encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.data_key.json

  tags = local.common_tags
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "secrets" {
  description             = "${local.name} managed secret encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = local.common_tags
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${local.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-postgres"
  subnet_ids = aws_subnet.private[*].id

  tags = local.common_tags
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "PostgreSQL accepts only API Worker migration and Tenant Data Broker tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "PostgreSQL from application task roles"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    security_groups = [
      aws_security_group.api.id,
      aws_security_group.worker.id,
      aws_security_group.migration.id,
      aws_security_group.tenant_data_broker.id,
    ]
  }

  egress {
    description = "No broad outbound path is required"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  tags = local.common_tags
}

resource "aws_db_parameter_group" "postgres18_tls" {
  name   = "${local.name}-postgres18-tls"
  family = "postgres18"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  tags = local.common_tags
}

resource "aws_db_instance" "main" {
  identifier = "${local.name}-postgres"

  engine         = "postgres"
  engine_version = "18.1"
  instance_class = "db.t4g.medium"

  allocated_storage     = 100
  max_allocated_storage = 500
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.data.arn

  db_name  = "aeostudio"
  username = "aeostudio_admin"

  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.secrets.arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  parameter_group_name   = aws_db_parameter_group.postgres18_tls.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  multi_az               = true

  # Keep native RDS PITR aligned with the AWS Backup continuous rule.
  backup_retention_period = 35
  backup_window           = "18:00-19:00"
  maintenance_window      = "sun:20:00-sun:21:00"
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade = true
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${local.name}-postgres-final"
  apply_immediately          = false

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = merge(local.common_tags, { Backup = "continuous" })
}
