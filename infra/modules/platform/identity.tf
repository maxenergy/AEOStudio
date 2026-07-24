resource "aws_secretsmanager_secret" "runtime_database_url" {
  name                    = "${local.name}/runtime_database_url"
  description             = "Externally seeded least-privilege API database URL; value never enters OpenTofu state"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = merge(local.common_tags, { SecretScope = "api-runtime" })
}

resource "aws_secretsmanager_secret" "lifecycle_database_url" {
  name                    = "${local.name}/lifecycle_database_url"
  description             = "Externally seeded lifecycle Worker database URL; value never enters OpenTofu state"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = merge(local.common_tags, { SecretScope = "lifecycle-worker" })
}

resource "aws_secretsmanager_secret" "admin_database_url" {
  name                    = "${local.name}/admin_database_url"
  description             = "Externally seeded migration-only database URL; separate from the RDS managed master secret"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = merge(local.common_tags, { SecretScope = "migration-admin" })
}

resource "aws_secretsmanager_secret" "tenant_data_broker_database_url" {
  name                    = "${local.name}/tenant_data_broker_database_url"
  description             = "Externally seeded Tenant Data Broker database URL; value never enters OpenTofu state"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = merge(local.common_tags, { SecretScope = "tenant-data-broker-database" })
}

resource "aws_secretsmanager_secret" "tenant_data_broker_hmac_key_ring" {
  name                    = "${local.name}/tenant_data_broker_hmac_key_ring"
  description             = "Bootstrap-seeded versioned Broker HMAC key ring; value never enters OpenTofu state"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = merge(local.common_tags, {
    SecretScope  = "tenant-data-broker-hmac"
    SecretSchema = "aeostudio.tenant-data-broker-key-ring.v1"
  })
}

resource "aws_secretsmanager_secret" "session_encryption_key" {
  name                    = "${local.name}/session_encryption_key"
  description             = "Externally seeded 32-byte base64url session encryption key"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = merge(local.common_tags, { SecretScope = "session-crypto" })
}

resource "aws_secretsmanager_secret" "deletion_receipt_signing_key" {
  name                    = "${local.name}/deletion_receipt_signing_key"
  description             = "Externally seeded base64url deletion-receipt signing key"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = merge(local.common_tags, { SecretScope = "receipt-signing" })
}

resource "aws_cognito_user_pool" "main" {
  name              = "${local.name}-users"
  mfa_configuration = "ON"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  software_token_mfa_configuration {
    enabled = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 1
  }

  deletion_protection = "ACTIVE"
  tags                = local.common_tags
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.name}-web-pkce"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["${local.public_origin}/api/v1/auth/callback"]
  logout_urls                          = ["${local.public_origin}/login"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true

  access_token_validity  = 15
  id_token_validity      = 15
  refresh_token_validity = 1

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_pool_domain" "custom_domain" {
  domain          = local.cognito_custom_domain
  certificate_arn = var.cognito_custom_domain_certificate_arn
  user_pool_id    = aws_cognito_user_pool.main.id

  depends_on = [aws_route53_record.application]
}
