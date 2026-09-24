import Constants from "expo-constants";
import { Platform } from "react-native";

// Web reads the build-time APP_ENV configured in Vercel. Native builds remain
// fixed to production.
export const APP_ENV = (
  (Platform.OS === "web" && Constants.expoConfig?.extra?.appEnv) ||
  "production"
).toLowerCase();
export const SUPABASE_URL = "https://sffgznknlmqxtikkyhwu.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmZmd6bmtubG1xeHRpa2t5aHd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY5NzE0NzEsImV4cCI6MjA2MjU0NzQ3MX0.vWmG3p7QcjQWsoS1v9mljyXahYKqFqH40Khyb7OT87U";

export const getEdgeFunctionName = (name) => {
  if (!name) return name;
  const env = APP_ENV;
  if (env === "development" || env === "test") {
    const [functionName, ...pathSegments] = String(name).split("/");
    if (functionName.endsWith("-test")) return name;
    return [`${functionName}-test`, ...pathSegments].join("/");
  }
  return name;
};
