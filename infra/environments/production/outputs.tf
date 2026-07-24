output "public_endpoint" {
  description = "Production endpoint, emitted only after an explicitly approved apply."
  value       = module.platform.public_endpoint
}

output "deployment" {
  description = "Non-secret identifiers for protected digest promotion."
  value       = module.platform.deployment
}
