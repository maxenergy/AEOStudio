variable "environment" {
  description = "Deployment environment name."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be staging or production."
  }
}

variable "region" {
  description = "AWS data-plane region."
  type        = string
  default     = "ap-southeast-1"

  validation {
    condition     = var.region == "ap-southeast-1"
    error_message = "AEOStudio data-plane resources are resident in AWS Singapore."
  }
}

variable "availability_zones" {
  description = "The two Singapore availability zones used by all network tiers."
  type        = list(string)
  default     = ["ap-southeast-1a", "ap-southeast-1b"]

  validation {
    condition     = length(var.availability_zones) == 2 && alltrue([for zone in var.availability_zones : startswith(zone, "ap-southeast-1")])
    error_message = "Exactly two Singapore availability zones are required."
  }
}

variable "public_hostname" {
  description = "Public application FQDN in the delegated Route53 zone."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.public_hostname))
    error_message = "public_hostname must be a lowercase fully qualified DNS name."
  }
}

variable "route53_zone_id" {
  description = "Route53 public hosted-zone ID that owns the application and Cognito records."
  type        = string
}

variable "cognito_custom_domain_certificate_arn" {
  description = "ACM us-east-1 certificate ARN covering auth.<public_hostname>, as required by Cognito custom domains."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/", var.cognito_custom_domain_certificate_arn))
    error_message = "Cognito custom-domain certificate must be an ACM certificate in us-east-1."
  }
}

variable "operations_alert_email" {
  description = "Address that confirms the encrypted operations alarm subscription."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.operations_alert_email))
    error_message = "operations_alert_email must be an email address."
  }
}

variable "deploy_role_name" {
  description = "Pre-created environment deployer role owned by the global bootstrap state."
  type        = string
}

variable "bootstrap_operator_role_name" {
  description = "Pre-created protected-environment bootstrap operator role owned by the global bootstrap state."
  type        = string
}

variable "restore_drill_operator_role_name" {
  description = "Pre-created staging-only restore-drill operator role owned by the global bootstrap state."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.restore_drill_operator_role_name == null || var.restore_drill_operator_role_name == "aeostudio-staging-restore-drill-operator"
    error_message = "The only supported recovery operator is the protected staging restore-drill role."
  }
}

variable "staging_acceptance_operator_role_name" {
  description = "Pre-created protected staging acceptance operator role owned by the global bootstrap state."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.staging_acceptance_operator_role_name == null || var.staging_acceptance_operator_role_name == "aeostudio-staging-acceptance-operator"
    error_message = "The only supported acceptance operator is the protected staging acceptance role."
  }
}

variable "web_image_digest" {
  description = "Immutable Web image digest."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.web_image_digest))
    error_message = "Web image must be selected by a sha256 digest."
  }
}

variable "api_image_digest" {
  description = "Immutable API image digest."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.api_image_digest))
    error_message = "API image must be selected by a sha256 digest."
  }
}

variable "worker_image_digest" {
  description = "Immutable Worker image digest."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.worker_image_digest))
    error_message = "Worker image must be selected by a sha256 digest."
  }
}

variable "recovery_image_digest" {
  description = "Immutable staging restore-drill image digest; production leaves this unset and creates no recovery runner."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.recovery_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.recovery_image_digest))
    error_message = "Recovery image must be selected by a sha256 digest when the staging runner is enabled."
  }
}

variable "adot_image" {
  description = "Immutable ADOT Collector image reference."
  type        = string

  validation {
    condition     = can(regex("^public\\.ecr\\.aws/aws-observability/aws-otel-collector@sha256:[0-9a-f]{64}$", var.adot_image))
    error_message = "ADOT Collector must be pinned to a public ECR sha256 digest."
  }
}

variable "bootstrap_complete" {
  description = "Explicit operator confirmation that database principals and runtime secrets have been bootstrapped."
  type        = bool
  default     = false
}

variable "enable_backup_vault_lock" {
  description = "Explicit approval gate for reversible Backup Vault Lock governance controls."
  type        = bool
  default     = false
}
