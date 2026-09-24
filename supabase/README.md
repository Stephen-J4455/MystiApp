# Supabase � environments & deployments

This directory holds all Supabase-related assets (migrations, edge
functions and helper scripts). The mobile app talks to Supabase through
`src/lib/env.js`, which selects the right backend at build time based
on the `APP_ENV` variable.

## Environments

| Env name    | What it is                                    | Paystack mode |
| ----------- | --------------------------------------------- | ------------- |
| development | Shared Supabase project + TEST function names | TEST          |
| test        | Shared Supabase project + TEST function names | TEST          |
| production  | Shared Supabase project + PROD function names | LIVE          |

Both environments use the same Supabase URL and client credentials. `APP_ENV`
only controls the Edge Function name suffix in the app. Because Supabase
secrets are project-wide, a single shared project cannot expose different
`APP_ENV` secret values to test and production functions at the same time.

## One-time setup

1. Install the Supabase CLI: `npm i -g supabase` (or use
   `npx supabase ...`).
2. Use one Supabase project for both the test and production app environments.
3. In the Supabase dashboard, copy the project's URL, anon key, and
   service-role key.
4. In Paystack, get a TEST secret key
   (`sk_test_�`) and a LIVE secret key (`sk_live_�`).
5. Copy the env templates:

   ```bash
   cp supabase/.env.test.template       supabase/.env.test
   cp supabase/.env.production.template supabase/.env.production
   cp .env.test.template                .env.test
   cp .env.production.template          .env.production
   ```

6. Fill in the four copies with your real values. The files are listed
   in `.gitignore` (via the `.env*` pattern) and the `.template` files
   are safe to commit.

7. Login the CLI once:

   ```bash
   supabase login
   ```

## Daily workflow

### Deploy everything to TEST

```bash
npm run deploy:test
```

That single command:

1. `supabase link` to the shared project.
2. `supabase db push` to apply every migration in `supabase/migrations/`.
3. `supabase functions deploy` for the selected function-name set under
   `supabase/functions/`.

### Push secrets only

```bash
npm run secrets:set:test
```

Reads `supabase/.env.test`, skips the `EXPO_PUBLIC_*` /
`SUPABASE_PROJECT_ID_*` / `SUPABASE_DB_URL_*` keys, and pushes the rest
to the shared project's edge function secret store. Also sets the
project-wide `APP_ENV` value used by the functions.

### Deploy only functions (skip migrations)

```bash
npm run functions:deploy:test
```

Useful after iterating on a single function � much faster than running
the whole `deploy:test`.

### Verify the deployment

```bash
npm run functions:test:test
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

### Deploy to PRODUCTION

```bash
npm run secrets:set:prod
npm run deploy:prod
npm run functions:test:prod
```

Production deployments should _always_ push fresh secrets first, then
deploy, then verify.

## Running the mobile app against a specific env

### Local dev (laptop)

```bash
# Default Expo dev server uses .env / .env.local:
npx expo start

# Force a specific function-name set:
npm run env:test    # APP_ENV=test    ? -test function names
npm run env:prod    # APP_ENV=production ? unsuffixed function names
```

### EAS Build

```bash
eas build --platform android --env-file .env.test      # ? test APK
eas build --platform android --env-file .env.production # ? prod APK
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
3. Run `npm run functions:deploy:test` to push it to TEST first.
4. Run `npm run functions:test:test` to confirm it appears in the
   `health` response (if you add it to the health probe) or call it
   manually.
5. Once it is healthy in TEST, run `npm run deploy:prod`.

## Troubleshooting

| Symptom                                         | Likely cause                                        | Fix                                                                                      |
| ----------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Health check returned non-2xx response`        | The function URL is wrong or the project is offline | Re-check the shared Supabase URL and deployed function name in the selected env          |
| `checks.database.ok = false`                    | Missing/invalid service-role key                    | Re-run `supabase login` and `npm run secrets:set:test`                                   |
| `checks.paystack.configured = false`            | `PAYSTACK_SECRET_KEY` not set                       | Add it to `supabase/.env.test` and re-run `npm run secrets:set:test`                     |
| `link failed: project not found`                | `SUPABASE_PROJECT_ID_TEST` is wrong                 | Open the Supabase dashboard ? Settings ? General ? Reference ID                          |
| `db push` reports `permission denied for table` | Migrations include statements RLS blocks            | Run `supabase db push` against a database with a privileged role (use the dashboard URL) |
| Mobile app still hits the old project           | Stale build cache or `APP_ENV` not set              | `npx expo start -c` to clear the Metro cache, or pass `--env-file .env.test` to EAS      |

## Script reference

| Script                                  | Purpose                                             |
| --------------------------------------- | --------------------------------------------------- |
| `npm run deploy:test` / `:prod`         | Full deploy (link + db push + every edge function)  |
| `npm run functions:deploy:test`/`:prod` | Edge functions only                                 |
| `npm run db:push:test` / `:prod`        | Migrations only                                     |
| `npm run secrets:set:test` / `:prod`    | Push secrets from `supabase/.env.*`                 |
| `npm run functions:test:test`/`:prod`   | Hit `/functions/v1/health`                          |
| `npm run env:test` / `:prod`            | Start the Expo dev server against the named backend |

Every script accepts `bash` variants (e.g. `npm run deploy:test:bash`) for
macOS / Linux users.
