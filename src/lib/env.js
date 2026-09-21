export const APP_ENV = "development";
export const SUPABASE_URL = "https://sffgznknlmqxtikkyhwu.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmZmd6bmtubG1xeHRpa2t5aHd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY5NzE0NzEsImV4cCI6MjA2MjU0NzQ3MX0.vWmG3p7QcjQWsoS1v9mljyXahYKqFqH40Khyb7OT87U";
export const PAYSTACK_PUBLIC_KEY =
  "pk_test_7d6bef2c11764ac43547031baf2c197607286987";
export const PAYSTACK_LIVE = false;
export const PAYSTACK_LABEL = "Mysti";

export const getEdgeFunctionName = (name) => {
  if (!name) return name;
  const env = (APP_ENV || "development").toLowerCase();
  if (env !== "production") {
    return `${name}-test`;
  }
  return name;
};
