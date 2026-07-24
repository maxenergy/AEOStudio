resource "aws_acm_certificate" "public" {
  domain_name       = var.public_hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.common_tags
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.public.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  allow_overwrite = true
  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
}

resource "aws_acm_certificate_validation" "public" {
  certificate_arn         = aws_acm_certificate.public.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_acm_certificate" "tenant_data_broker" {
  domain_name       = local.tenant_data_broker_hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.common_tags, { Service = "tenant-data-broker" })
}

resource "aws_route53_record" "tenant_data_broker_certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.tenant_data_broker.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  allow_overwrite = true
  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
}

resource "aws_acm_certificate_validation" "tenant_data_broker" {
  certificate_arn = aws_acm_certificate.tenant_data_broker.arn
  validation_record_fqdns = [
    for record in aws_route53_record.tenant_data_broker_certificate_validation : record.fqdn
  ]
}

resource "aws_route53_zone" "tenant_data_broker_private" {
  name = local.tenant_data_broker_hostname

  vpc {
    vpc_id = aws_vpc.main.id
  }

  tags = merge(local.common_tags, { Service = "tenant-data-broker" })
}

resource "aws_route53_record" "tenant_data_broker_private" {
  zone_id = aws_route53_zone.tenant_data_broker_private.zone_id
  name    = local.tenant_data_broker_hostname
  type    = "A"

  alias {
    name                   = aws_lb.tenant_data_broker.dns_name
    zone_id                = aws_lb.tenant_data_broker.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "application" {
  zone_id = var.route53_zone_id
  name    = var.public_hostname
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "cognito_custom_domain" {
  zone_id = var.route53_zone_id
  name    = local.cognito_custom_domain
  type    = "A"

  alias {
    name                   = aws_cognito_user_pool_domain.custom_domain.cloudfront_distribution
    zone_id                = aws_cognito_user_pool_domain.custom_domain.cloudfront_distribution_zone_id
    evaluate_target_health = false
  }
}
