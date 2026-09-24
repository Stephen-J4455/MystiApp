import { createClient } from "@supabase/supabase-js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { APP_ENV, getEdgeFunctionName } from "../lib/env.js";

// Keep the app client keys directly in this file now that the env file has been removed.
// Replace the placeholders below with the real values from your Supabase project.
export const SUPABASE_URL = "https://sffgznknlmqxtikkyhwu.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmZmd6bmtubG1xeHRpa2t5aHd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY5NzE0NzEsImV4cCI6MjA2MjU0NzQ3MX0.vWmG3p7QcjQWsoS1v9mljyXahYKqFqH40Khyb7OT87U";

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
  console.log(`[Edge] → ${resolvedName} (${method})`);
  try {
    const result = await _originalFunctionsInvoke(resolvedName, options);
    if (result.error) {
      console.error(
        `[Edge] ✗ ${resolvedName} → error: ${result.error.message}`,
      );
    } else {
      console.log(`[Edge] ✓ ${resolvedName} → ${result.data ? "ok" : "empty"}`);
    }
    return result;
  } catch (err) {
    const isFunctionsHttpError =
      err?.constructor?.name === "FunctionsHttpError" ||
      err?.message?.includes("Edge Function returned a non-2xx status code");
    if (isFunctionsHttpError) {
      const errBody = err?.error || err?.data || null;
      const errDetail = errBody
        ? ` Response: ${JSON.stringify(errBody).slice(0, 500)}`
        : "";
      console.error(
        `[Edge] ✗ ${resolvedName} → FunctionsHttpError (HTTP ${err.status || "unknown"}): Edge Function returned a non-2xx status code. ` +
          `Endpoint: ${resolvedName}. Check that the edge function is deployed and healthy. ` +
          `Possible causes: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY in function secrets, invalid Paystack key, or function runtime error.${errDetail}`,
      );
    } else {
      console.error(`[Edge] ✗ ${name} → throw: ${err.message}`);
    }
    throw err;
  }
};

console.log("[supabase.js] Patch applied successfully");

export const getPaystackPublicKey = async () => {
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
