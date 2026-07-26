#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd -- "$TERRAFORM_DIR/../.." && pwd)"
PACKAGE_DIR="$TERRAFORM_DIR/.build/db_seed_package"

rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR"

# Install Linux/x86_64 dependencies even when the build runs on macOS.
python3 -m pip install --upgrade \
  --target "$PACKAGE_DIR" \
  --platform manylinux2014_x86_64 \
  --implementation cp \
  --python-version 3.12 \
  --only-binary=:all: \
  -r "$SCRIPT_DIR/requirements.txt"

mkdir -p "$PACKAGE_DIR/backend/terraform/scripts" \
  "$PACKAGE_DIR/backend/terraform/database" \
  "$PACKAGE_DIR/frontend/public/data"

cp "$SCRIPT_DIR/seed_handler.py" "$PACKAGE_DIR/"
cp "$SCRIPT_DIR/load_demo_data.py" "$PACKAGE_DIR/backend/terraform/scripts/"
cp "$TERRAFORM_DIR/database/schema.sql" "$PACKAGE_DIR/backend/terraform/database/"
cp "$REPO_ROOT/frontend/public/data/"{city_traffic_flow.csv,signaling_crowd_density.csv,road_network_geometry.json,road_paths.json,station_coords.json,live_incidents.json,emergency_traffic_sop.txt} "$PACKAGE_DIR/frontend/public/data/"

echo "Created Lambda package source at $PACKAGE_DIR"
