variable "public_hostname" {
  description = "Public production application FQDN."
  type        = string
}

variable "route53_zone_id" {
  description = "Route53 public hosted-zone ID for production records."
  type        = string
}

variable "cognito_custom_domain_certificate_arn" {
  description = "us-east-1 ACM certificate for the production Cognito custom domain."
  type        = string
}

variable "operations_alert_email" {
  description = "Production operations alert subscriber."
  type        = string
}

variable "web_image_digest" {
  description = "The exact Web digest already attested and verified in staging."
  type        = string
}

variable "api_image_digest" {
  description = "The exact API digest already attested and verified in staging."
  type        = string
}

variable "worker_image_digest" {
  description = "The exact Worker digest already attested and verified in staging."
  type        = string
}

variable "adot_image" {
  description = "Pinned ADOT Collector digest already verified in staging."
  type        = string
}

variable "bootstrap_complete" {
  description = "Set true only after the one-off bootstrap and exact-digest migration tasks have succeeded."
  type        = bool
  default     = false
}

variable "enable_backup_vault_lock" {
  description = "Defaults off; enable only through a separately approved production environment change."
  type        = bool
  default     = false
}
