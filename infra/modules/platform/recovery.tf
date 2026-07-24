resource "aws_backup_vault" "main" {
  name        = "${local.name}-backup"
  kms_key_arn = aws_kms_key.data.arn
  tags        = local.common_tags
}

resource "aws_backup_vault_lock_configuration" "governance" {
  count = var.enable_backup_vault_lock ? 1 : 0

  backup_vault_name  = aws_backup_vault.main.name
  min_retention_days = 15
  max_retention_days = 365
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${local.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_iam_role_policy_attachment" "backup_s3" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForS3Backup"
}

resource "aws_iam_role_policy_attachment" "restore_s3" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForS3Restore"
}

resource "aws_backup_plan" "main" {
  name = "${local.name}-continuous"

  rule {
    rule_name                = "${local.name}-continuous"
    target_vault_name        = aws_backup_vault.main.name
    schedule                 = "cron(0 18 * * ? *)"
    start_window             = 60
    completion_window        = 360
    enable_continuous_backup = true

    lifecycle {
      delete_after = 35
    }

    recovery_point_tags = merge(local.common_tags, { Recovery = "continuous" })
  }

  tags = local.common_tags
}

resource "aws_backup_selection" "data_plane" {
  name         = "${local.name}-data-plane"
  plan_id      = aws_backup_plan.main.id
  iam_role_arn = aws_iam_role.backup.arn

  resources = [
    aws_db_instance.main.arn,
    aws_s3_bucket.artifacts.arn,
    aws_s3_bucket.audit_evidence.arn,
  ]
}

resource "aws_backup_restore_testing_plan" "main" {
  name                         = "aeostudio_${var.environment}_restore"
  schedule_expression          = "cron(0 2 ? * SUN *)"
  schedule_expression_timezone = "Asia/Singapore"
  start_window_hours           = 4

  recovery_point_selection {
    algorithm             = "LATEST_WITHIN_WINDOW"
    include_vaults        = [aws_backup_vault.main.arn]
    recovery_point_types  = ["CONTINUOUS", "SNAPSHOT"]
    selection_window_days = 7
  }

  tags = local.common_tags
}

resource "aws_backup_restore_testing_selection" "database" {
  name                      = "postgres_restore"
  restore_testing_plan_name = aws_backup_restore_testing_plan.main.name
  protected_resource_type   = "RDS"
  iam_role_arn              = aws_iam_role.backup.arn
  protected_resource_arns   = [aws_db_instance.main.arn]
  validation_window_hours   = 4
}
