"""One-time Lambda entry point that applies the schema and demo data."""

import importlib
import json
import os
import sys
from urllib.parse import quote

import boto3


def handler(_event, _context):
    secret_arn = os.environ["DATABASE_SECRET_ARN"]
    secret = json.loads(
        boto3.client("secretsmanager").get_secret_value(SecretId=secret_arn)["SecretString"]
    )
    database_url = (
        f"postgresql://{quote(secret['username'])}:{quote(secret['password'])}"
        f"@{secret['host']}:{secret['port']}/{secret['database']}"
    )

    # Reuse the local loader exactly as it is used for manual development runs.
    loader = importlib.import_module("backend.terraform.scripts.load_demo_data")
    previous_argv = sys.argv
    try:
        sys.argv = ["load_demo_data.py", "--database-url", database_url]
        loader.main()
    finally:
        sys.argv = previous_argv

    return {"statusCode": 200, "body": json.dumps({"status": "seeded"})}
