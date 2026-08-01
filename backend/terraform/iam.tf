resource "aws_iam_role" "lambda" {
  name = "${local.name}-api-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "lambda" {
  name = "${local.name}-api-access"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.database.arn
      }],
      var.bedrock_agentcore_runtime_arn == null ? [] : [{
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime"]
        Resource = var.bedrock_agentcore_runtime_arn
      }],
      # Auth for BedrockLLMClient is the Lambda's own execution role -- no
      # key/secret to manage or leak, AWS injects+rotates these credentials
      # automatically. Resource is left as "*" (hackathon time constraint,
      # not a real security boundary since the action list itself is
      # already narrow): the exact ARN shape differs between bare
      # foundation-model IDs and cross-region inference profile IDs, and
      # locking to one would break if the model ID changes.
      var.bedrock_model_id == null ? [] : [{
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "*"
      }]
    )
  })
}
