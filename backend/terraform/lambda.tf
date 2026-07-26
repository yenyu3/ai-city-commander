data "archive_file" "api_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../service"
  output_path = "${path.module}/.build/api_lambda.zip"
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.name}-api"
  role             = aws_iam_role.lambda.arn
  handler          = "handler.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.api_lambda.output_path
  source_code_hash = data.archive_file.api_lambda.output_base64sha256
  timeout          = 30
  memory_size      = 512

  environment {
    variables = {
      DATABASE_SECRET_ARN           = aws_secretsmanager_secret.database.arn
      BEDROCK_AGENTCORE_RUNTIME_ARN = coalesce(var.bedrock_agentcore_runtime_arn, "")
    }
  }

  vpc_config {
    subnet_ids         = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.lambda.id]
  }
}
