variable "github_repository" {
  description = "Exact owner/repository permitted to build and deploy AEOStudio."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be one exact owner/repository without a wildcard."
  }
}

variable "staging_plan_state_bucket_arn" {
  description = "Exact S3 bucket ARN containing the reviewed staging OpenTofu state."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.staging_plan_state_bucket_arn))
    error_message = "staging_plan_state_bucket_arn must be one exact S3 bucket ARN without a wildcard."
  }
}

variable "staging_plan_state_key" {
  description = "Fixed staging OpenTofu state object key readable by the plan role."
  type        = string
  default     = "aeostudio/staging/opentofu.tfstate"

  validation {
    condition     = var.staging_plan_state_key == "aeostudio/staging/opentofu.tfstate"
    error_message = "The staging plan role may read only the fixed AEOStudio staging state key."
  }
}
