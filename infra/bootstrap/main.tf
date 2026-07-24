locals {
  repositories = {
    adot     = "aeostudio-adot"
    api      = "aeostudio-api"
    recovery = "aeostudio-recovery"
    web      = "aeostudio-web"
    worker   = "aeostudio-worker"
  }

  github_subjects = {
    builder               = "repo:${var.github_repository}:ref:refs/heads/main"
    verifier              = "repo:${var.github_repository}:ref:refs/heads/main"
    staging               = "repo:${var.github_repository}:environment:staging"
    production            = "repo:${var.github_repository}:environment:production"
    bootstrap_staging     = "repo:${var.github_repository}:environment:bootstrap-staging"
    bootstrap_production  = "repo:${var.github_repository}:environment:bootstrap-production"
    restore_drill_staging = "repo:${var.github_repository}:environment:restore-drill-staging"
    staging_acceptance    = "repo:${var.github_repository}:environment:staging-acceptance"
    staging_plan          = "repo:${var.github_repository}:environment:staging-plan"
  }
}

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "ecr" {
  description             = "AEOStudio shared ECR encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "ecr" {
  name          = "alias/aeostudio-ecr"
  target_key_id = aws_kms_key.ecr.key_id
}

resource "aws_ecr_repository" "shared" {
  for_each = local.repositories

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.ecr.arn
  }
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_assume" {
  for_each = local.github_subjects

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [each.value]
    }
  }
}

resource "aws_iam_role" "image_builder" {
  name               = "aeostudio-staging-image-builder"
  assume_role_policy = data.aws_iam_policy_document.github_assume["builder"].json
}

resource "aws_iam_role" "release_verifier" {
  name               = "aeostudio-release-verifier"
  assume_role_policy = data.aws_iam_policy_document.github_assume["verifier"].json
}

resource "aws_iam_role" "staging_deployer" {
  name                 = "aeostudio-staging-deployer"
  assume_role_policy   = data.aws_iam_policy_document.github_assume["staging"].json
  max_session_duration = 10800
}

resource "aws_iam_role" "production_deployer" {
  name                 = "aeostudio-production-deployer"
  assume_role_policy   = data.aws_iam_policy_document.github_assume["production"].json
  max_session_duration = 21600
}

resource "aws_iam_role" "staging_bootstrap_operator" {
  name                 = "aeostudio-staging-bootstrap-operator"
  assume_role_policy   = data.aws_iam_policy_document.github_assume["bootstrap_staging"].json
  max_session_duration = 10800
}

resource "aws_iam_role" "production_bootstrap_operator" {
  name                 = "aeostudio-production-bootstrap-operator"
  assume_role_policy   = data.aws_iam_policy_document.github_assume["bootstrap_production"].json
  max_session_duration = 10800
}

resource "aws_iam_role" "staging_restore_drill_operator" {
  name                 = "aeostudio-staging-restore-drill-operator"
  assume_role_policy   = data.aws_iam_policy_document.github_assume["restore_drill_staging"].json
  max_session_duration = 18000
}

resource "aws_iam_role" "staging_acceptance_operator" {
  name               = "aeostudio-staging-acceptance-operator"
  assume_role_policy = data.aws_iam_policy_document.github_assume["staging_acceptance"].json
}

resource "aws_iam_role" "staging_plan" {
  name               = "aeostudio-staging-plan"
  assume_role_policy = data.aws_iam_policy_document.github_assume["staging_plan"].json
}

data "aws_iam_policy_document" "staging_plan" {
  statement {
    sid     = "ReadExactStagingState"
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = [
      "${var.staging_plan_state_bucket_arn}/${var.staging_plan_state_key}",
    ]
  }

  statement {
    sid    = "ReadExactStagingParameters"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:ListTagsForResource",
    ]
    resources = [
      "arn:aws:ssm:ap-southeast-1:${data.aws_caller_identity.current.account_id}:parameter/aeostudio/staging/release-contract",
      "arn:aws:ssm:ap-southeast-1:${data.aws_caller_identity.current.account_id}:parameter/aeostudio/staging/bootstrap-contract",
      "arn:aws:ssm:ap-southeast-1:${data.aws_caller_identity.current.account_id}:parameter/aeostudio/staging/recovery/restore-drill-input",
    ]
  }

  statement {
    sid       = "ListExactStagingState"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.staging_plan_state_bucket_arn]

    condition {
      test     = "StringEquals"
      variable = "s3:prefix"
      values   = [var.staging_plan_state_key]
    }
  }

  statement {
    sid    = "ReadStagingProviderMetadata"
    effect = "Allow"
    actions = [
      "acm:DescribeCertificate",
      "acm:ListTagsForCertificate",
      "backup:DescribeBackupVault",
      "backup:GetBackupPlan",
      "backup:GetBackupSelection",
      "backup:GetRestoreTestingPlan",
      "backup:GetRestoreTestingSelection",
      "backup:ListTags",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:ListTagsForResource",
      "cognito-idp:DescribeUserPool",
      "cognito-idp:DescribeUserPoolClient",
      "cognito-idp:DescribeUserPoolDomain",
      "cognito-idp:ListTagsForResource",
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:ListTagsOfResource",
      "ec2:DescribeAddresses",
      "ec2:DescribeAvailabilityZones",
      "ec2:DescribeInternetGateways",
      "ec2:DescribeManagedPrefixLists",
      "ec2:DescribeNatGateways",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribePrefixLists",
      "ec2:DescribeRouteTables",
      "ec2:DescribeSecurityGroupRules",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeTags",
      "ec2:DescribeVpcAttribute",
      "ec2:DescribeVpcEndpoints",
      "ec2:DescribeVpcs",
      "ec2:GetManagedPrefixListEntries",
      "ecr:DescribeRepositories",
      "ecs:DescribeClusters",
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:ListTagsForResource",
      "elasticloadbalancing:DescribeListeners",
      "elasticloadbalancing:DescribeListenerAttributes",
      "elasticloadbalancing:DescribeListenerRules",
      "elasticloadbalancing:DescribeLoadBalancerAttributes",
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:DescribeTags",
      "elasticloadbalancing:DescribeTargetGroupAttributes",
      "elasticloadbalancing:DescribeTargetGroups",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListPolicyVersions",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListAliases",
      "kms:ListResourceTags",
      "logs:DescribeLogGroups",
      "logs:DescribeMetricFilters",
      "logs:ListTagsForResource",
      "rds:DescribeDBInstances",
      "rds:DescribeDBParameterGroups",
      "rds:DescribeDBParameters",
      "rds:DescribeDBSubnetGroups",
      "rds:ListTagsForResource",
      "route53:GetHostedZone",
      "route53:ListResourceRecordSets",
      "route53:ListTagsForResource",
      "s3:GetAccelerateConfiguration",
      "s3:GetBucketAcl",
      "s3:GetBucketCORS",
      "s3:GetBucketLocation",
      "s3:GetBucketLogging",
      "s3:GetBucketObjectLockConfiguration",
      "s3:GetBucketPolicy",
      "s3:GetBucketPolicyStatus",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketRequestPayment",
      "s3:GetBucketTagging",
      "s3:GetBucketVersioning",
      "s3:GetBucketWebsite",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      "secretsmanager:DescribeSecret",
      "secretsmanager:ListSecretVersionIds",
      "sfn:DescribeStateMachine",
      "sfn:ListTagsForResource",
      "sns:GetSubscriptionAttributes",
      "sns:GetTopicAttributes",
      "sns:ListSubscriptionsByTopic",
      "sns:ListTagsForResource",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ListDeadLetterSourceQueues",
      "sqs:ListQueueTags",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "staging_plan" {
  name   = "aeostudio-staging-plan-read-only"
  role   = aws_iam_role.staging_plan.id
  policy = data.aws_iam_policy_document.staging_plan.json
}

data "aws_iam_policy_document" "image_builder" {
  statement {
    sid       = "AuthenticateToEcr"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "BuildPushAndAttestImages"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [for repository in aws_ecr_repository.shared : repository.arn]
  }
}

resource "aws_iam_role_policy" "image_builder" {
  name   = "aeostudio-staging-image-builder"
  role   = aws_iam_role.image_builder.id
  policy = data.aws_iam_policy_document.image_builder.json
}

data "aws_iam_policy_document" "release_verifier" {
  statement {
    sid       = "AuthenticateToEcr"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "ReadAttestedImageManifests"
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
    ]
    resources = [for repository in aws_ecr_repository.shared : repository.arn]
  }
}

resource "aws_iam_role_policy" "release_verifier" {
  name   = "aeostudio-release-verifier"
  role   = aws_iam_role.release_verifier.id
  policy = data.aws_iam_policy_document.release_verifier.json
}
