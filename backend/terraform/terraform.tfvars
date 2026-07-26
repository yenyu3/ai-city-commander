# Development environment (Ohio)
aws_region   = "us-east-2"
project_name = "ai-city-commander-dev"

db_name           = "aicity"
db_instance_class = "db.t4g.micro"

# Set after an AgentCore Runtime has been deployed.
# bedrock_agentcore_runtime_arn = "arn:aws:bedrock-agentcore:us-east-2:123456789012:runtime/..."

# Restrict this to the CloudFront/custom-domain origin before production.
cors_allowed_origins = ["*"]

tags = {
  Environment = "dev"
}
