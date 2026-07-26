output "frontend_bucket_name" {
  value       = aws_s3_bucket.frontend.bucket
  description = "Upload frontend build files to this private bucket."
}

output "frontend_url" {
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
  description = "Public CloudFront URL."
}

output "api_gateway_url" {
  value       = aws_apigatewayv2_api.http.api_endpoint
  description = "Direct API Gateway URL; frontend traffic should use /api/* through CloudFront."
}

output "database_secret_arn" {
  value       = aws_secretsmanager_secret.database.arn
  description = "Secrets Manager ARN holding the private RDS connection details."
}

output "database_endpoint" {
  value       = aws_db_instance.postgres.address
  description = "Private RDS endpoint; it is reachable only from the Lambda security group."
}

output "database_seed_lambda_name" {
  value       = aws_lambda_function.database_seed.function_name
  description = "Private Lambda Terraform invokes to apply the schema and load demo data."
}
