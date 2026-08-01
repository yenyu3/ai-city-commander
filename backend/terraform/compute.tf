locals {
  # Lambda accepts a single linux/amd64 image manifest. Buildx provenance/SBOM
  # attestations can make ECR publish an OCI index that Lambda rejects.
  image_build_revision = "buildx-linux-amd64-no-attestations-v1"

  api_handlers = {
    city_state  = "handler.handler"
    incident    = "handler.handler"
    report      = "handler.handler"
    decision    = "handler.handler"
    chat        = "handler.handler"
    publication = "handler.handler"
  }

  scheduled_handlers = {
    "decision-generator-worker" = "handler.handler"
  }

  lambda_handlers = merge(local.api_handlers, local.scheduled_handlers)

  api_images = {
    for name, handler in local.lambda_handlers : name => {
      tag = "sha-${substr(sha256(join("", [
        local.image_build_revision,
        filesha256("${path.module}/../service/${name}/Dockerfile"),
        filesha256("${path.module}/../service/${name}/handler.py"),
      ])), 0, 16)}"
    }
  }
}

resource "aws_lambda_function" "api" {
  for_each      = local.lambda_handlers
  function_name = "${local.name}-${replace(each.key, "_", "-")}"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.api[each.key].repository_url}:${local.api_images[each.key].tag}"
  architectures = ["x86_64"]
  timeout       = 30
  memory_size   = 512

  environment {
    variables = {
      DATABASE_SECRET_ARN           = aws_secretsmanager_secret.database.arn
      BEDROCK_AGENTCORE_RUNTIME_ARN = var.bedrock_agentcore_runtime_arn == null ? "" : var.bedrock_agentcore_runtime_arn
      BEDROCK_MODEL_ID              = var.bedrock_model_id == null ? "" : var.bedrock_model_id
      INTERNAL_RESULTS_BUCKET       = aws_s3_bucket.internal_results.bucket
      PUBLIC_RESULTS_BUCKET         = aws_s3_bucket.public_results.bucket
      EMERGENCY_TOPIC_ARN           = aws_sns_topic.emergency.arn
    }
  }

  vpc_config {
    subnet_ids         = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  depends_on = [terraform_data.api_image]
}

# Each Lambda has an immutable, independently built container image.
resource "aws_ecr_repository" "api" {
  for_each             = local.lambda_handlers
  name                 = "${local.name}-${replace(each.key, "_", "-")}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  for_each   = local.lambda_handlers
  repository = aws_ecr_repository.api[each.key].name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 10 newest Lambda images"
      selection = {
        tagStatus     = "tagged"
        tagPrefixList = ["sha-"]
        countType     = "imageCountMoreThan"
        countNumber   = 10
      }
      action = { type = "expire" }
    }]
  })
}

# Terraform builds and pushes the image before Lambda is updated to its URI.
resource "terraform_data" "api_image" {
  for_each = local.api_images

  triggers_replace = {
    repository_url = aws_ecr_repository.api[each.key].repository_url
    image_tag      = each.value.tag
    build_revision = local.image_build_revision
  }

  provisioner "local-exec" {
    interpreter = ["/bin/sh", "-c"]
    command     = <<-EOT
      set -eu
      aws ecr get-login-password --region ${var.aws_region} | docker login --username AWS --password-stdin ${split("/", aws_ecr_repository.api[each.key].repository_url)[0]}
      docker buildx build --platform linux/amd64 --provenance=false --sbom=false --push --tag ${aws_ecr_repository.api[each.key].repository_url}:${each.value.tag} ${path.module}/../service/${each.key}
    EOT
  }
}

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
        }, {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
        ]
        Resource = [
          "${aws_s3_bucket.internal_results.arn}/*",
          "${aws_s3_bucket.public_results.arn}/*",
        ]
        }, {
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = aws_sns_topic.emergency.arn
      }],
      var.bedrock_model_id == null ? [] : [{
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.bedrock_model_id}"
      }],
      var.bedrock_agentcore_runtime_arn == null ? [] : [{
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime"]
        Resource = var.bedrock_agentcore_runtime_arn
      }]
    )
  })
}
