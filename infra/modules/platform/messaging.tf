resource "aws_sqs_queue" "crawl_dlq" {
  name                      = "${local.name}-crawl-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

  tags = local.common_tags
}

resource "aws_sqs_queue" "crawl" {
  name                       = "${local.name}-crawl"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  kms_master_key_id          = aws_kms_key.data.arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.crawl_dlq.arn
    maxReceiveCount     = 100
  })

  tags = local.common_tags
}

resource "aws_sqs_queue" "generation_dlq" {
  name                      = "${local.name}-generation-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

  tags = local.common_tags
}

resource "aws_sqs_queue" "generation" {
  name                       = "${local.name}-generation"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  kms_master_key_id          = aws_kms_key.data.arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.generation_dlq.arn
    maxReceiveCount     = 100
  })

  tags = local.common_tags
}

resource "aws_sqs_queue" "publish_dlq" {
  name                      = "${local.name}-publish-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

  tags = local.common_tags
}

resource "aws_sqs_queue" "publish" {
  name                       = "${local.name}-publish"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  kms_master_key_id          = aws_kms_key.data.arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.publish_dlq.arn
    maxReceiveCount     = 100
  })

  tags = local.common_tags
}

resource "aws_sqs_queue" "measurement_dlq" {
  name                      = "${local.name}-measurement-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

  tags = local.common_tags
}

resource "aws_sqs_queue" "measurement" {
  name                       = "${local.name}-measurement"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  kms_master_key_id          = aws_kms_key.data.arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.measurement_dlq.arn
    maxReceiveCount     = 100
  })

  tags = local.common_tags
}

resource "aws_sqs_queue" "lifecycle_dlq" {
  name                      = "${local.name}-lifecycle-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.data.arn

  tags = local.common_tags
}

resource "aws_sqs_queue" "lifecycle" {
  name                       = "${local.name}-lifecycle"
  visibility_timeout_seconds = 300
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  kms_master_key_id          = aws_kms_key.data.arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.lifecycle_dlq.arn
    maxReceiveCount     = 5
  })

  tags = local.common_tags
}

resource "aws_sqs_queue_redrive_allow_policy" "crawl_dlq" {
  queue_url = aws_sqs_queue.crawl_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.crawl.arn]
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "generation_dlq" {
  queue_url = aws_sqs_queue.generation_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.generation.arn]
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "publish_dlq" {
  queue_url = aws_sqs_queue.publish_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.publish.arn]
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "measurement_dlq" {
  queue_url = aws_sqs_queue.measurement_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.measurement.arn]
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "lifecycle_dlq" {
  queue_url = aws_sqs_queue.lifecycle_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.lifecycle.arn]
  })
}
