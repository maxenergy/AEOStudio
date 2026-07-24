locals {
  name                        = "aeostudio-${var.environment}"
  public_origin               = "https://${var.public_hostname}"
  cognito_custom_domain       = "auth.${var.public_hostname}"
  tenant_data_broker_hostname = "broker.${var.public_hostname}"
  tenant_data_broker_endpoint = "https://${local.tenant_data_broker_hostname}/internal/v1/tenant-data"

  kms_admin_actions = [
    "kms:CancelKeyDeletion",
    "kms:CreateAlias",
    "kms:CreateGrant",
    "kms:Decrypt",
    "kms:DeleteAlias",
    "kms:DescribeKey",
    "kms:DisableKey",
    "kms:DisableKeyRotation",
    "kms:EnableKey",
    "kms:EnableKeyRotation",
    "kms:Encrypt",
    "kms:GenerateDataKey",
    "kms:GenerateDataKeyWithoutPlaintext",
    "kms:GetKeyPolicy",
    "kms:GetKeyRotationStatus",
    "kms:ListAliases",
    "kms:ListGrants",
    "kms:ListKeyPolicies",
    "kms:ListResourceTags",
    "kms:ListRetirableGrants",
    "kms:PutKeyPolicy",
    "kms:ReEncryptFrom",
    "kms:ReEncryptTo",
    "kms:RetireGrant",
    "kms:RevokeGrant",
    "kms:ScheduleKeyDeletion",
    "kms:TagResource",
    "kms:UntagResource",
    "kms:UpdateAlias",
    "kms:UpdateKeyDescription",
  ]

  common_tags = {
    Application = "aeostudio"
    Environment = var.environment
    ManagedBy   = "opentofu"
    DataClass   = var.environment == "staging" ? "synthetic-only" : "tenant-data"
  }

  public_cidrs  = ["10.42.0.0/24", "10.42.1.0/24"]
  private_cidrs = ["10.42.10.0/24", "10.42.11.0/24"]
}
