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
