#!/usr/bin/env bash
# Push Supabase edge function secrets from a local .env file.
#
# Usage:
#   ./supabase/scripts/set-secrets.sh test
#   ./supabase/scripts/set-secrets.sh production

set -euo pipefail

ENV_NAME="${1:-}"
if [[ -z "$ENV_NAME" || ( "$ENV_NAME" != "test" && "$ENV_NAME" != "production" ) ]]; then
  echo "Usage: $0 <test|production>" >&2
  exit 1
fi

ENV_UPPER=$(echo "$ENV_NAME" | tr '[:lower:]' '[:upper:]')
SHORT_SUFFIX=$([ "$ENV_UPPER" = "PRODUCTION" ] && echo "PROD" || echo "$ENV_UPPER")
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
ENV_FILE="$REPO_ROOT/supabase/.env.$ENV_NAME"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy the template next to it and fill in your values first." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

PROJECT_ID=""
for name in "SUPABASE_PROJECT_ID_$ENV_UPPER" "SUPABASE_PROJECT_ID_$SHORT_SUFFIX"; do
  candidate="${!name:-}"
  if [[ -n "$candidate" ]]; then
    PROJECT_ID="$candidate"
    break
  fi
done
if [[ -z "$PROJECT_ID" ]]; then
  echo "Missing SUPABASE_PROJECT_ID_$ENV_UPPER (or SUPABASE_PROJECT_ID_$SHORT_SUFFIX) in $ENV_FILE" >&2
  exit 1
fi

SECRETS_ARGS=()
while IFS= read -r line; do
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  if [[ "$line" != *"="* ]]; then continue; fi
  name="${line%%=*}"
  value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  [[ -z "$value" ]] && continue
  [[ "$name" == EXPO_PUBLIC_* ]] && continue
  [[ "$name" == SUPABASE_DB_URL_* ]] && continue
  [[ "$name" == SUPABASE_PROJECT_ID_* ]] && continue
  SECRETS_ARGS+=("$name=$value")
done < "$ENV_FILE"

if [[ ${#SECRETS_ARGS[@]} -eq 0 ]]; then
  echo "No secrets found in $ENV_FILE" >&2
  exit 1
fi

# Tag the deployment so functions know which env they're in.
SECRETS_ARGS+=("APP_ENV=$ENV_NAME")

echo "About to push ${#SECRETS_ARGS[@]} secret(s) to $ENV_NAME ($PROJECT_ID):"
for arg in "${SECRETS_ARGS[@]}"; do
  echo "  - ${arg%%=*}"
done

cd "$REPO_ROOT"
supabase secrets set --project-ref "$PROJECT_ID" "${SECRETS_ARGS[@]}"

echo ""
echo "Secrets deployed. Functions now see APP_ENV=$ENV_NAME."
