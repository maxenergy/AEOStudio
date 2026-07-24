module "platform" {
  source = "../../modules/platform"

  environment                           = "production"
  region                                = "ap-southeast-1"
  availability_zones                    = ["ap-southeast-1a", "ap-southeast-1b"]
  public_hostname                       = var.public_hostname
  route53_zone_id                       = var.route53_zone_id
  cognito_custom_domain_certificate_arn = var.cognito_custom_domain_certificate_arn
  operations_alert_email                = var.operations_alert_email
  deploy_role_name                      = "aeostudio-production-deployer"
  bootstrap_operator_role_name          = "aeostudio-production-bootstrap-operator"
  web_image_digest                      = var.web_image_digest
  api_image_digest                      = var.api_image_digest
  worker_image_digest                   = var.worker_image_digest
  adot_image                            = var.adot_image
  bootstrap_complete                    = var.bootstrap_complete
  enable_backup_vault_lock              = var.enable_backup_vault_lock
}
