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
  # Discovered from the filesystem, matching deploy.ps1. The previous
  # hardcoded list had drifted: it named "get-order-status" (not a real
  # folder - it is "check-order-status") and omitted admin-users,
  # bulk-update-orders and dispatch-order, so those never deployed from
  # bash.
  FUNCTIONS_DIR="$REPO_ROOT/supabase/functions"
  FUNCTIONS=()
  while IFS= read -r dir; do
    name="$(basename "$dir")"
    # Skip helper directories such as _shared.
    [[ "$name" == _* ]] && continue
    if [[ -f "$dir/index.ts" || -f "$dir/index.js" ]]; then
      FUNCTIONS+=("$name")
    fi
  done < <(find "$FUNCTIONS_DIR" -mindepth 1 -maxdepth 1 -type d | sort)

  if [[ ${#FUNCTIONS[@]} -eq 0 ]]; then
    echo "No edge functions found in $FUNCTIONS_DIR" >&2
    exit 1
  fi

  echo ""
  echo "Deploying ${#FUNCTIONS[@]} edge function(s) with suffix '${SUFFIX}':"
  for fn in "${FUNCTIONS[@]}"; do
    echo "  - ${fn}${SUFFIX}"
  done

  # `supabase functions deploy <name>` uploads supabase/functions/<name>/, so
  # the deployed name IS the folder name. `deploy health-test` looks for a
  # health-test folder that does not exist and fails with:
  #   Entrypoint path does not exist - .../supabase/functions/health-test/index.ts
  # For production (empty suffix) the folder already matches. For test we
  # stage each function into <root>/supabase/functions/<name>-test and deploy
  # with --workdir, then clean up. --workdir is the directory that CONTAINS
  # the supabase/ folder. --use-api bundles server-side because Docker is
  # often not available.
  STAGING_ROOT=""
  if [[ -n "$SUFFIX" ]]; then
    STAGING_ROOT="$(mktemp -d)"
    mkdir -p "$STAGING_ROOT/supabase/functions"
    echo "Staging suffixed functions under $STAGING_ROOT"
  fi

  cleanup() {
    if [[ -n "$STAGING_ROOT" && -d "$STAGING_ROOT" ]]; then
      rm -rf "$STAGING_ROOT"
    fi
  }
  trap cleanup EXIT

  for fn in "${FUNCTIONS[@]}"; do
    deploy_name="${fn}${SUFFIX}"
    if [[ -n "$STAGING_ROOT" ]]; then
      cp -R "$FUNCTIONS_DIR/$fn" "$STAGING_ROOT/supabase/functions/$deploy_name"
      for shared in import_map.json deno.json; do
        [[ -f "$FUNCTIONS_DIR/$shared" ]] && \
          cp "$FUNCTIONS_DIR/$shared" "$STAGING_ROOT/supabase/functions/$shared"
      done
      run_step "Deploying edge function: $deploy_name" \
        supabase functions deploy "$deploy_name" --project-ref "$PROJECT_ID" \
        --workdir "$STAGING_ROOT" --use-api
    else
      run_step "Deploying edge function: $deploy_name" \
        supabase functions deploy "$deploy_name" --project-ref "$PROJECT_ID" --use-api
    fi
  done
fi

echo ""
echo "Deployment to $ENV_NAME complete."
echo "Run the health check: $SCRIPT_DIR/test-functions.sh $ENV_NAME"
