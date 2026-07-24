variable "public_hostname" {
  description = "Public staging application FQDN."
  type        = string
}

variable "route53_zone_id" {
  description = "Route53 public hosted-zone ID for staging records."
  type        = string
}

variable "cognito_custom_domain_certificate_arn" {
  description = "us-east-1 ACM certificate for the staging Cognito custom domain."
  type        = string
}

variable "operations_alert_email" {
  description = "Staging operations alert subscriber."
  type        = string
}

variable "web_image_digest" {
  description = "Promoted Web image digest; CI overrides this placeholder before planning."
  type        = string
}

variable "api_image_digest" {
  description = "Promoted API image digest; CI overrides this placeholder before planning."
  type        = string
}

variable "worker_image_digest" {
  description = "Promoted Worker image digest; CI overrides this placeholder before planning."
  type        = string
}

variable "recovery_image_digest" {
  description = "Exact dedicated recovery-runner image digest provisioned into the fixed staging task definition."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.recovery_image_digest))
    error_message = "Recovery image must be selected by a sha256 digest."
  }
}

variable "adot_image" {
  description = "Pinned AWS Distro for OpenTelemetry Collector image in public.ecr.aws/aws-observability/aws-otel-collector@sha256: form."
  type        = string
}

variable "bootstrap_complete" {
  description = "Set true only after the one-off bootstrap and exact-digest migration tasks have succeeded."
  type        = bool
  default     = false
}
