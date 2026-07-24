data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "artifacts" {
  bucket              = "${local.name}-${data.aws_caller_identity.current.account_id}-artifacts"
  object_lock_enabled = true

  tags = merge(local.common_tags, { Purpose = "tenant-artifacts" })
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.data.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "tenant-artifact-retention"
    status = "Enabled"

    filter {}

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }

    expiration {
      days = 180
    }

    noncurrent_version_expiration {
      noncurrent_days = 180
    }
  }

  depends_on = [aws_s3_bucket_versioning.artifacts]
}

resource "aws_s3_bucket" "audit_evidence" {
  bucket              = "${local.name}-${data.aws_caller_identity.current.account_id}-audit"
  object_lock_enabled = true

  tags = merge(local.common_tags, { Purpose = "immutable-audit-evidence" })
}

resource "aws_s3_bucket_public_access_block" "audit_evidence" {
  bucket = aws_s3_bucket.audit_evidence.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "audit_evidence" {
  bucket = aws_s3_bucket.audit_evidence.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_evidence" {
  bucket = aws_s3_bucket.audit_evidence.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.data.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit_evidence" {
  bucket = aws_s3_bucket.audit_evidence.id

  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = 365
    }
  }

  depends_on = [aws_s3_bucket_versioning.audit_evidence]
}

resource "aws_s3_bucket_lifecycle_configuration" "audit_evidence" {
  bucket = aws_s3_bucket.audit_evidence.id

  rule {
    id     = "audit-evidence-retention"
    status = "Enabled"

    filter {}

    expiration {
      days = 365
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  depends_on = [
    aws_s3_bucket_versioning.audit_evidence,
    aws_s3_bucket_object_lock_configuration.audit_evidence,
  ]
}

locals {
  tenant_data_buckets = {
    artifacts = {
      arn = aws_s3_bucket.artifacts.arn
      id  = aws_s3_bucket.artifacts.id
    }
    audit_evidence = {
      arn = aws_s3_bucket.audit_evidence.arn
      id  = aws_s3_bucket.audit_evidence.id
    }
  }
}

data "aws_iam_policy_document" "tenant_data_kms_enforcement" {
  for_each = local.tenant_data_buckets

  statement {
    sid     = "DenyTenantObjectsWithoutKms"
    effect  = "Deny"
    actions = ["s3:PutObject"]
    resources = [
      "${each.value.arn}/tenants/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid     = "DenyTenantObjectsWithWrongKmsKey"
    effect  = "Deny"
    actions = ["s3:PutObject"]
    resources = [
      "${each.value.arn}/tenants/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.data.arn]
    }
  }

  statement {
    sid     = "DenyTenantObjectsWithoutBucketKey"
    effect  = "Deny"
    actions = ["s3:PutObject"]
    resources = [
      "${each.value.arn}/tenants/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-bucket-key-enabled"
      values   = ["true"]
    }
  }
}

resource "aws_s3_bucket_policy" "tenant_data_kms_enforcement" {
  for_each = local.tenant_data_buckets

  bucket = each.value.id
  policy = data.aws_iam_policy_document.tenant_data_kms_enforcement[each.key].json
}

resource "aws_s3_bucket" "alb_logs" {
  bucket = "${local.name}-${data.aws_caller_identity.current.account_id}-alb-logs"

  tags = merge(local.common_tags, { Purpose = "alb-access-logs" })
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Application Load Balancer log delivery supports SSE-S3 only:
# https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html
# trivy:ignore:AWS-0132:exp:2027-07-24
resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 90
    }
  }
}

data "aws_iam_policy_document" "alb_logs" {
  statement {
    sid       = "AllowLogDeliveryAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.alb_logs.arn]

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }
  }

  statement {
    sid       = "AllowLogDeliveryWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_logs.arn}/alb-access/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:elasticloadbalancing:${var.region}:${data.aws_caller_identity.current.account_id}:loadbalancer/*"]
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = data.aws_iam_policy_document.alb_logs.json
}
