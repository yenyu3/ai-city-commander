#!/usr/bin/env bash
# Build the Vite frontend and publish it to the Terraform-managed S3 origin.
# CloudFront remains the only public reader of the bucket.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$FRONTEND_DIR/.." && pwd)"
TERRAFORM_DIR="${TERRAFORM_DIR:-$REPO_DIR/backend/terraform}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 1
  }
}

require_command aws
require_command npm

terraform_output() {
  terraform -chdir="$TERRAFORM_DIR" output -raw "$1" 2>/dev/null
}

cloudfront_state_attribute() {
  local attribute="$1"
  terraform -chdir="$TERRAFORM_DIR" state show -no-color aws_cloudfront_distribution.frontend \
    | sed -nE "s/^[[:space:]]*${attribute}[[:space:]]*=[[:space:]]*\"([^\"]+)\".*/\\1/p" \
    | head -n 1
}

# Explicit variables are useful in CI; local deployment obtains the values
# from the same Terraform state that created the bucket and distribution.
if [[ -z "${FRONTEND_BUCKET_NAME:-}" || -z "${CLOUDFRONT_DISTRIBUTION_ID:-}" || -z "${FRONTEND_URL:-}" ]]; then
  require_command terraform
  if [[ ! -d "$TERRAFORM_DIR" ]]; then
    echo "Terraform directory does not exist: $TERRAFORM_DIR" >&2
    exit 1
  fi
fi

FRONTEND_URL="${FRONTEND_URL:-}"
FRONTEND_BUCKET_NAME="${FRONTEND_BUCKET_NAME:-}"
CLOUDFRONT_DISTRIBUTION_ID="${CLOUDFRONT_DISTRIBUTION_ID:-}"

if [[ -z "$FRONTEND_BUCKET_NAME" ]]; then
  FRONTEND_BUCKET_NAME="$(terraform_output frontend_bucket_name)"
fi

if [[ -z "$CLOUDFRONT_DISTRIBUTION_ID" ]]; then
  # Existing deployments may predate the Terraform output. The resource ID is
  # already in state, so use it as a backwards-compatible fallback.
  CLOUDFRONT_DISTRIBUTION_ID="$(terraform_output cloudfront_distribution_id || true)"
  if [[ -z "$CLOUDFRONT_DISTRIBUTION_ID" ]]; then
    CLOUDFRONT_DISTRIBUTION_ID="$(cloudfront_state_attribute id)"
  fi
fi

if [[ -z "$FRONTEND_BUCKET_NAME" || -z "$CLOUDFRONT_DISTRIBUTION_ID" ]]; then
  echo "Could not resolve frontend bucket or CloudFront distribution ID." >&2
  exit 1
fi

if [[ -z "$FRONTEND_URL" ]]; then
  FRONTEND_URL="$(terraform_output frontend_url || true)"
  if [[ -z "$FRONTEND_URL" ]]; then
    FRONTEND_URL="https://$(cloudfront_state_attribute domain_name)"
  fi
fi

echo "Building frontend..."
cd "$FRONTEND_DIR"
npm ci
npm run build

echo "Uploading assets to s3://$FRONTEND_BUCKET_NAME/..."
# Vite fingerprints JS/CSS assets. Keep them long-lived, while index.html is
# uploaded separately below so every navigation checks for the latest release.
aws s3 sync dist/ "s3://$FRONTEND_BUCKET_NAME/" \
  --delete \
  --exclude "index.html" \
  --cache-control "public, max-age=31536000, immutable"

aws s3 cp dist/index.html "s3://$FRONTEND_BUCKET_NAME/index.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "no-cache, no-store, must-revalidate"

echo "Invalidating CloudFront HTML entry points..."
INVALIDATION_ID="$(aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/" "/index.html" \
  --query 'Invalidation.Id' \
  --output text)"

echo "Deployment complete."
echo "  Bucket: s3://$FRONTEND_BUCKET_NAME/"
echo "  Invalidation: $INVALIDATION_ID"
echo "  URL: $FRONTEND_URL"
