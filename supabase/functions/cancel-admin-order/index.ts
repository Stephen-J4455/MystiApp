import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || anonKey;
    const authorization = req.headers.get("Authorization");
    if (!authorization)
      return respond({ error: "Missing authorization token" }, 401);

    const authClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const admin = createClient(url, serviceKey);
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError || !user) return respond({ error: "Unauthorized" }, 401);

    const role = String(
      user.user_metadata?.role || user.app_metadata?.role || "",
    ).toLowerCase();
    if (role !== "admin") return respond({ error: "Admin role required" }, 403);

    const { order_id: orderId, order_type: orderType } = await req.json();
    if (!orderId || !["agent", "normal"].includes(orderType))
      return respond(
        { error: "order_id and valid order_type are required" },
        400,
      );

    const { data, error } = await admin.rpc("cancel_admin_order", {
      p_order_type: orderType,
      p_order_id: orderId,
    });
    if (error) {
      console.error("[CancelOrder] Cancellation failed:", error);
      return respond({ error: error.message }, 400);
    }

    return respond(data);
  } catch (error) {
    console.error("[CancelOrder] Unexpected error:", error);
    return respond({ error: "Failed to cancel order" }, 500);
  }
});
