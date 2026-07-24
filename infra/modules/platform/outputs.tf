output "public_endpoint" {
  value = local.public_origin
}

output "deployment" {
  value = {
    cluster_arn                  = aws_ecs_cluster.main.arn
    web_service                  = aws_ecs_service.web.name
    api_service                  = aws_ecs_service.api.name
    worker_service               = aws_ecs_service.worker.name
    bootstrap_task               = aws_ecs_task_definition.bootstrap.arn
    bootstrap_container          = "bootstrap"
    migration_task               = aws_ecs_task_definition.migration.arn
    migration_container          = "migration"
    migration_security_group     = aws_security_group.migration.id
    private_subnets              = aws_subnet.private[*].id
    deploy_role_arn              = data.aws_iam_role.deploy.arn
    bootstrap_operator_role_arn  = data.aws_iam_role.bootstrap_operator.arn
    release_broker_arn           = aws_sfn_state_machine.release.arn
    release_watchdog_arn         = aws_sfn_state_machine.release_watchdog.arn
    bootstrap_broker_arn         = aws_sfn_state_machine.bootstrap.arn
    release_contract_parameter   = aws_ssm_parameter.release_contract.name
    bootstrap_contract_parameter = aws_ssm_parameter.bootstrap_contract.name
    restore_drill = var.environment == "staging" ? {
      broker_arn           = aws_sfn_state_machine.restore_drill[0].arn
      task_definition_arn  = aws_ecs_task_definition.restore_drill[0].arn
      input_parameter_name = aws_ssm_parameter.restore_drill_input[0].name
      evidence_bucket      = aws_s3_bucket.audit_evidence.id
      restore_bucket       = aws_s3_bucket.restore_drill[0].id
    } : null
  }
}
