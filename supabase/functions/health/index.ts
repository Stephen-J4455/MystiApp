import { createClient } from "npm:@supabase/supabase-js@2";

// ---- Shared helpers inlined (was ../_shared/env.ts) ----

type AppEnv = "development" | "test" | "production" | "unknown";

function getAppEnv(): AppEnv {
  const raw = (Deno.env.get("APP_ENV") || "").toLowerCase().trim();
  if (raw === "development" || raw === "test" || raw === "production") {
    return raw as AppEnv;
  }
  return "unknown";
}

function buildInfo() {
  return {
    appEnv: getAppEnv(),
    supabaseUrl: Deno.env.get("SUPABASE_URL") || null,
    functionVersion: Deno.env.get("FUNCTION_VERSION") || null,
    commitSha: Deno.env.get("COMMIT_SHA") || null,
    nowIso: new Date().toISOString(),
  };
}
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const info = buildInfo();
  const startedAt = Date.now();

  // Probe the database to ensure this deployment actually has working
  // credentials. We do not leak any data � just whether the service role
  // key can reach the project.
  let dbOk = false;
  let dbError: string | null = null;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (supabaseUrl && serviceKey) {
      const admin = createClient(supabaseUrl, serviceKey);
      const { error } = await admin
        .from("agent_wallet")
        .select("agent_id", { count: "exact", head: true });
      if (!error || /does not exist|relation/i.test(error.message || "")) {
        dbOk = true;
      } else {
        dbError = error.message;
      }
    } else {
      dbError = "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY";
    }
  } catch (err) {
    dbError = (err as Error).message;
  }

  const appEnv = getAppEnv();
  const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");
  const paystackConfigured = Boolean(paystackSecret);
  const fcmConfigured = Boolean(Deno.env.get("FCM_SERVICE_ACCOUNT_JSON"));
  const paystackPublicKey = Deno.env.get("PAYSTACK_PUBLIC_KEY") || null;

  const payload = {
    ok: dbOk && paystackConfigured,
    appEnv,
    function: "health",
    version: Deno.env.get("FUNCTION_VERSION") || null,
    deployedAt: info.nowIso,
    responseTimeMs: Date.now() - startedAt,
    paystackPublicKey,
    checks: {
      database: {
        ok: dbOk,
        error: dbError,
      },
      paystack: {
        configured: paystackConfigured,
        live: paystackConfigured
          ? (paystackSecret || "").startsWith("sk_live_")
          : false,
      },
      fcm: {
        configured: fcmConfigured,
      },
    },
    supabase: {
      url: info.supabaseUrl,
    },
  };

  return new Response(JSON.stringify(payload, null, 2), {
    // Paystack clients need the public key even if the optional database
    // probe is unavailable. Keep the database result in checks.database.
    status: paystackConfigured ? 200 : 503,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
});
