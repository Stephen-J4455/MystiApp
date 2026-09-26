import { createClient } from "npm:@supabase/supabase-js@2";

// Dispatches a paid order to the Jehuca provider API.
//
// Called from the customer app immediately after payment, and again from the
// admin app's "Send to Jehuca" action. In both cases the same rules apply:
//
//   1. The admin's provider (Jehuca) account balance must cover the order's
//      cost. If it does not, the order is left in 'pending' and flagged as
//      deferred rather than failed, so the admin can top up the provider
//      account and retry later without the customer paying again.
//   2. Once the provider accepts, the order moves to 'processing'.
//
// The customer is never charged again on a retry: the payment is already
// settled, only the provider hand-off is retried.

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

const JEHUCA_ORDERS_URL = "https://backend.jehucale-business.com/api/orders";
const JEHUCA_BALANCE_URL = "https://backend.jehucale-business.com/api/balance";

const normalizeProviderType = (value: string) => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (!normalized) return "";
  if (normalized.includes("BIG TIME")) return "BIG TIME";
  if (normalized.includes("ISHARE")) return "ISHARE";
  return normalized.split(/[(-]/)[0].trim();
};

const toMilliGb = (value: number) => Math.round(value * 1000);

// Pulls a usable balance number out of the provider response. The provider has
// used both a scalar and a { data: { balance } } shape, so try the common
// places rather than assuming one.
const extractBalance = (payload: unknown): number => {
  const record = (payload || {}) as Record<string, unknown>;
  const candidates: unknown[] = [
    record.balance,
    record.available_balance,
    record.wallet_balance,
    (record.data as Record<string, unknown> | undefined)?.balance,
    (
      (record.data as Record<string, unknown> | undefined)?.data as
        | Record<string, unknown>
        | undefined
    )?.balance,
    (record.payload as Record<string, unknown> | undefined)?.balance,
  ];

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  return Number.NaN;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const apiKey = Deno.env.get("JEHUCA_API_KEY");
    if (!apiKey)
      return respond({ error: "Provider API is not configured" }, 500);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? supabaseAnonKey;
    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return respond(
        { error: "Supabase service configuration is missing" },
        500,
      );
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader)
      return respond({ error: "Missing authorization token" }, 401);

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError || !user) return respond({ error: "Unauthorized" }, 401);

    const role = String(
      user.user_metadata?.role || user.app_metadata?.role || "",
    ).toLowerCase();
    const isAdmin = role === "admin";

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const body = await req.json().catch(() => ({}));

    const orderId = Number(body.order_id);
    const orderType = String(body.order_type || "regular")
      .trim()
      .toLowerCase();
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

    // A customer may only dispatch their own order. Admins may dispatch any
    // order, which is what powers the retry button.
    const orderOwnerId =
      orderType === "agent"
        ? (order.agent_id as string | null)
        : (order.user_id as string | null);
    if (!isAdmin && orderOwnerId !== user.id) {
      return respond({ error: "This order belongs to another account" }, 403);
    }

    if (order.status === "cancelled") {
      return respond({ error: "This order was cancelled" }, 409);
    }

    // Already handed over: report success without creating a duplicate order
    // at the provider.
    if (order.jehuca_order_id) {
      return respond({
        success: true,
        already_dispatched: true,
        status: order.status,
        jehuca_order_id: order.jehuca_order_id,
        jehuca_order_status: order.jehuca_order_status || null,
      });
    }

    const phone =
      orderType === "agent"
        ? String(order.recipient_phone || "")
        : String(order.phone || order.recipient_phone || "");
    const cleanPhone = phone.replace(/\s+/g, "");

    const network = String(order.network || "")
      .trim()
      .toUpperCase();
    const providerPackageId = String(order.provider_package_id || "").trim();
    let providerSize = Number(order.provider_size || 0);
    if (!providerSize) {
      providerSize = Number(
        String(order.data_amount || order.offer_title || "").match(
          /(\d+(?:\.\d+)?)\s*GB/i,
        )?.[1] || 0,
      );
    }
    let providerType = normalizeProviderType(
      String(order.provider_type || "") ||
        String(order.data_amount || order.offer_title || ""),
    );

    if (!providerPackageId || !providerSize || !providerType || !cleanPhone) {
      return respond(
        {
          error:
            "This order is missing provider package details and cannot be sent to the provider",
          details: {
            provider_package_id: providerPackageId,
            provider_size: providerSize,
            provider_type: providerType,
            phone: cleanPhone,
          },
        },
        400,
      );
    }

    // The cost the provider charges. `api_cost` is the snapshot taken at
    // purchase time (live Jehuca price minus any admin discount) and is the
    // authoritative number.
    //
    // `base_amount` is only a fallback: on a normal-user order it is the price
    // the CUSTOMER paid, not what we owe the provider, so using it would
    // under-check the funds we need. Historical orders predate the snapshot and
    // have api_cost = null, so the old chain still applies for them.
    let cost = Number(order.api_cost);
    if (!Number.isFinite(cost) || cost <= 0) {
      cost = Number(order.base_amount || 0);
    }
    if (!Number.isFinite(cost) || cost <= 0) {
      cost = Number(order.amount || 0);
    }

    const balanceResponse = await fetch(JEHUCA_BALANCE_URL, {
      method: "GET",
      headers: { "X-API-Key": apiKey },
    });
    const balancePayload = await balanceResponse.json().catch(() => null);
    const availableBalance = extractBalance(balancePayload);

    if (!Number.isFinite(availableBalance)) {
      // If the balance cannot be read, do not dispatch blindly. Queue the
      // order instead so the admin can retry once the provider account is
      // confirmed to be funded.
      console.error(
        "[Dispatch] Could not read provider balance:",
        balancePayload,
      );
      await admin
        .from(table)
        .update({
          status: "pending",
          provider_deferred_at: new Date().toISOString(),
          provider_deferred_reason: "balance_check_failed",
          provider_dispatch_attempts:
            Number(order.provider_dispatch_attempts || 0) + 1,
        })
        .eq("id", order.id);

      return respond(
        {
          success: false,
          deferred: true,
          reason: "balance_check_failed",
          error:
            "Could not confirm the provider account balance. The order was queued for retry.",
        },
        202,
      );
    }

    if (availableBalance < cost) {
      await admin
        .from(table)
        .update({
          status: "pending",
          provider_deferred_at: new Date().toISOString(),
          provider_deferred_reason: "insufficient_api_balance",
          provider_dispatch_attempts:
            Number(order.provider_dispatch_attempts || 0) + 1,
        })
        .eq("id", order.id);

      console.warn("[Dispatch] Provider balance too low, order queued:", {
        order_id: order.id,
        available_balance: availableBalance,
        required: cost,
      });

      return respond(
        {
          success: false,
          deferred: true,
          reason: "insufficient_api_balance",
          available_balance: availableBalance,
          required: cost,
          error:
            "The provider account needs a top-up before this order can be sent.",
        },
        202,
      );
    }

    const providerResponse = await fetch(JEHUCA_ORDERS_URL, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        packages: [
          {
            packageId: providerPackageId,
            size: toMilliGb(providerSize),
            network,
            type: providerType,
            phone: cleanPhone,
          },
        ],
      }),
    });
    const providerData = await providerResponse.json().catch(() => null);
    const accepted = providerResponse.ok && providerData?.status === true;

    if (!accepted) {
      await admin
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

      console.error("[Dispatch] Provider rejected the order:", {
        order_id: order.id,
        http_status: providerResponse.status,
        provider_data: providerData,
      });

      return respond(
        {
          success: false,
          deferred: true,
          reason: "provider_rejected",
          provider_status: providerResponse.status,
          details: providerData,
          error:
            "The provider did not accept this order. It was queued for retry.",
        },
        202,
      );
    }

    const jehucaOrderId =
      providerData?.payload?.orderId ||
      providerData?.orderId ||
      providerData?.payload?.orders?.[0]?.id ||
      null;
    const jehucaOrderStatus =
      providerData?.payload?.orders?.[0]?.status ||
      providerData?.status ||
      "accepted";

    const { error: updateError } = await admin
      .from(table)
      .update({
        status: "processing",
        jehuca_order_id: jehucaOrderId,
        jehuca_order_status: jehucaOrderStatus,
        jehuca_response: providerData ?? null,
        provider_deferred_at: null,
        provider_deferred_reason: null,
        provider_dispatch_attempts:
          Number(order.provider_dispatch_attempts || 0) + 1,
      })
      .eq("id", order.id);

    if (updateError) {
      // The provider already has the order, so record what happened loudly
      // rather than retrying blindly and risking a duplicate purchase.
      console.error(
        "[Dispatch] Order dispatched but the status update failed:",
        { order_id: order.id, jehuca_order_id: jehucaOrderId },
        updateError,
      );
      return respond(
        {
          error:
            "The order reached the provider but its status could not be saved. Do not resend it.",
          jehuca_order_id: jehucaOrderId,
        },
        500,
      );
    }

    // Mirror the provider reference onto the payment record so the customer's
    // transaction history shows the same provider order id.
    const paymentReference = String(order.payment_reference || "").trim();
    if (paymentReference) {
      const { error: txError } = await admin
        .from("payment_transactions")
        .update({
          jehuca_order_id: jehucaOrderId,
          jehuca_order_status: jehucaOrderStatus,
          jehuca_response: providerData ?? null,
        })
        .eq("payment_reference", paymentReference);
      if (txError) {
        console.warn(
          "[Dispatch] Could not update payment_transactions:",
          txError.message,
        );
      }
    }

    return respond({
      success: true,
      deferred: false,
      status: "processing",
      jehuca_order_id: jehucaOrderId,
      jehuca_order_status: jehucaOrderStatus,
    });
  } catch (error) {
    console.error(
      "[Dispatch] Unexpected error:",
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
