#!/usr/bin/env bash
# Deploy edge functions + migrations to a target Supabase environment.
#
# Usage:
#   ./supabase/scripts/deploy.sh test
#   ./supabase/scripts/deploy.sh production
#
# Optional flags (set before the env name):
#   SKIP_LINK=1        skip `supabase link`
#   SKIP_MIGRATIONS=1  skip `supabase db push`
#   SKIP_FUNCTIONS=1   skip `supabase functions deploy`
#   DRY_RUN=1          print what would happen without executing

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
  echo "Missing $ENV_FILE. Copy $ENV_FILE.template and fill in your values first." >&2
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
DB_URL=""
for name in "SUPABASE_DB_URL_$ENV_UPPER" "SUPABASE_DB_URL_$SHORT_SUFFIX"; do
  candidate="${!name:-}"
  if [[ -n "$candidate" ]]; then
    DB_URL="$candidate"
    break
  fi
done

if [[ -z "$PROJECT_ID" ]]; then
  echo "Missing SUPABASE_PROJECT_ID_$ENV_UPPER (or SUPABASE_PROJECT_ID_$SHORT_SUFFIX) in $ENV_FILE" >&2
  exit 1
fi

run_step() {
  local title="$1"; shift
  echo ""
  echo "==> $title"
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "    [dry-run] $*"
    return 0
  fi
  "$@"
}

cd "$REPO_ROOT"

if [[ "${SKIP_LINK:-0}" != "1" ]]; then
  run_step "Linking to $ENV_NAME project ($PROJECT_ID)" \
    supabase link --project-ref "$PROJECT_ID"
fi

if [[ "${SKIP_MIGRATIONS:-0}" != "1" ]]; then
  if [[ -n "$DB_URL" ]]; then
    run_step "Applying migrations to $ENV_NAME database" \
      supabase db push --db-url "$DB_URL" --include-all
  else
    echo ""
    echo "Skipping db push: SUPABASE_DB_URL_$ENV_UPPER (or _${SHORT_SUFFIX}) not set in $ENV_FILE"
  fi
fi

SUFFIX=""
if [[ "$ENV_UPPER" == "TEST" ]]; then
  SUFFIX="-test"
fi

if [[ "${SKIP_FUNCTIONS:-0}" != "1" ]]; then
  for fn in health paystack-subaccount send-notification super-agent-offers super-agent-tier-management super-agent-user-management verify-payment reorder-held-agent-order cancel-admin-order verify-wallet-topup afa-registration get-packages make-orders get-orders check-balance get-order-status; do
    run_step "Deploying edge function: ${fn}${SUFFIX}" \
      supabase functions deploy "${fn}${SUFFIX}" --project-ref "$PROJECT_ID"
  done
fi

echo ""
echo "Deployment to $ENV_NAME complete."
echo "Run the health check: $SCRIPT_DIR/test-functions.sh $ENV_NAME"
