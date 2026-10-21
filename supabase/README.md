# Supabase � environments & deployments

This directory holds all Supabase-related assets (migrations, edge
functions and helper scripts). The mobile app talks to Supabase through
`src/lib/env.js`, which selects the right backend at build time based
on the `APP_ENV` variable.

## Environments

| Env name    | What it is                                     | Paystack mode |
| ----------- | ---------------------------------------------- | ------------- |
| development | Shared Supabase project + unsuffixed functions | LIVE          |
| test        | Legacy configuration; not used for deployment  | LIVE          |
| production  | Shared Supabase project + unsuffixed functions | LIVE          |

The shared Supabase project uses only the production Paystack secrets
`PAYSTACK_SECRET_KEY` and `PAYSTACK_PUBLIC_KEY`. The test Paystack secrets
are no longer read by the Edge Functions. Production builds use
`APP_ENV=production` and deploy/call the unsuffixed function names.

## One-time setup

1. Install the Supabase CLI: `npm i -g supabase` (or use
   `npx supabase ...`).
2. Use one Supabase project for the production app.
3. In the Supabase dashboard, copy the project's URL, anon key, and
   service-role key.
4. In Paystack, get a LIVE secret key
   (`sk_live_...`) and matching LIVE public key
   (`pk_live_...`).
5. Copy the production env template:

   ```bash
   cp supabase/.env.production.template supabase/.env.production
   cp .env.production.template          .env.production
   ```

6. Fill in the production copies with your real values. The files are listed
   in `.gitignore` (via the `.env*` pattern) and the `.template` files
   are safe to commit.

7. Login the CLI once:

   ```bash
   supabase login
   ```

## Daily workflow

### Deploy production Edge Functions

```bash
npm run secrets:set:prod
npm run deploy:prod
```

This deploys the unsuffixed function names, such as `health` and
`verify-payment`, to the shared Supabase project.

### Push production secrets only

```bash
npm run secrets:set:prod
```

Reads `supabase/.env.production`, skips the `EXPO_PUBLIC_*` /
`SUPABASE_PROJECT_ID_*` / `SUPABASE_DB_URL_*` keys, and pushes the rest
to the shared project's Edge Function secret store. It also sets
`APP_ENV=production`.

### Deploy only functions (skip migrations)

```bash
npm run functions:deploy:prod
```

This deploys only the unsuffixed production functions and skips migrations.

### Verify the deployment

```bash
npm run functions:test:prod
```

Calls the shared project's `<supabase-url>/functions/v1/health` endpoint and
prints the JSON response. The health endpoint reports:

- `appEnv` � value of the `APP_ENV` secret
- `checks.database.ok` � does the service-role key work?
- `checks.paystack.configured` + `checks.paystack.live` � is a Paystack
  secret set, and is it a LIVE key?
- `checks.fcm.configured` � is FCM configured?

It returns HTTP 200 when both the database and Paystack secrets are
healthy, otherwise 503.

### Production deployment checklist

```bash
npm run secrets:set:prod
npm run deploy:prod
npm run functions:test:prod
```

Production deployments should _always_ push fresh production secrets first,
then deploy the unsuffixed function names, then verify.

### Run locally against production functions

```bash
# Default Expo dev server uses .env / .env.local:
npx expo start

# Production function names:
APP_ENV=production npx expo start
```

The legacy `env:test` path selects `-test` function names and should not be
used for production.

### EAS Build

```bash
eas build --platform android --env-file .env.production # production APK
```

`APP_ENV` is read directly by `src/lib/env.js` to select the edge
function suffix.

## What lives where

```
supabase/
+-- config.toml                    # Supabase CLI config (project-agnostic)
+-- migrations/                    # SQL applied in order by `supabase db push`
�   +-- 20260919_001_create_super_agent_tiers.sql
�   +-- 20260919_002_add_tier_fields_to_super_agent_offers.sql
�   +-- 20260919_003_add_tier_name_to_assignments.sql
�   +-- 20260919_004_create_super_agent_paystack.sql
+-- functions/
�   +-- _shared/env.ts             # `getAppEnv()` helper used by every function
�   +-- health/index.ts            # GET /functions/v1/health  (liveness probe)
�   +-- paystack-subaccount/index.ts
�   +-- send-notification/index.ts
�   +-- super-agent-offers/index.ts
�   +-- super-agent-tier-management/index.ts
�   +-- super-agent-user-management/index.ts
�   +-- verify-payment/index.ts
�   +-- verify-wallet-topup/index.ts
+-- scripts/
�   +-- deploy.ps1 / deploy.sh     # link + db push + functions deploy
�   +-- set-secrets.ps1 / set-secrets.sh
�   +-- test-functions.ps1 / test-functions.sh
+-- .env.test.template             # Supabase CLI secrets for TEST
+-- .env.production.template       # Supabase CLI secrets for PROD
+-- README.md                      # ? you are here
```

## Adding a new edge function

1. Create `supabase/functions/<name>/index.ts`.
2. Add the function name to the `functions` array in both
   `supabase/scripts/deploy.ps1` and `supabase/scripts/deploy.sh`.
3. Run `npm run functions:deploy:prod` to deploy the unsuffixed function.
4. Run `npm run functions:test:prod` to confirm it is healthy.
5. Do not add a `-test` suffix for the production deployment.

## Troubleshooting

| Symptom                                         | Likely cause                                        | Fix                                                                                      |
| ----------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Health check returned non-2xx response`        | The function URL is wrong or the project is offline | Re-check the shared Supabase URL and deployed function name in the selected env          |
| `checks.database.ok = false`                    | Missing/invalid service-role key                    | Re-run `supabase login` and `npm run secrets:set:prod`                                   |
| `checks.paystack.configured = false`            | `PAYSTACK_SECRET_KEY` not set                       | Add it to `supabase/.env.production` and re-run `npm run secrets:set:prod`               |
| `link failed: project not found`                | `SUPABASE_PROJECT_ID_TEST` is wrong                 | Open the Supabase dashboard ? Settings ? General ? Reference ID                          |
| `db push` reports `permission denied for table` | Migrations include statements RLS blocks            | Run `supabase db push` against a database with a privileged role (use the dashboard URL) |
| Mobile app still hits the old project           | Stale build cache or `APP_ENV` not set              | `npx expo start -c` to clear the Metro cache, or pass `--env-file .env.test` to EAS      |

## Script reference

| Script                          | Purpose                                          |
| ------------------------------- | ------------------------------------------------ |
| `npm run deploy:prod`           | Full production deploy                           |
| `npm run functions:deploy:prod` | Deploy unsuffixed production Edge Functions      |
| `npm run db:push:prod`          | Apply migrations                                 |
| `npm run secrets:set:prod`      | Push production secrets and `APP_ENV=production` |
| `npm run functions:test:prod`   | Hit `/functions/v1/health`                       |

For production, use the `:prod` scripts only. The `:test` scripts are legacy
entry points and are not part of the production deployment path.
