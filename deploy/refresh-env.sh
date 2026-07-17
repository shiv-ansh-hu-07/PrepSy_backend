#!/usr/bin/env bash
# Regenerates secrets.env from SSM Parameter Store (/prepsy/*).
# Run this once during setup, and again any time you change a secret in SSM.
#
#   ./refresh-env.sh
#
# Requires: awscli on the box, and the EC2 instance role must allow
# ssm:GetParametersByPath on /prepsy/*.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/secrets.env"

echo "# Generated from SSM Parameter Store on $(date -u)" > "$OUT"

aws ssm get-parameters-by-path \
  --path "/prepsy/" \
  --with-decryption \
  --region "$REGION" \
  --query "Parameters[].[Name,Value]" \
  --output text \
| while IFS=$'\t' read -r name value; do
    key="${name##*/}"
    printf '%s=%s\n' "$key" "$value" >> "$OUT"
  done

# Non-secret runtime values the app also expects
{
  echo "PORT=5000"
  echo "AWS_REGION=${REGION}"
} >> "$OUT"

chmod 600 "$OUT"
echo "Wrote $OUT ($(grep -c '=' "$OUT") variables)"
