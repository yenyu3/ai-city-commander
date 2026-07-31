resource "aws_apigatewayv2_api" "http" {
  name          = "${local.name}-http-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = var.cors_allowed_origins
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type", "authorization"]
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  for_each               = local.api_handlers
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api[each.key].invoke_arn
  payload_format_version = "2.0"
}

locals {
  api_routes = {
    city_state  = "GET /api/city-state"
    incident    = "POST /api/incidents"
    report      = "POST /api/government/emergency-reports"
    decision    = "POST /api/ai-decisions"
    chat        = "POST /api/chat"
    publication = "POST /api/publications"
  }
}

resource "aws_apigatewayv2_route" "api" {
  for_each  = local.api_routes
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.lambda[each.key].id}"
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  for_each      = local.api_handlers
  function_name = aws_lambda_function.api[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "eventbridge_decision_generator" {
  statement_id  = "AllowEventBridgeDecisionGenerator"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api["decision-generator-worker"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.decision_generator.arn
}

resource "aws_lambda_permission" "s3_internal_incidents" {
  statement_id  = "AllowInternalIncidentBucketInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api["decision-generator-worker"].function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.internal_results.arn
}
