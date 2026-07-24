output "public_endpoint" {
  description = "Public ALB DNS name used by the synthetic smoke gate."
  value       = module.platform.public_endpoint
}

output "deployment" {
  description = "Non-secret identifiers consumed by the digest-only deployment workflow."
  value       = module.platform.deployment
}
