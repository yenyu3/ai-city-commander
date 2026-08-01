resource "random_password" "rds" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = "${local.name}-db"
  subnet_ids = [for subnet in aws_subnet.private : subnet.id]
}

# Aurora Serverless v2 is required for the RDS Console Query Editor/Data API
# workflow. Keep it private: the Data API and the seed Lambda access it without
# exposing PostgreSQL to the public internet.
resource "aws_rds_cluster" "aurora_postgres" {
  cluster_identifier = "${local.name}-aurora-postgres"
  engine             = "aurora-postgresql"
  engine_version     = var.aurora_postgres_engine_version
  engine_mode        = "provisioned"

  database_name   = var.db_name
  master_username = "aicity_admin"
  master_password = random_password.rds.result
  port            = 5432

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  storage_encrypted      = true
  enable_http_endpoint   = true

  backup_retention_period = 7
  copy_tags_to_snapshot   = true
  deletion_protection     = false
  skip_final_snapshot     = true

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_serverless_min_acu
    max_capacity = var.aurora_serverless_max_acu
  }
}

resource "aws_rds_cluster_instance" "aurora_postgres" {
  identifier          = "${local.name}-aurora-postgres-1"
  cluster_identifier  = aws_rds_cluster.aurora_postgres.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.aurora_postgres.engine
  engine_version      = aws_rds_cluster.aurora_postgres.engine_version
  publicly_accessible = false
}

resource "aws_secretsmanager_secret" "database" {
  name                    = "${local.name}/database"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "database" {
  secret_id = aws_secretsmanager_secret.database.id
  secret_string = jsonencode({
    host     = aws_rds_cluster.aurora_postgres.endpoint
    port     = aws_rds_cluster.aurora_postgres.port
    database = var.db_name
    username = aws_rds_cluster.aurora_postgres.master_username
    password = random_password.rds.result
  })
}

# Build this package before Terraform deployment with ./scripts/build_seed_lambda.sh.
data "archive_file" "database_seed" {
  type        = "zip"
  source_dir  = "${path.module}/.build/db_seed_package"
  output_path = "${path.module}/.build/database_seed.zip"
}

resource "aws_iam_role" "database_seed" {
  name = "${local.name}-database-seed-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "database_seed_vpc" {
  role       = aws_iam_role.database_seed.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "database_seed" {
  name = "${local.name}-database-seed-access"
  role = aws_iam_role.database_seed.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.database.arn
    }]
  })
}

resource "aws_lambda_function" "database_seed" {
  function_name    = "${local.name}-database-seed"
  role             = aws_iam_role.database_seed.arn
  handler          = "seed_handler.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.database_seed.output_path
  source_code_hash = data.archive_file.database_seed.output_base64sha256
  timeout          = 900
  memory_size      = 1024

  environment {
    variables = {
      DATABASE_SECRET_ARN = aws_secretsmanager_secret.database.arn
    }
  }

  vpc_config {
    subnet_ids         = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.database_seed.id]
  }
}

# This runs only for a newly built seed package or a newly created Aurora cluster.
resource "aws_lambda_invocation" "database_seed" {
  function_name = aws_lambda_function.database_seed.function_name
  input         = jsonencode({ action = "seed" })

  triggers = {
    package_hash = data.archive_file.database_seed.output_base64sha256
    database_id  = aws_rds_cluster.aurora_postgres.id
  }

  depends_on = [
    aws_secretsmanager_secret_version.database,
    aws_rds_cluster_instance.aurora_postgres,
    aws_iam_role_policy_attachment.database_seed_vpc,
  ]
}
