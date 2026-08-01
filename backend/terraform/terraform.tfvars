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

# Bedrock is optional. AgentCore stays null -- BedrockAgentCoreLLMClient is
# an unimplemented placeholder (see agent/llm_client.py); setting this would
# make every LLM call raise and silently fall through to rules/. Direct
# Bedrock via IAM role (BEDROCK_MODEL_ID) is the real path -- this ID/region
# combo was already verified working locally (AWS_REGION=us-west-2).
bedrock_agentcore_runtime_arn = null # e.g. arn:aws:bedrock-agentcore:us-east-2:123456789012:runtime/...
bedrock_model_id              = "us.anthropic.claude-sonnet-4-6"

# These names must be globally unique across all AWS accounts.
internal_results_bucket_name = "ai-city-commander-internal-results"
public_results_bucket_name   = "ai-city-commander-public-results"
frontend_bucket_name         = "frontend-hack"

# Restrict this to the CloudFront/custom-domain origin before production.
cors_allowed_origins = ["*"]

tags = {
  Environment = "dev"
}
