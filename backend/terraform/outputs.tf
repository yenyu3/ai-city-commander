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
  value       = aws_rds_cluster.aurora_postgres.endpoint
  description = "Private Aurora writer endpoint; it is reachable only from Lambda security groups and the Data API."
}

output "database_reader_endpoint" {
  value       = aws_rds_cluster.aurora_postgres.reader_endpoint
  description = "Private Aurora reader endpoint."
}

output "aurora_cluster_arn" {
  value       = aws_rds_cluster.aurora_postgres.arn
  description = "Aurora cluster ARN for Data API and Query Editor access."
}

output "database_seed_lambda_name" {
  value       = aws_lambda_function.database_seed.function_name
  description = "Private Lambda Terraform invokes to apply the schema and load demo data."
}

output "internal_results_bucket_name" {
  value       = aws_s3_bucket.internal_results.bucket
  description = "Private bucket for incidents, decision snapshots, and emergency reports."
}

output "public_results_bucket_name" {
  value       = aws_s3_bucket.public_results.bucket
  description = "Private S3 origin for CloudFront-served public notices and manifests."
}

output "public_results_url" {
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}/public/"
  description = "CloudFront base URL for public result manifests and notices."
}

output "emergency_sns_topic_arn" {
  value       = aws_sns_topic.emergency.arn
  description = "SNS topic for emergency publication events."
}
