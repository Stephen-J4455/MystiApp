import Constants from "expo-constants";
import { Platform } from "react-native";

// How the environment is selected, in priority order:
//
//   1. EXPO_PUBLIC_APP_ENV  - explicit override, works on every platform.
//   2. APP_ENV              - set by the npm scripts (start:dev / start:prod)
//                             and by the Vercel web build. Read on native too:
//                             a native build that could not see APP_ENV could
//                             never reach the `-test` edge functions.
//   3. extra.appEnv          - Vercel web build, forwarded by app.config.js.
//   4. "production"          - safe default, unsuffixed function names.
//
// Any value other than "production" resolves names with a `-test` suffix, so
// a typo would silently target the test functions. Normalize and warn rather
// than guessing.
const rawEnv =
  process.env.EXPO_PUBLIC_APP_ENV ||
  process.env.APP_ENV ||
  (Platform.OS === "web" ? Constants.expoConfig?.extra?.appEnv : null) ||
  "production";

export const APP_ENV = String(rawEnv).toLowerCase().trim();

if (
  APP_ENV !== "production" &&
  APP_ENV !== "development" &&
  APP_ENV !== "test"
) {
  console.warn(
    `[env] Unrecognized APP_ENV="${APP_ENV}". Falling back to unsuffixed edge function names. ` +
      "Valid values: production, development, test.",
  );
}

export const IS_TEST_ENV = APP_ENV === "development" || APP_ENV === "test";

export const SUPABASE_URL = "https://sffgznknlmqxtikkyhwu.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmZmd6bmtubG1xeHRpa2t5aHd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY5NzE0NzEsImV4cCI6MjA2MjU0NzQ3MX0.vWmG3p7QcjQWsoS1v9mljyXahYKqFqH40Khyb7OT87U";

// Maps a logical function name to the name deployed in the current env.
//   "verify-payment" -> "verify-payment"      (production)
//                    -> "verify-payment-test" (development/test)
// Already-suffixed names and names with path segments are preserved.
export const getEdgeFunctionName = (name) => {
  if (!name) return name;
  if (!IS_TEST_ENV) return name;
  const [functionName, ...pathSegments] = String(name).split("/");
  if (functionName.endsWith("-test")) return name;
  return [`${functionName}-test`, ...pathSegments].join("/");
};

if (__DEV__) {
  console.log(`[env] APP_ENV=${APP_ENV} (test=${IS_TEST_ENV})`);
}
