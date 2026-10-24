import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "POST is required" }, 405);
  }

  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization) {
      return json({ error: "Missing authorization token" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return json({ error: "Supabase service configuration is missing" }, 500);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile, error: profileError } = await admin
      .from("user_profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (profile?.role !== "admin") {
      return json({ error: "Administrator access required" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const provider = String(body.provider || "").trim().toLowerCase();
    if (provider !== "jehuca" && provider !== "bisdel") {
      return json({ error: "Provider must be jehuca or bisdel" }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return json({ error: "Enabled must be a boolean" }, 400);
    }

    const enabledColumn =
      provider === "bisdel" ? "bisdel_enabled" : "jehuca_enabled";
    const { data, error } = await admin
      .from("data_provider_settings")
      .update({
        [enabledColumn]: body.enabled,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", true)
      .select("jehuca_enabled, bisdel_enabled")
      .single();
    if (error) throw error;
    return json({
      jehuca_enabled: data.jehuca_enabled,
      bisdel_enabled: data.bisdel_enabled,
    });
  } catch (error) {
    console.error("Error updating provider activation:", error);
    return json(
      { error: error instanceof Error ? error.message : "Unexpected server error" },
      500,
    );
  }
});
