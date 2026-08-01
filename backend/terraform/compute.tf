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

  # 2026-08-01: every per-service Dockerfile now COPYs these shared modules
  # (db.py/s3_cache.py/decision_routing.py/agent//rules/) alongside its own
  # handler.py -- the image tag must change when any of them change too, or
  # a shared-code fix would silently ship a stale image.
  shared_service_files = concat(
    [
      "${path.module}/../service/db.py",
      "${path.module}/../service/s3_cache.py",
      "${path.module}/../service/decision_routing.py",
      "${path.module}/../service/api_common.py",
      "${path.module}/../service/s3_common.py",
      "${path.module}/../service/worker_invoke.py",
      "${path.module}/../service/report_builder.py",
    ],
    [for f in fileset("${path.module}/../service/agent", "*.py") : "${path.module}/../service/agent/${f}"],
    [for f in fileset("${path.module}/../service/rules", "*.py") : "${path.module}/../service/rules/${f}"],
  )

  api_images = {
    for name, handler in local.lambda_handlers : name => {
      tag = "sha-${substr(sha256(join("", concat(
        [
          local.image_build_revision,
          filesha256("${path.module}/../service/${name}/Dockerfile"),
          filesha256("${path.module}/../service/${name}/handler.py"),
        ],
        [for f in local.shared_service_files : filesha256(f)]
      ))), 0, 16)}"
    }
  }
}

locals {
  # Computed the same way as aws_lambda_function.api's own function_name
  # argument, on purpose: referencing aws_lambda_function.api["decision-
  # generator-worker"].function_name from inside every Lambda's own
  # environment block (including that Lambda's own) would be a
  # self-reference cycle for that one instance. This is just a plain string
  # built from local.name, so it breaks the cycle without needing to know
  # anything about the resource itself.
  decision_generator_worker_function_name = "${local.name}-decision-generator-worker"
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
      # data/api.md §4's cache-aside flow: incident/ and decision/ invoke the
      # worker asynchronously on a cache miss/new incident -- see
      # worker_invoke.py. Every Lambda gets this env var (harmless for the
      # ones that never call invoke_async).
      DECISION_GENERATOR_WORKER_FUNCTION_NAME = local.decision_generator_worker_function_name
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
      # Context is backend/service/ (the parent), not backend/service/${each.key}/ --
      # each Dockerfile COPYs shared modules (db.py, s3_cache.py, agent/, rules/)
      # that live outside its own subdirectory, so the build needs to see them.
      docker buildx build --platform linux/amd64 --provenance=false --sbom=false --push \
        --tag ${aws_ecr_repository.api[each.key].repository_url}:${each.value.tag} \
        -f ${path.module}/../service/${each.key}/Dockerfile \
        ${path.module}/../service
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
        # S3 intentionally returns AccessDenied instead of NoSuchKey for a
        # missing private object unless ListBucket is also allowed. decision/
        # needs the real miss result to queue its 15-minute-slot worker.
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.internal_results.arn
        }, {
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = aws_sns_topic.emergency.arn
        }, {
        # decision/handler.py invokes decision-generator-worker asynchronously
        # on a cache miss (data/api.md §4's cache-aside flow) -- every
        # function in this account shares this one role, so it can invoke
        # itself as the worker.
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.api["decision-generator-worker"].arn
      }],
      var.bedrock_model_id == null ? [] : [{
        Effect = "Allow"
        Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        # "*" and not a specific model/inference-profile ARN on purpose: bare
        # foundation-model IDs and cross-region inference profile IDs (e.g.
        # the "us." prefix this project actually uses) have different ARN
        # shapes, and locking to one breaks the moment bedrock_model_id
        # changes. The action list itself is the real restriction here.
        Resource = "*"
      }],
      var.bedrock_agentcore_runtime_arn == null ? [] : [{
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime"]
        Resource = var.bedrock_agentcore_runtime_arn
      }]
    )
  })
}
