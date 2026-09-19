import { createClient } from "@supabase/supabase-js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_ENV } from "./env";

if (!SUPABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    `[supabase] SUPABASE_URL is empty for APP_ENV="${APP_ENV}". ` +
      "Did you forget to set EXPO_PUBLIC_SUPABASE_TEST_URL in your .env.test file?",
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
