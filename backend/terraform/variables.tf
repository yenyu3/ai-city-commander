variable "aws_region" {
  description = "AWS Region for all resources. Confirm Bedrock AgentCore availability in this region."
  type        = string
  default     = "ap-northeast-1"
}

variable "project_name" {
  description = "Lowercase project prefix used for resource names."
  type        = string
  default     = "ai-city-commander"
}

variable "db_name" {
  description = "Initial PostgreSQL database name."
  type        = string
  default     = "aicity"
}

variable "db_instance_class" {
  description = "RDS instance class. Use a larger class before production."
  type        = string
  default     = "db.t4g.micro"
}

variable "bedrock_agentcore_runtime_arn" {
  description = "Existing AgentCore Runtime ARN. Leave null until the agent container/runtime is deployed."
  type        = string
  default     = null
  nullable    = true
}

variable "bedrock_model_id" {
  description = <<-EOT
    Bedrock model ID (or cross-region inference profile ID, e.g.
    "us.anthropic.claude-sonnet-4-6") for direct Bedrock invocation via the
    Lambda's IAM role -- see agent/llm_client.py::BedrockLLMClient and
    s3_cache.py (the decision cache also reads/writes this same account's
    S3 buckets). Leave null to disable (falls through to whatever else is
    configured, or the deterministic rules/ fallback). Requires the AWS
    account to have completed the one-time Anthropic model use-case form in
    the Bedrock console before first use.
  EOT
  type        = string
  default     = null
  nullable    = true
}

variable "internal_results_bucket_name" {
  description = "Globally unique private S3 bucket name for incidents, decisions, and government reports."
  type        = string
  default     = "ai-city-commander-internal-results"
}

variable "public_results_bucket_name" {
  description = "Globally unique private S3 bucket name served to the public through CloudFront."
  type        = string
  default     = "ai-city-commander-public-results"
}

variable "cors_allowed_origins" {
  description = "Browser origins permitted to call the API. Replace * with your CloudFront/custom domain in production."
  type        = list(string)
  default     = ["*"]
}

variable "tags" {
  description = "Extra AWS tags."
  type        = map(string)
  default     = {}
}
