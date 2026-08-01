# Development environment (Oregon)
aws_region   = "us-west-2"
project_name = "ai-city-commander-dev"

db_name                        = "aicity"
aurora_postgres_engine_version = "16.11"
aurora_serverless_min_acu      = 0.5
aurora_serverless_max_acu      = 1
availability_zones = [
  "us-west-2a",
  "us-west-2b",
]

# Bedrock is optional. Replace null after the Runtime/model is available.
bedrock_agentcore_runtime_arn = null # e.g. arn:aws:bedrock-agentcore:us-east-2:123456789012:runtime/...
bedrock_model_id              = null # e.g. <bedrock-foundation-model-id>

# These names must be globally unique across all AWS accounts.
internal_results_bucket_name = "ai-city-commander-internal-results"
public_results_bucket_name   = "ai-city-commander-public-results"
frontend_bucket_name         = "frontend-hack"

# Restrict this to the CloudFront/custom-domain origin before production.
cors_allowed_origins = ["*"]

tags = {
  Environment = "dev"
}
