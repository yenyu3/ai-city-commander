# Development environment (Ohio)
aws_region   = "us-east-2"
project_name = "ai-city-commander-dev"

db_name           = "aicity"
db_instance_class = "db.t4g.micro"

# Bedrock is optional. Replace null after the Runtime/model is available.
bedrock_agentcore_runtime_arn = null # e.g. arn:aws:bedrock-agentcore:us-east-2:123456789012:runtime/...
bedrock_model_id              = null # e.g. <bedrock-foundation-model-id>

# These names must be globally unique across all AWS accounts.
internal_results_bucket_name = "ai-city-commander-internal-results"
public_results_bucket_name   = "ai-city-commander-public-results"

# Restrict this to the CloudFront/custom-domain origin before production.
cors_allowed_origins = ["*"]

tags = {
  Environment = "dev"
}
