output "repository_urls" {
  value = { for key, repository in aws_ecr_repository.shared : key => repository.repository_url }
}

output "github_roles" {
  value = {
    image_builder                  = aws_iam_role.image_builder.arn
    release_verifier               = aws_iam_role.release_verifier.arn
    staging_deployer               = aws_iam_role.staging_deployer.arn
    production_deployer            = aws_iam_role.production_deployer.arn
    staging_bootstrap_operator     = aws_iam_role.staging_bootstrap_operator.arn
    production_bootstrap_operator  = aws_iam_role.production_bootstrap_operator.arn
    staging_restore_drill_operator = aws_iam_role.staging_restore_drill_operator.arn
    staging_acceptance_operator    = aws_iam_role.staging_acceptance_operator.arn
    staging_plan                   = aws_iam_role.staging_plan.arn
  }
}
