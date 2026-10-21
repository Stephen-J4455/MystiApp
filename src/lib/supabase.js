import { createClient } from "@supabase/supabase-js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { APP_ENV, getEdgeFunctionName } from "../lib/env.js";

// Keep the app client keys directly in this file now that the env file has been removed.
// Replace the placeholders below with the real values from your Supabase project.
export const SUPABASE_URL = "https://sffgznknlmqxtikkyhwu.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmZmd6bmtubG1xeHRpa2t5aHd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY5NzE0NzEsImV4cCI6MjA2MjU0NzQ3MX0.vWmG3p7QcjQWsoS1v9mljyXahYKqFqH40Khyb7OT87U";

// Paystack keys live ONLY in edge function secrets. There is deliberately no
// PAYSTACK_PUBLIC_KEY constant here: a hardcoded value short-circuits
// getPaystackPublicKey() below, so the app could never receive the test key
// when APP_ENV=development. Both key sets are resolved by the `health` edge
// function, which knows from its own request URL whether it was deployed as
// `health` or `health-test`.

if (!SUPABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    `[supabase] SUPABASE_URL is empty for APP_ENV="${APP_ENV}". ` +
      "Update src/lib/supabase.js with your project URL.",
  );
}

const getStorage = () => {
  if (Platform.OS === "web") {
    return undefined;
  }
  return AsyncStorage;
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === "web",
    storage: getStorage(),
  },
});

const _originalFunctionsInvoke = supabase.functions.invoke.bind(
  supabase.functions,
);

supabase.functions.invoke = async (name, options = {}) => {
  const resolvedName = getEdgeFunctionName(name);
  const method = options.body ? "POST" : "GET";
  const startedAt = Date.now();
  // Log the FULL url, not just the function name. The name alone does not
  // tell you whether you are hitting production or the -test variants, and
  // the resolved name is easy to misread.
  const endpoint = `${SUPABASE_URL}/functions/v1/${resolvedName}`;
  console.log(`[Edge] → ${method} ${endpoint}`);
  try {
    const result = await _originalFunctionsInvoke(resolvedName, options);
    const ms = Date.now() - startedAt;
    if (result.error) {
      console.error(
        `[Edge] ✗ ${resolvedName} (${ms}ms): ${result.error.message}`,
      );
    } else {
      console.log(
        `[Edge] ✓ ${resolvedName} (${ms}ms) → ${result.data ? "ok" : "empty"}`,
      );
    }
    return result;
  } catch (err) {
    const isFunctionsHttpError =
      err?.constructor?.name === "FunctionsHttpError" ||
      err?.message?.includes("Edge Function returned a non-2xx status code");
    if (isFunctionsHttpError) {
      // supabase-js exposes the function's JSON body on `err.context`
      // (a Response), NOT on err.error / err.data. Reading only those two
      // meant the real reason - "Missing authorization token", "Wallet is
      // below minimum", "Payment already processed" - was thrown away and
      // replaced with a generic non-2xx message, so the app could never tell
      // the caller what actually went wrong.
      const response = err?.context;
      let body = null;
      if (response && typeof response.clone === "function") {
        try {
          const text = await response.clone().text();
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              body = text.slice(0, 500);
            }
          }
        } catch {
          body = null;
        }
      }
      // A Body already consumed by supabase-js is the other common location.
      if (!body && err?.error) body = err.error;
      if (!body && err?.data) body = err.data;

      // Surface the function's own message/error field first - that is the
      // actionable part. The HTTP status alone is not diagnostic.
      const serverMessage =
        (body && typeof body === "object"
          ? body.error || body.message || body.details
          : body) || null;

      console.error(
        `[Edge] ✗ ${resolvedName} (HTTP ${err?.status ?? response?.status ?? "unknown"}): ${
          serverMessage || "no response body"
        }` + (body ? ` Body: ${JSON.stringify(body).slice(0, 500)}` : ""),
      );
    } else {
      console.error(`[Edge] ✗ ${name} → throw: ${err.message}`);
    }
    throw err;
  }
};

export const getPaystackPublicKey = async () => {
  // No local key and no EXPO_PUBLIC_* fallback on purpose. Fetching from
  // `health` is what makes APP_ENV=development resolve the test key and
  // APP_ENV=production resolve the live key. The value is public either
  // way, so the extra round trip is safe.
  try {
    const { data, error } = await supabase.functions.invoke(
      getEdgeFunctionName("health"),
    );

    if (error) {
      console.warn(
        "Failed to fetch Paystack public key from edge function:",
        error,
      );
      return null;
    }

    const value =
      data?.paystackPublicKey || data?.publicKey || data?.paystack?.publicKey;
    if (value) {
      return value;
    }

    console.warn("Paystack public key missing from health response.");
    return null;
  } catch (error) {
    console.warn("Error fetching Paystack public key:", error);
    return null;
  }
};
