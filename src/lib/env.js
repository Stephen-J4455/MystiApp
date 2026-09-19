// Centralised environment configuration.
//
// The app selects its target backend (Supabase project + Paystack keys)
// at build time based on the `EXPO_PUBLIC_APP_ENV` environment variable.
// Supported values:
//
//   development  - local Supabase + Paystack TEST keys
//   test         - dedicated Supabase TEST project + Paystack TEST keys
//   production   - Supabase LIVE project + Paystack LIVE keys
//
// In an Expo dev server (`__DEV__ === true`) the default is "development"
// unless EXPO_PUBLIC_APP_ENV is explicitly set, which makes local hacking
// safe even if the .env files are missing.
//
// For EAS / production builds set the env at build time:
//   eas build --environment preview  (preview == test)
//   eas build --environment production
// or:
//   EXPO_PUBLIC_APP_ENV=test  eas build --platform android
//   EXPO_PUBLIC_APP_ENV=prod  eas build --platform android

const KNOWN_ENVS = ["development", "test", "production"];

const readEnv = () => {
  // Expo injects EXPO_PUBLIC_* variables at build time via process.env
  // (web) or Constants.expoConfig.extra (native). Both reach the bundle.
  let raw = "";
  try {
    if (typeof process !== "undefined" && process.env) {
      raw = process.env.EXPO_PUBLIC_APP_ENV || "";
    }
  } catch (_) {
    raw = "";
  }
  if (!raw && typeof globalThis !== "undefined" && globalThis.EXPO_PUBLIC_APP_ENV) {
    raw = globalThis.EXPO_PUBLIC_APP_ENV;
  }
  if (!raw) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Constants = require("expo-constants").default;
      raw =
        (Constants.expoConfig && Constants.expoConfig.extra &&
          Constants.expoConfig.extra.appEnv) || "";
    } catch (_) {
      raw = "";
    }
  }
  return String(raw).trim().toLowerCase();
};

const __DEV__ =
  typeof globalThis !== "undefined" && globalThis.__DEV__ === true;

const resolved = (() => {
  const candidate = readEnv();
  if (KNOWN_ENVS.includes(candidate)) return candidate;
  return __DEV__ ? "development" : "production";
})();

// ---- Supabase ----
const SUPABASE_CONFIG = {
  development: {
    url: "http://127.0.0.1:54321",
    anonKey:
      // Default local Supabase anon key � replace with your own if you
      // started a local stack with `supabase start`.
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sIjoiYW5vbiIsInVubyI6ImFkbWluIiwiaWF0IjoxNzQ2OTcxNDcxLCJleHAiOjIwNjI1NDc0NzF9.vWmG3p7QcjQWsoS1v9mljyXahYKqFqH40Khyb7OT87U",
    label: "Local Supabase",
  },
  test: {
    url: process.env.EXPO_PUBLIC_SUPABASE_TEST_URL || "",
    anonKey: process.env.EXPO_PUBLIC_SUPABASE_TEST_ANON_KEY || "",
    label: "Test Supabase",
  },
  production: {
    url: "https://sffgznknlmqxtikkyhwu.supabase.co",
    anonKey:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmZmd6bmtubG1xeHRpa2t5aHd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY5NzE0NzEsImV4cCI6MjA2MjU0NzQ3MX0.vWmG3p7QcjQWsoS1v9mljyXahYKqFqH40Khyb7OT87U",
    label: "Production Supabase",
  },
};

const SUPABASE = SUPABASE_CONFIG[resolved] || SUPABASE_CONFIG.production;

// ---- Paystack ----
const PAYSTACK_CONFIG = {
  development: {
    publicKey:
      process.env.EXPO_PUBLIC_PAYSTACK_TEST_PUBLIC_KEY ||
      "pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    live: false,
    label: "Paystack TEST",
  },
  test: {
    publicKey:
      process.env.EXPO_PUBLIC_PAYSTACK_TEST_PUBLIC_KEY ||
      "pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    live: false,
    label: "Paystack TEST",
  },
  production: {
    publicKey:
      process.env.EXPO_PUBLIC_PAYSTACK_LIVE_PUBLIC_KEY ||
      "pk_live_aa97a7f0f4c0e512607d0c2e0f5a53a629614273",
    live: true,
    label: "Paystack LIVE",
  },
};

const PAYSTACK = PAYSTACK_CONFIG[resolved] || PAYSTACK_CONFIG.production;

export const APP_ENV = resolved;
export const IS_PRODUCTION = resolved === "production";
export const IS_TEST = resolved === "test";
export const IS_DEVELOPMENT = resolved === "development";

export const SUPABASE_URL = SUPABASE.url;
export const SUPABASE_ANON_KEY = SUPABASE.anonKey;
export const SUPABASE_LABEL = SUPABASE.label;

export const PAYSTACK_PUBLIC_KEY = PAYSTACK.publicKey;
export const PAYSTACK_LIVE = PAYSTACK.live;
export const PAYSTACK_LABEL = PAYSTACK.label;

// Helpful for debugging in dev � never logged in production.
export const ENV_SUMMARY = {
  appEnv: APP_ENV,
  supabase: SUPABASE_LABEL,
  paystack: PAYSTACK_LABEL,
  supabaseUrl: SUPABASE.url,
};

export const KNOWN_APP_ENVS = KNOWN_ENVS;

// ---- Edge function name resolver ----
// In development mode, prepend "-test" to edge function names so the
// mobile app talks to the deployed test-environment functions rather than
// trying to hit locally-served ones.  The push-notification function is
// excluded because the test project does not have FCM configured yet.
const NO_PUSH_NOTIFICATION_FNS = new Set(["send-notification"]);

/**
 * Return the proper edge-function name for the current environment.
 * @param {string} fnName  – base name of the edge function (e.g. "verify-payment")
 * @returns {string}
 */
export function getEdgeFunctionName(fnName) {
  if (APP_ENV === "development" && !NO_PUSH_NOTIFICATION_FNS.has(fnName)) {
    return `${fnName}-test`;
  }
  return fnName;
}
