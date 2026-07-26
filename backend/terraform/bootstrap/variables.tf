variable "aws_region" {
  description = "Region in which to create the Terraform state bucket."
  type        = string
  default     = "us-east-2"
}

variable "project_name" {
  description = "Prefix for the globally unique Terraform state bucket."
  type        = string
  default     = "ai-city-commander-dev"
}

variable "environment" {
  description = "Environment tag for the backend bucket."
  type        = string
  default     = "dev"
}
