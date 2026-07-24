terraform {
  required_version = ">= 1.11.6, < 1.12.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.55.0"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = "ap-southeast-1"

  default_tags {
    tags = {
      Application = "aeostudio"
      Environment = "production"
      ManagedBy   = "opentofu"
      DataClass   = "tenant-data"
    }
  }
}
