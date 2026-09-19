#!/usr/bin/env bash
# Hit the deployed health endpoint to verify the edge function deployment
# is live and connected to the expected environment.
#
# Usage:
#   ./supabase/scripts/test-functions.sh test
#   ./supabase/scripts/test-functions.sh production
#   ./supabase/scripts/test-functions.sh "" https://abc.supabase.co/functions/v1/health

set -euo pipefail

ENV_NAME="${1:-}"
URL="${2:-}"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"

if [[ -z "$URL" ]]; then
  if [[ -z "$ENV_NAME" || ( "$ENV_NAME" != "test" && "$ENV_NAME" != "production" ) ]]; then
    echo "Usage: $0 <test|production> [url]" >&2
    exit 1
  fi
  ENV_FILE="$REPO_ROOT/supabase/.env.$ENV_NAME"
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing $ENV_FILE. Copy $ENV_FILE.template and fill in your values first." >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
  if [[ "$ENV_NAME" == "test" ]]; then
    URL_CANDIDATES=(EXPO_PUBLIC_SUPABASE_TEST_URL SUPABASE_TEST_URL SUPABASE_URL_TEST)
  else
    URL_CANDIDATES=(EXPO_PUBLIC_SUPABASE_PRODUCTION_URL EXPO_PUBLIC_SUPABASE_LIVE_URL SUPABASE_PRODUCTION_URL SUPABASE_URL_PRODUCTION)
  fi
  URL_VALUE=""
  for var in "${URL_CANDIDATES[@]}"; do
    candidate="${!var:-}"
    if [[ -z "$candidate" ]]; then continue; fi
    if [[ "$candidate" == pk_* || "$candidate" == sk_* ]]; then continue; fi
    URL_VALUE="$candidate"
    break
  done
  if [[ -z "$URL_VALUE" ]]; then
    echo "Could not resolve Supabase URL. Set one of: ${URL_CANDIDATES[*]}" >&2
    exit 1
  fi
  URL="$URL_VALUE/functions/v1/health"
fi

echo "Calling health endpoint: $URL"

HTTP_CODE=$(curl -s -o /tmp/health_response.json -w "%{http_code}" \
  -H "apikey: ${SUPABASE_ANON_KEY:-}" \
  -H "Content-Type: application/json" \
  "$URL" || true)

if [[ -z "$HTTP_CODE" || "$HTTP_CODE" == "000" ]]; then
  echo "Health check failed: no response" >&2
  exit 1
fi

echo ""
echo "HTTP $HTTP_CODE"
cat /tmp/health_response.json
echo ""

if grep -q "\"ok\": *true" /tmp/health_response.json && [[ "$HTTP_CODE" == "200" ]]; then
  echo ""
  echo "Health OK"
  exit 0
fi
echo ""
echo "Health check reports issues. See above." >&2
exit 1
