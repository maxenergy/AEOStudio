resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.common_tags, { Name = "${local.name}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.common_tags, { Name = "${local.name}-igw" })
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = local.public_cidrs[count.index]
  map_public_ip_on_launch = false

  tags = merge(local.common_tags, { Name = "${local.name}-public-${count.index + 1}", Tier = "public-alb" })
}

resource "aws_subnet" "private" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = local.private_cidrs[count.index]
  map_public_ip_on_launch = false

  tags = merge(local.common_tags, { Name = "${local.name}-private-${count.index + 1}", Tier = "private-data-plane" })
}

resource "aws_eip" "nat" {
  count  = 2
  domain = "vpc"

  tags = merge(local.common_tags, { Name = "${local.name}-nat-${count.index + 1}" })
}

resource "aws_nat_gateway" "main" {
  count = 2

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  depends_on = [aws_internet_gateway.main]
  tags       = merge(local.common_tags, { Name = "${local.name}-nat-${count.index + 1}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(local.common_tags, { Name = "${local.name}-public" })
}

resource "aws_route_table_association" "public" {
  count = 2

  route_table_id = aws_route_table.public.id
  subnet_id      = aws_subnet.public[count.index].id
}

resource "aws_route_table" "private" {
  count = 2

  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = merge(local.common_tags, { Name = "${local.name}-private-${count.index + 1}" })
}

resource "aws_route_table_association" "private" {
  count = 2

  route_table_id = aws_route_table.private[count.index].id
  subnet_id      = aws_subnet.private[count.index].id
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public TLS ingress to the application load balancer"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Targets"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  tags = local.common_tags
}

resource "aws_security_group" "web" {
  name        = "${local.name}-web"
  description = "Private Web tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "ALB to Web"
    from_port       = 3100
    to_port         = 3100
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  tags = local.common_tags
}

# Server-rendered Web requests reach the tenant public API origin over TLS only.
# trivy:ignore:AWS-0104:exp:2027-07-24
resource "aws_vpc_security_group_egress_rule" "web_to_https" {
  security_group_id = aws_security_group.web.id
  description       = "Web server-side requests through redundant NAT gateways"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "Private API tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "ALB to API"
    from_port       = 3200
    to_port         = 3200
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  tags = local.common_tags
}

# Tenant-selected OAuth and verification providers do not publish stable IP allowlists.
# trivy:ignore:AWS-0104:exp:2027-07-24
resource "aws_vpc_security_group_egress_rule" "api_to_https" {
  security_group_id = aws_security_group.api.id
  description       = "API HTTPS provider and AWS requests through redundant NAT gateways"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "api_to_database" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.database.id
  description                  = "API to PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_security_group" "worker" {
  name        = "${local.name}-worker"
  description = "Private Worker tasks without ingress"
  vpc_id      = aws_vpc.main.id

  tags = local.common_tags
}

# Approved crawl and publication targets have tenant-selected, dynamic Internet addresses.
# trivy:ignore:AWS-0104:exp:2027-07-24
resource "aws_vpc_security_group_egress_rule" "worker_to_https" {
  security_group_id = aws_security_group.worker.id
  description       = "Worker HTTPS crawl, provider and AWS requests through redundant NAT gateways"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# HTTP is needed only to observe and validate redirects from approved tenant crawl targets.
# trivy:ignore:AWS-0104:exp:2027-07-24
resource "aws_vpc_security_group_egress_rule" "worker_to_http" {
  security_group_id = aws_security_group.worker.id
  description       = "Worker HTTP crawl requests through redundant NAT gateways"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "worker_to_database" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.database.id
  description                  = "Worker to PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_security_group" "migration" {
  name        = "${local.name}-migration"
  description = "One-shot private database migration tasks"
  vpc_id      = aws_vpc.main.id

  tags = local.common_tags
}

data "aws_prefix_list" "s3" {
  name = "com.amazonaws.${var.region}.s3"
}

resource "aws_security_group" "internal_alb" {
  name        = "${local.name}-internal-alb"
  description = "Private TLS ingress from API and Worker to the Tenant Data Broker"
  vpc_id      = aws_vpc.main.id

  tags = local.common_tags
}

resource "aws_vpc_security_group_ingress_rule" "internal_alb_https_from_api" {
  security_group_id            = aws_security_group.internal_alb.id
  referenced_security_group_id = aws_security_group.api.id
  description                  = "API to private Tenant Data Broker TLS endpoint"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_ingress_rule" "internal_alb_https_from_worker" {
  security_group_id            = aws_security_group.internal_alb.id
  referenced_security_group_id = aws_security_group.worker.id
  description                  = "Worker to private Tenant Data Broker TLS endpoint"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_security_group" "tenant_data_broker" {
  name        = "${local.name}-tenant-data-broker"
  description = "Tenant Data Broker with no Internet or provider egress"
  vpc_id      = aws_vpc.main.id

  tags = local.common_tags
}

resource "aws_vpc_security_group_ingress_rule" "tenant_data_broker_from_internal_alb" {
  security_group_id            = aws_security_group.tenant_data_broker.id
  referenced_security_group_id = aws_security_group.internal_alb.id
  description                  = "Internal ALB to Tenant Data Broker"
  ip_protocol                  = "tcp"
  from_port                    = 3300
  to_port                      = 3300
}

resource "aws_vpc_security_group_egress_rule" "internal_alb_to_tenant_data_broker" {
  security_group_id            = aws_security_group.internal_alb.id
  referenced_security_group_id = aws_security_group.tenant_data_broker.id
  description                  = "Private ALB to exact Tenant Data Broker target"
  ip_protocol                  = "tcp"
  from_port                    = 3300
  to_port                      = 3300
}

resource "aws_vpc_security_group_egress_rule" "tenant_data_broker_to_database" {
  security_group_id            = aws_security_group.tenant_data_broker.id
  referenced_security_group_id = aws_security_group.database.id
  description                  = "Tenant Data Broker to PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "tenant_data_broker_to_s3" {
  security_group_id = aws_security_group.tenant_data_broker.id
  prefix_list_id    = data.aws_prefix_list.s3.id
  description       = "Tenant Data Broker to the regional S3 gateway"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_security_group" "aws_endpoints" {
  name        = "${local.name}-aws-endpoints"
  description = "Private AWS API endpoints used by application tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "TLS from the exact private task security groups"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    security_groups = [
      aws_security_group.web.id,
      aws_security_group.api.id,
      aws_security_group.worker.id,
      aws_security_group.migration.id,
      aws_security_group.tenant_data_broker.id,
    ]
  }

  tags = local.common_tags
}

resource "aws_vpc_security_group_egress_rule" "tenant_data_broker_to_endpoints" {
  security_group_id            = aws_security_group.tenant_data_broker.id
  referenced_security_group_id = aws_security_group.aws_endpoints.id
  description                  = "Tenant Data Broker to exact private AWS API endpoints"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "migration_to_database" {
  security_group_id            = aws_security_group.migration.id
  referenced_security_group_id = aws_security_group.database.id
  description                  = "One-shot migration task to PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "migration_to_s3" {
  security_group_id = aws_security_group.migration.id
  prefix_list_id    = data.aws_prefix_list.s3.id
  description       = "One-shot migration task to the regional S3 gateway for ECR layers"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "migration_to_endpoints" {
  security_group_id            = aws_security_group.migration.id
  referenced_security_group_id = aws_security_group.aws_endpoints.id
  description                  = "One-shot migration task to exact private AWS API endpoints"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset([
    "ecr.api",
    "ecr.dkr",
    "logs",
    "secretsmanager",
    "kms",
    "xray",
    "monitoring",
  ])

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.aws_endpoints.id]

  tags = merge(local.common_tags, { Name = "${local.name}-${replace(each.value, ".", "-")}" })
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = merge(local.common_tags, { Name = "${local.name}-s3" })
}
