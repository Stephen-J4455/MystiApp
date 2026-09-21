import { createClient } from "@supabase/supabase-js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

// Keep the app client keys directly in this file now that the env file has been removed.
// Replace the placeholders below with the real values from your Supabase project.
export const APP_ENV = "development";
export const SUPABASE_URL = "https://sffgznknlmqxtikkyhwu.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmZmd6bmtubG1xeHRpa2t5aHd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY5NzE0NzEsImV4cCI6MjA2MjU0NzQ3MX0.vWmG3p7QcjQWsoS1v9mljyXahYKqFqH40Khyb7OT87U";
export const PAYSTACK_PUBLIC_KEY =
  "pk_test_7d6bef2c11764ac43547031baf2c197607286987";

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

export const getPaystackPublicKey = async () => {
  try {
    const { data, error } = await supabase.functions.invoke("health");

    if (error) {
      console.warn(
        "Failed to fetch Paystack public key from edge function:",
        error,
      );
      return PAYSTACK_PUBLIC_KEY;
    }

    const value =
      data?.paystackPublicKey || data?.publicKey || data?.paystack?.publicKey;
    if (value) {
      return value;
    }

    console.warn("Paystack public key missing from health response.");
    return PAYSTACK_PUBLIC_KEY;
  } catch (error) {
    console.warn("Error fetching Paystack public key:", error);
    return PAYSTACK_PUBLIC_KEY;
  }
};
