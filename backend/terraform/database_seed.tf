# Build this package before running Terraform:
#   ./scripts/build_seed_lambda.sh
# The script installs Lambda-compatible psycopg binaries and copies the schema
# and demo files into .build/db_seed_package.
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

# Terraform invokes this only when the deployment package or the RDS instance
# changes. The loader itself is idempotent, using schema checks and upserts.
resource "aws_lambda_invocation" "database_seed" {
  function_name = aws_lambda_function.database_seed.function_name
  input         = jsonencode({ action = "seed" })

  triggers = {
    package_hash = data.archive_file.database_seed.output_base64sha256
    database_id  = aws_db_instance.postgres.id
  }

  depends_on = [
    aws_secretsmanager_secret_version.database,
    aws_iam_role_policy_attachment.database_seed_vpc,
  ]
}
