import { createClient } from "npm:@supabase/supabase-js@2";

// Bulk order status updates for the admin app.
//
// Two paths on purpose:
//   - "cancelled" goes through cancel_admin_order (the same RPC the single-order
//     cancel uses) so a Sub-Agent order still refunds the Super Agent wallet.
//     A plain status write would strand that money.
//   - every other status is a direct update, which is cheap enough to batch.

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

// Must stay in sync with ORDER_STATUS_OPTIONS in
// MystiAdminApp/src/lib/orderStatus.js
const ALLOWED_STATUSES = [
  "pending",
  "processing",
  "completed",
  "delivered",
  "refunded",
  "failed",
  "cancelled",
];

const MAX_ORDERS = 200;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || anonKey;
    if (!url || !anonKey || !serviceKey) {
      return respond(
        { error: "Supabase service configuration is missing" },
        500,
      );
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization)
      return respond({ error: "Missing authorization token" }, 401);

    const authClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError || !user) return respond({ error: "Unauthorized" }, 401);

    const role = String(
      user.user_metadata?.role || user.app_metadata?.role || "",
    ).toLowerCase();
    if (role !== "admin") return respond({ error: "Admin role required" }, 403);

    const body = await req.json().catch(() => ({}));
    const newStatus = String(body.status || "")
      .trim()
      .toLowerCase();
    if (!ALLOWED_STATUSES.includes(newStatus)) {
      return respond({ error: "Unsupported order status" }, 400);
    }

    // Each entry is { id, order_type } because the two order tables are
    // separate and ids can overlap between them.
    const rawOrders = Array.isArray(body.orders) ? body.orders : [];
    if (rawOrders.length === 0) {
      return respond({ error: "Select at least one order" }, 400);
    }
    if (rawOrders.length > MAX_ORDERS) {
      return respond(
        { error: `Select up to ${MAX_ORDERS} orders at a time` },
        400,
      );
    }

    const normalized = rawOrders
      .map((entry: Record<string, unknown>) => ({
        id: Number(entry?.id),
        orderType:
          String(entry?.order_type || entry?.orderType || "").toLowerCase() ===
          "agent"
            ? "agent"
            : "regular",
      }))
      .filter(
        (entry: { id: number }) => Number.isInteger(entry.id) && entry.id > 0,
      );

    if (normalized.length === 0) {
      return respond({ error: "No valid orders were supplied" }, 400);
    }

    const admin = createClient(url, serviceKey);

    const regularIds = normalized
      .filter((entry) => entry.orderType === "regular")
      .map((entry) => entry.id);
    const agentIds = normalized
      .filter((entry) => entry.orderType === "agent")
      .map((entry) => entry.id);

    const succeeded: Array<{ id: number; order_type: string }> = [];
    const failed: Array<{
      id: number;
      order_type: string;
      error: string;
    }> = [];

    if (newStatus === "cancelled") {
      // Cancel one at a time so each order gets the wallet refund, and so a
      // single failure does not abandon the rest of the batch.
      for (const entry of normalized) {
        const { data, error } = await admin.rpc("cancel_admin_order", {
          p_order_type: entry.orderType === "agent" ? "agent" : "normal",
          p_order_id: entry.id,
        });
        if (error) {
          failed.push({
            id: entry.id,
            order_type: entry.orderType,
            error: error.message,
          });
          continue;
        }
        if (data && data.success === false) {
          failed.push({
            id: entry.id,
            order_type: entry.orderType,
            error: String(data.error || data.reason || "Cancellation failed"),
          });
          continue;
        }
        succeeded.push({ id: entry.id, order_type: entry.orderType });
      }
    } else {
      if (regularIds.length > 0) {
        const { error } = await admin
          .from("orders")
          .update({ status: newStatus })
          .in("id", regularIds);
        if (error) {
          regularIds.forEach((id) =>
            failed.push({ id, order_type: "regular", error: error.message }),
          );
        } else {
          regularIds.forEach((id) =>
            succeeded.push({ id, order_type: "regular" }),
          );
        }
      }

      if (agentIds.length > 0) {
        const { error } = await admin
          .from("agent_orders")
          .update({ status: newStatus })
          .in("id", agentIds);
        if (error) {
          agentIds.forEach((id) =>
            failed.push({ id, order_type: "agent", error: error.message }),
          );
        } else {
          agentIds.forEach((id) => succeeded.push({ id, order_type: "agent" }));
        }
      }
    }

    return respond({
      success: failed.length === 0,
      status: newStatus,
      updated: succeeded.length,
      failed,
    });
  } catch (error) {
    console.error(
      "[BulkUpdateOrders] Unexpected error:",
      error instanceof Error ? error.message : error,
    );
    return respond(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Unexpected server error",
      },
      500,
    );
  }
});
