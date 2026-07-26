"""Temporary API response used to verify API Gateway → Lambda connectivity."""

import json


def handler(_event, _context):
    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json; charset=utf-8"},
        "body": json.dumps({"message": "AI City Commander API is running"}),
    }
