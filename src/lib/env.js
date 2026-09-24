export const APP_ENV = (
  process.env.EXPO_PUBLIC_APP_ENV ||
  process.env.APP_ENV ||
  "development"
).toLowerCase();
export const SUPABASE_URL = "https://sffgznknlmqxtikkyhwu.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmZmd6bmtubG1xeHRpa2t5aHd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY5NzE0NzEsImV4cCI6MjA2MjU0NzQ3MX0.vWmG3p7QcjQWsoS1v9mljyXahYKqFqH40Khyb7OT87U";

export const getEdgeFunctionName = (name) => {
  if (!name) return name;
  const env = (APP_ENV || "development").toLowerCase();
  if (env === "development" || env === "test") {
    const [functionName, ...pathSegments] = String(name).split("/");
    const suffixedName = `${functionName}-test`;
    return [suffixedName, ...pathSegments].join("/");
  }
  return name;
};
