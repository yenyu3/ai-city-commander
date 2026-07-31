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
  description = "Optional Bedrock foundation model ID used by the decision-generator worker."
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
