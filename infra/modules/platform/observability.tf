data "aws_iam_policy_document" "operations_key" {
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
    sid    = "CloudWatchAlarmDelivery"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_kms_key" "operations" {
  description             = "${local.name} CloudWatch alarm delivery"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.operations_key.json

  tags = local.common_tags
}

resource "aws_sns_topic" "operations" {
  name              = "${local.name}-operations"
  kms_master_key_id = aws_kms_key.operations.id
  tags              = local.common_tags
}

data "aws_iam_policy_document" "operations_topic" {
  statement {
    sid    = "AccountTopicAdministration"
    effect = "Allow"
    actions = [
      "sns:AddPermission",
      "sns:DeleteTopic",
      "sns:GetTopicAttributes",
      "sns:ListSubscriptionsByTopic",
      "sns:Publish",
      "sns:RemovePermission",
      "sns:SetTopicAttributes",
      "sns:Subscribe",
    ]
    resources = [aws_sns_topic.operations.arn]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "CloudWatchPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.operations.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudwatch:${var.region}:${data.aws_caller_identity.current.account_id}:alarm:${local.name}-*"]
    }
  }
}

resource "aws_sns_topic_policy" "operations" {
  arn    = aws_sns_topic.operations.arn
  policy = data.aws_iam_policy_document.operations_topic.json
}

resource "aws_sns_topic_subscription" "operations_email" {
  topic_arn = aws_sns_topic.operations.arn
  protocol  = "email"
  endpoint  = var.operations_alert_email
}

resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  alarm_name          = "${local.name}-alb-target-latency"
  alarm_description   = "TargetResponseTime p95 breached"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 0.5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "alb_target_5xx" {
  alarm_name          = "${local.name}-alb-target-5xx"
  alarm_description   = "Target HTTP 5xx responses exceeded the bounded error budget"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "slo_fast_burn" {
  alarm_name          = "${local.name}-slo-fast-burn"
  alarm_description   = "Target 5xx ratio is consuming the HTTP availability error budget"
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]

  metric_query {
    id          = "errors"
    return_data = false

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 60
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.main.arn_suffix
      }
    }
  }

  metric_query {
    id          = "requests"
    return_data = false

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 60
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.main.arn_suffix
      }
    }
  }

  metric_query {
    id          = "burn"
    expression  = "IF(requests > 0, errors / requests * 100, 0)"
    label       = "Target 5xx percentage"
    return_data = true
  }

  tags = local.common_tags
}

locals {
  operational_log_metrics = {
    budget_warning = {
      log_group_name = aws_cloudwatch_log_group.api.name
      pattern        = "{ $.event = \"BUDGET_WARNING\" }"
      metric_name    = "${local.name}-budget-warning-count"
    }
    budget_blocked = {
      log_group_name = aws_cloudwatch_log_group.api.name
      pattern        = "{ $.event = \"BUDGET_BLOCKED\" }"
      metric_name    = "${local.name}-budget-blocked-count"
    }
    authentication_denied = {
      log_group_name = aws_cloudwatch_log_group.api.name
      pattern        = "{ $.event = \"AUTHENTICATION_DENIED\" }"
      metric_name    = "${local.name}-authentication-denied-count"
    }
    job_heartbeat_failed = {
      log_group_name = aws_cloudwatch_log_group.worker.name
      pattern        = "{ $.event = \"JOB_HEARTBEAT_FAILED\" }"
      metric_name    = "${local.name}-job-heartbeat-failed-count"
    }
    provider_failed = {
      log_group_name = aws_cloudwatch_log_group.worker.name
      pattern        = "{ $.event = \"PROVIDER_FAILED\" }"
      metric_name    = "${local.name}-provider-failed-count"
    }
    publication_failed = {
      log_group_name = aws_cloudwatch_log_group.worker.name
      pattern        = "{ $.event = \"PUBLICATION_FAILED\" }"
      metric_name    = "${local.name}-publication-failed-count"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "operational" {
  for_each = local.operational_log_metrics

  name           = "${local.name}-${replace(each.key, "_", "-")}"
  log_group_name = each.value.log_group_name
  pattern        = each.value.pattern

  metric_transformation {
    name      = each.value.metric_name
    namespace = "AEOStudio/Operations"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "budget_warning" {
  alarm_name          = "${local.name}-budget-warning"
  alarm_description   = "At least one Workspace crossed its configured budget warning boundary"
  namespace           = "AEOStudio/Operations"
  metric_name         = "${local.name}-budget-warning-count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "budget_blocked" {
  alarm_name          = "${local.name}-budget-blocked"
  alarm_description   = "A paid Job was rejected by the budget hard stop"
  namespace           = "AEOStudio/Operations"
  metric_name         = "${local.name}-budget-blocked-count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "authentication_denied" {
  alarm_name          = "${local.name}-authentication-denied"
  alarm_description   = "Authentication or request-origin denials exceeded the bounded rate"
  namespace           = "AEOStudio/Operations"
  metric_name         = "${local.name}-authentication-denied-count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 20
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "job_heartbeat_failed" {
  alarm_name          = "${local.name}-job-heartbeat-failed"
  alarm_description   = "A Worker could not extend its visibility heartbeat"
  namespace           = "AEOStudio/Operations"
  metric_name         = "${local.name}-job-heartbeat-failed-count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "provider_failed" {
  alarm_name          = "${local.name}-provider-failed"
  alarm_description   = "A measurement Provider Job reached a terminal failure"
  namespace           = "AEOStudio/Operations"
  metric_name         = "${local.name}-provider-failed-count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "publication_failed" {
  alarm_name          = "${local.name}-publication-failed"
  alarm_description   = "An authorized publication Job reached a terminal failure"
  namespace           = "AEOStudio/Operations"
  metric_name         = "${local.name}-publication-failed-count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each = {
    crawl       = aws_sqs_queue.crawl.name
    generation  = aws_sqs_queue.generation.name
    publish     = aws_sqs_queue.publish.name
    measurement = aws_sqs_queue.measurement.name
    lifecycle   = aws_sqs_queue.lifecycle.name
  }

  alarm_name          = "${local.name}-${each.key}-queue-age"
  alarm_description   = "ApproximateAgeOfOldestMessage exceeded the job-start SLO"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 30
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]

  dimensions = { QueueName = each.value }
  tags       = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "dlq_visible" {
  for_each = {
    crawl       = aws_sqs_queue.crawl_dlq.name
    generation  = aws_sqs_queue.generation_dlq.name
    publish     = aws_sqs_queue.publish_dlq.name
    measurement = aws_sqs_queue.measurement_dlq.name
    lifecycle   = aws_sqs_queue.lifecycle_dlq.name
  }

  alarm_name          = "${local.name}-${each.key}-dlq-visible"
  alarm_description   = "ApproximateNumberOfMessagesVisible in a dead-letter queue"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]

  dimensions = { QueueName = each.value }
  tags       = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "database_connections" {
  alarm_name          = "${local.name}-database-connections"
  alarm_description   = "DatabaseConnections exceeded the safe operating limit"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 160
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.operations.arn]

  dimensions = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  tags       = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "database_storage" {
  alarm_name          = "${local.name}-database-free-storage"
  alarm_description   = "FreeStorageSpace is below 20 GiB"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 21474836480
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.operations.arn]

  dimensions = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  tags       = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "backup_failures" {
  for_each = toset(["RDS", "S3"])

  alarm_name          = "${local.name}-${lower(each.value)}-backup-jobs-failed"
  alarm_description   = "Backup jobs must not fail for ${each.value}"
  namespace           = "AWS/Backup"
  metric_name         = "NumberOfBackupJobsFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]

  dimensions = { ResourceType = each.value }
  tags       = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "restore_failures" {
  for_each = toset(["RDS", "S3"])

  alarm_name          = "${local.name}-${lower(each.value)}-restore-jobs-failed"
  alarm_description   = "Restore jobs must not fail for ${each.value}"
  namespace           = "AWS/Backup"
  metric_name         = "NumberOfRestoreJobsFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]

  dimensions = { ResourceType = each.value }
  tags       = local.common_tags
}
