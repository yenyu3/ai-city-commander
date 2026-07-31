resource "aws_cloudwatch_event_rule" "decision_generator" {
  name                = "${local.name}-decision-generator"
  description         = "Generate cached AI decisions from current RDS snapshots every five minutes"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "decision_generator" {
  rule      = aws_cloudwatch_event_rule.decision_generator.name
  target_id = "decision-generator-worker"
  arn       = aws_lambda_function.api["decision-generator-worker"].arn

  input = jsonencode({
    source = "eventbridge"
    mode   = "scheduled"
  })
}

resource "aws_sns_topic" "emergency" {
  name = "${local.name}-emergency"
}
