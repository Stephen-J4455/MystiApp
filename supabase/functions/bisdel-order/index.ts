import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return respond({ error: "Server is not configured" }, 500);
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization) return respond({ error: "Unauthorized" }, 401);

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError || !user) return respond({ error: "Unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile, error: profileError } = await admin
      .from("user_profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    const isAdmin = String(profile?.role || "").trim().toLowerCase() === "admin";

    const body = await req.json().catch(() => ({}));
    const orderId = Number(body?.order_id);
    const orderType = String(body?.order_type || "regular").trim().toLowerCase();
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return respond({ error: "A valid order_id is required" }, 400);
    }
    if (!["regular", "agent"].includes(orderType)) {
      return respond({ error: "order_type must be regular or agent" }, 400);
    }

    const table = orderType === "agent" ? "agent_orders" : "orders";
    const { data: order, error: orderError } = await admin
      .from(table)
      .select("*")
      .eq("id", orderId)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) return respond({ error: "Order not found" }, 404);

    const ownerId = orderType === "agent" ? order.agent_id : order.user_id;
    if (!isAdmin && ownerId !== user.id) {
      return respond({ error: "This order belongs to another account" }, 403);
    }
    if (String(order.provider_name || "").toLowerCase() !== "bisdel") {
      return respond({ error: "This order is not assigned to Bisdel" }, 409);
    }
    if (order.status === "cancelled") {
      return respond({ error: "This order was cancelled" }, 409);
    }
    if (order.jehuca_order_id) {
      return respond({
        success: true,
        already_dispatched: true,
        provider_name: "bisdel",
        provider_order_id: order.provider_order_id || null,
        order_reference: order.jehuca_order_id,
        status: order.status,
        jehuca_order_status: order.jehuca_order_status || null,
      });
    }
    if (order.jehuca_response?.success === true) {
      return respond({
        success: false,
        already_dispatched: true,
        error:
          "Bisdel previously accepted this order, but its reference is missing. Do not retry it.",
      }, 409);
    }

    const productId = String(order.provider_package_id || "").trim();
    const phone = String(
      orderType === "agent"
        ? order.recipient_phone || ""
        : order.phone || order.recipient_phone || "",
    ).replace(/\s+/g, "");
    if (!productId || !phone) {
      const { error: updateError } = await admin
        .from(table)
        .update({
          status: "pending",
          provider_deferred_at: new Date().toISOString(),
          provider_deferred_reason: "missing_provider_details",
          provider_dispatch_attempts:
            Number(order.provider_dispatch_attempts || 0) + 1,
        })
        .eq("id", order.id);
      if (updateError) throw updateError;
      return respond({
        error: "This order is missing the Bisdel product ID or recipient phone",
        details: { has_product_id: Boolean(productId), has_phone: Boolean(phone) },
      }, 400);
    }

    const apiKey = (Deno.env.get("BISDEL_DB") ?? "").replace(/\0/g, "").trim();
    const apiSecret = (Deno.env.get("BISDEL_SECRET_KEY") ?? "")
      .replace(/\0/g, "")
      .trim();
    if (!apiKey || !apiSecret) {
      const { error: updateError } = await admin
        .from(table)
        .update({
          status: "pending",
          provider_deferred_at: new Date().toISOString(),
          provider_deferred_reason: "credentials_not_configured",
          provider_dispatch_attempts:
            Number(order.provider_dispatch_attempts || 0) + 1,
        })
        .eq("id", order.id);
      if (updateError) throw updateError;
      return respond({ error: "Bisdel API credentials are not configured" }, 500);
    }

    const externalOrderId = `mysti-${orderType}-${order.id}`;
    let providerResponse: Response;
    try {
      providerResponse = await fetch(
        "https://bisdelgh.com/api/xx1/order.php",
        {
          method: "POST",
          headers: {
            "X-API-Key": apiKey,
            "X-API-Secret": apiSecret,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            product_id: productId,
            phone,
            quantity: 1,
            external_order_id: externalOrderId,
          }),
        },
      );
    } catch (error) {
      console.error("[Bisdel order] Request failed", {
        order_id: order.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await admin
        .from(table)
        .update({
          status: "pending",
          provider_deferred_at: new Date().toISOString(),
          provider_deferred_reason: "provider_unreachable",
          provider_dispatch_attempts:
            Number(order.provider_dispatch_attempts || 0) + 1,
        })
        .eq("id", order.id);
      return respond({
        success: false,
        deferred: true,
        reason: "provider_unreachable",
        error: "Bisdel could not be reached. The order was queued for retry.",
      });
    }

    const providerData = await providerResponse.json().catch(() => null);
    const accepted =
      providerResponse.ok &&
      providerData?.success === true &&
      providerData?.data?.success !== false;
    if (!accepted) {
      const { error: updateError } = await admin
        .from(table)
        .update({
          status: "pending",
          provider_deferred_at: new Date().toISOString(),
          provider_deferred_reason: "provider_rejected",
          jehuca_response: providerData ?? null,
          provider_dispatch_attempts:
            Number(order.provider_dispatch_attempts || 0) + 1,
        })
        .eq("id", order.id);
      if (updateError) throw updateError;
      console.error("[Bisdel order] Provider rejected order", {
        order_id: order.id,
        http_status: providerResponse.status,
        code: providerData?.code,
        error: providerData?.error || providerData?.message,
      });
      return respond({
        success: false,
        deferred: true,
        reason: "provider_rejected",
        provider_status: providerResponse.status,
        details: {
          code: providerData?.code,
          error: providerData?.error || providerData?.message,
        },
        error: providerData?.error || "Bisdel rejected the order.",
      });
    }

    const providerOrder = providerData?.data || {};
    const providerOrderId = providerOrder.order_id;
    const orderReference = String(
      providerOrder.order_reference || providerOrderId || "",
    ).trim();
    if (!orderReference) {
      console.error("[Bisdel order] Accepted response is missing its order ID", {
        order_id: order.id,
      });
      const { error: saveAcceptedResponseError } = await admin
        .from(table)
        .update({
          status: "processing",
          jehuca_response: providerData,
          provider_deferred_at: null,
          provider_deferred_reason: "provider_response_missing_order_id",
          provider_dispatch_attempts:
            Number(order.provider_dispatch_attempts || 0) + 1,
        })
        .eq("id", order.id);
      if (saveAcceptedResponseError) {
        console.error(
          "[Bisdel order] Could not save accepted response:",
          saveAcceptedResponseError.message,
        );
      }
      return respond({
        success: false,
        error: "Bisdel accepted the order but returned no order reference. Do not retry it.",
        provider_response: providerData,
      }, 502);
    }

    const providerStatus = String(providerOrder.status || "pending");
    const { error: orderUpdateError } = await admin
      .from(table)
      .update({
        // Bisdel may accept the order as pending while it fulfils it. Keep
        // Mysti's paid order in processing once the API accepts the request.
        status: "processing",
        jehuca_order_id: orderReference,
        jehuca_order_status: providerStatus,
        jehuca_response: providerData,
        provider_order_id: providerOrderId == null
          ? null
          : String(providerOrderId),
        provider_deferred_at: null,
        provider_deferred_reason: null,
        provider_dispatch_attempts:
          Number(order.provider_dispatch_attempts || 0) + 1,
        ...(orderType === "agent" ? { settlement_status: "settled" } : {}),
      })
      .eq("id", order.id);
    if (orderUpdateError) {
      console.error("[Bisdel order] Provider accepted; order update failed", {
        order_id: order.id,
        order_reference: orderReference,
        error: orderUpdateError.message,
      });
      return respond({
        error: "Bisdel accepted the order, but its reference could not be saved. Do not retry it.",
        order_reference: orderReference,
      }, 500);
    }

    const paymentReference = String(order.payment_reference || "").trim();
    if (paymentReference) {
      const { error: transactionError } = await admin
        .from("payment_transactions")
        .update({
          jehuca_order_id: orderReference,
          jehuca_order_status: providerStatus,
          jehuca_response: providerData,
          provider_name: "bisdel",
          provider_order_id: providerOrderId == null
            ? null
            : String(providerOrderId),
          ...(orderType === "agent" ? { settlement_status: "settled" } : {}),
        })
        .eq("payment_reference", paymentReference);
      if (transactionError) {
        console.warn(
          "[Bisdel order] Could not update payment transaction:",
          transactionError.message,
        );
      }
    }

    return respond({
      success: true,
      deferred: false,
      provider_name: "bisdel",
      provider_order_id: providerOrderId ?? null,
      order_reference: orderReference,
      status: "processing",
      jehuca_order_status: providerStatus,
    });
  } catch (error) {
    console.error(
      "[Bisdel order] Unexpected error:",
      error instanceof Error ? error.message : error,
    );
    return respond({
      success: false,
      error: error instanceof Error ? error.message : "Unexpected server error",
    }, 500);
  }
});
