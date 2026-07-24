locals {
  staging_acceptance_operator_enabled = var.environment == "staging" && var.staging_acceptance_operator_role_name != null
}

data "aws_iam_role" "staging_acceptance_operator" {
  count = local.staging_acceptance_operator_enabled ? 1 : 0

  name = var.staging_acceptance_operator_role_name
}

data "aws_iam_policy_document" "staging_acceptance_operator" {
  count = local.staging_acceptance_operator_enabled ? 1 : 0

  statement {
    sid    = "QueryExactStagingApplicationLogs"
    effect = "Allow"
    actions = [
      "logs:GetQueryResults",
      "logs:StartQuery",
    ]
    resources = [aws_cloudwatch_log_group.api.arn, aws_cloudwatch_log_group.worker.arn]
  }

  statement {
    sid       = "ReadExactXrayTraces"
    effect    = "Allow"
    actions   = ["xray:BatchGetTraces"]
    resources = ["*"]
  }

  statement {
    sid    = "ReadStagingAlarmInventoryAndHistory"
    effect = "Allow"
    actions = [
      "cloudwatch:DescribeAlarms",
      "cloudwatch:DescribeAlarmHistory",
    ]
    resources = ["*"]
  }

}

resource "aws_iam_role_policy" "staging_acceptance_operator" {
  count = local.staging_acceptance_operator_enabled ? 1 : 0

  name   = "aeostudio-staging-acceptance-operator"
  role   = data.aws_iam_role.staging_acceptance_operator[0].id
  policy = data.aws_iam_policy_document.staging_acceptance_operator[0].json
}
