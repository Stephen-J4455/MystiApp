import { createClient } from "npm:@supabase/supabase-js@2";
// ===========================================================================
// IDENTITY HELPERS - INLINED, DUPLICATED ON PURPOSE
// ===========================================================================
// WHY THIS BLOCK IS HERE INSTEAD OF IMPORTED
// -------------------------------------------
// These functions are deployed through the Supabase dashboard's "Deploy with
// upload file", which bundles ONLY the selected function folder. A relative
// import of a shared module therefore fails to resolve:
//
//   Failed to bundle the function (reason: Module not found
//   "file:///tmp/user_fn_.../_shared/auth.ts")
//
// (The CLI's `supabase functions deploy` bundles the whole directory and
// would resolve it, but the dashboard is what is used here.) So the helpers
// are inlined into every function that needs them and each function is
// entirely self-contained. There is no _shared directory and no
// cross-function import.
//
// WHAT IS AUTHORITATIVE
// ---------------------
// Role and ownership come from `public.user_profiles`, NOT from
// `user_metadata`. `user_metadata` is writable by the user via
// `supabase.auth.updateUser({ data: { role: 'admin' } })`, so any function
// that trusts it has self-service privilege escalation. `app_metadata` is
// service-role-only and safe. A missing profile row resolves to `sub_agent`,
// so this fails CLOSED.
//
// UPDATING THESE HELPERS
// ----------------------
// There is no single source of truth any more. If the logic changes, update
// the block in ALL 12 functions, then run the drift check to confirm:
//
//   node scripts/check-edge-identity-drift.cjs
//
// It compares the parsed token stream of every copy, so prettier's line
// wrapping does not produce false positives, and a genuinely stale copy is
// reported as DRIFT. Run it after any edit to this block. The functions are:
//   admin-users, afa-registration, bulk-update-orders, cancel-admin-order,
//   dispatch-order, paystack-subaccount, reorder-held-agent-order,
//   super-agent-offers, super-agent-tier-management,
//   super-agent-user-management, verify-payment, verify-wallet-topup
//
// Requires `createClient` to be imported from "npm:@supabase/supabase-js@2".

type CanonicalRole = "admin" | "super_agent" | "sub_agent" | "normal_user";

interface Identity {
  id: string;
  role: CanonicalRole;
  superAgentId: string | null;
  email: string | null;
  /** True when the profile row was missing and the default was assumed. */
  profileMissing: boolean;
  /** Present only for display/audit. Never authorize on this. */
  displayName: string | null;
}

interface SupabaseClients {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  /** Client bound to the caller's token, used only for auth.getUser(). */
  authClient: ReturnType<typeof createClient>;
  /** Service-role client. Bypasses RLS - use for trusted reads/writes only. */
  admin: ReturnType<typeof createClient>;
}

/**
 * Canonical role vocabulary.
 *
 * The codebase historically mixed `admin`, `Admin`, `superagent`,
 * `super_agent`, `agent` and `sub_agent`, and compared them with `===` against
 * variously-cased values. That produced live authorization bugs in BOTH
 * directions. Everything funnels through here so there is exactly one spelling
 * to reason about.
 *
 * `normal_user` is a member in its own right, NOT an alias of `sub_agent`. It
 * previously WAS collapsed onto `sub_agent` here, which made every
 * `role === "sub_agent"` check unconditionally true for ordinary customers
 * and mis-routed their orders into `agent_orders`. Keep the two distinct.
 */
const normalizeRole = (value: unknown): CanonicalRole | null => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  switch (normalized) {
    case "admin":
    case "administrator":
    case "superadmin":
    case "super_admin":
      return "admin";
    case "superagent":
    case "super_agent":
      return "super_agent";
    case "agent":
    case "subagent":
    case "sub_agent":
      return "sub_agent";
    case "user":
    case "normal_user":
    case "normaluser":
      return "normal_user";
    default:
      return null;
  }
};

const identityIsAdmin = (identity: Identity) => identity.role === "admin";
const identityIsSuperAgent = (identity: Identity) =>
  identity.role === "super_agent";

/**
 * Creates the anon/auth clients. Kept separate from `resolveIdentity` so a
 * function can fail fast on missing configuration with its own error shape.
 */
const getSupabaseClients = (authorizationHeader: string): SupabaseClients => {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? anonKey;

  return {
    url,
    anonKey,
    serviceRoleKey,
    authClient: createClient(url, anonKey, {
      global: { headers: { Authorization: authorizationHeader } },
    }),
    admin: createClient(url, serviceRoleKey),
  };
};

/**
 * Resolves the caller's identity from the token, then overrides role and
 * ownership from `public.user_profiles`.
 *
 * WHY NOT user_metadata: that field is WRITABLE BY THE USER THEMSELVES via
 * `supabase.auth.updateUser({ data: { role: 'admin' }})`, which persisted the
 * value into `raw_user_meta_data`. Every function used to read role as
 * `user_metadata.role || app_metadata.role`, so the FIRST term was
 * attacker-controlled - self-service privilege escalation. `app_metadata` is
 * service-role-only and safe.
 *
 * Throws only when the token itself is invalid - which callers should turn into
 * a 401. A missing profile row is NOT an error; it resolves to `sub_agent` and
 * sets `profileMissing` so the caller can log the drift.
 */
const resolveIdentity = async (clients: SupabaseClients): Promise<Identity> => {
  const {
    data: { user },
    error,
  } = await clients.authClient.auth.getUser();

  if (error || !user) {
    throw new Error(error?.message || "Not authenticated");
  }

  const email = user.email ?? null;

  // Authoritative read. Uses the service-role client so the caller's own RLS
  // visibility cannot hide their own role from an authorization check.
  const { data: profile } = await clients.admin
    .from("user_profiles")
    .select("id, role, super_agent_id, full_name")
    .eq("id", user.id)
    .maybeSingle();

  const profileMissing = !profile;

  // Fallback for accounts created before the on_auth_user_created trigger, or
  // whose profile row was never created. `app_metadata` only.
  const roleFromAppMetadata = normalizeRole(user.app_metadata?.role);
  const role =
    normalizeRole(profile?.role) ??
    roleFromAppMetadata ??
    // Fail closed. `sub_agent` is the trigger's default and the least
    // privileged role, so an unknown user can only ever act on themselves.
    "sub_agent";

  // Ownership likewise comes from the profile. `user_metadata.super_agent_id`
  // is user-writable, so reading it would let a sub-agent re-point themselves
  // at another super agent and have their purchase debited from that wallet.
  const superAgentId =
    (profile?.super_agent_id as string | null | undefined) ??
    (typeof user.app_metadata?.super_agent_id === "string"
      ? user.app_metadata.super_agent_id
      : null) ??
    null;

  return {
    id: user.id,
    role,
    superAgentId,
    email,
    profileMissing,
    displayName:
      (profile?.full_name as string | null | undefined) ??
      user.user_metadata?.full_name ??
      null,
  };
};

/**
 * An order belongs to the caller when it is one of theirs. Admins bypass this.
 * Preserved verbatim from `dispatch-order`'s existing rule so this helper
 * changes only the SOURCE of role/ownership, not the semantics.
 */
const ownsResource = (
  identity: Identity,
  ownerId: string | null | undefined,
): boolean =>
  identityIsAdmin(identity) || (ownerId != null && ownerId === identity.id);

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
  const apiKey = Deno.env.get("JEHUCA_API_KEY");
  console.log(
    "[Reorder] Startup check - JEHUCA_API_KEY:",
    apiKey ? "configured" : "MISSING",
  );
  const appEnv = (Deno.env.get("APP_ENV") || "development")
    .toLowerCase()
    .trim();
  console.log("[Reorder] APP_ENV:", appEnv);
  if (!apiKey) {
    console.error(
      "[Reorder] JEHUCA_API_KEY is not configured in function secrets",
    );
    return respond({ error: "Provider API is not configured" }, 500);
  }

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

    // Role from `public.user_profiles`, not `user_metadata.role`. The old
    // check read the user-writable `user_metadata` first, so anyone could
    // declare themselves a Super Agent and retry (and be charged for) a held
    // order belonging to a real super agent.
    let identity;
    try {
      identity = await resolveIdentity(getSupabaseClients(authorization));
    } catch {
      return respond({ error: "Unauthorized" }, 401);
    }
    if (identity.profileMissing) {
      console.warn(
        "[Reorder] No user_profiles row; defaulted to sub_agent:",
        identity.id,
      );
    }
    if (!identityIsSuperAgent(identity)) {
      return respond({ error: "Super Agent role required" }, 403);
    }

    const { order_id: orderId } = await req.json();
    if (!orderId) return respond({ error: "order_id is required" }, 400);
    console.log("[Reorder] Starting order retry", {
      order_id: orderId,
      user_id: identity.id,
    });

    const { data: order, error: orderError } = await admin
      .from("agent_orders")
      .select("*")
      .eq("id", orderId)
      .eq("super_agent_id", identity.id)
      .eq("status", "held")
      .single();
    if (orderError || !order)
      return respond({ error: "Held order not found" }, 404);

    let providerPackageId = String(order.provider_package_id || "");
    const title = String(order.offer_title || "").toUpperCase();
    const inferredSize = Number(title.match(/(\d+(?:\.\d+)?)\s*GB/i)?.[1] || 0);
    let providerSize = Number(order.provider_size || inferredSize);
    let providerType = String(order.provider_type || "")
      .trim()
      .toUpperCase();
    let network = String(order.network || "")
      .trim()
      .toUpperCase();
    const baseAmount = Number(order.base_amount || 0);
    const phone = String(order.recipient_phone || "").replace(/\s+/g, "");

    const normalizeProviderType = (value: string) => {
      const normalized = value.trim().toUpperCase();
      if (normalized.includes("BIG TIME")) return "BIG TIME";
      if (normalized.includes("ISHARE")) return "ISHARE";
      return normalized.split(/[(-]/)[0].trim();
    };

    if (order.offer_id !== null && order.offer_id !== undefined) {
      const { data: localOffer, error: localOfferError } = await admin
        .from("super_agent_offers")
        .select("id, network, data_value")
        .eq("id", order.offer_id)
        .maybeSingle();

      if (localOfferError) {
        console.error(
          "[Reorder] Failed to load the original Super Agent offer:",
          localOfferError,
        );
      } else if (localOffer) {
        const descriptor = String(localOffer.data_value || "")
          .trim()
          .toUpperCase();
        const offerNetwork = String(localOffer.network || network)
          .trim()
          .toUpperCase();
        const catalogResponse = await fetch(
          "https://backend.jehucale-business.com/api/packages",
          { headers: { "X-API-Key": apiKey } },
        );
        const catalogPayload = await catalogResponse.json();
        const catalog = Array.isArray(catalogPayload?.payload)
          ? catalogPayload.payload
          : Array.isArray(catalogPayload)
            ? catalogPayload
            : [];
        const catalogMatch = catalog.find((item: any) => {
          const itemNetwork = String(item?.network || "")
            .trim()
            .toUpperCase();
          const itemType = String(item?.type || "")
            .trim()
            .toUpperCase();
          const itemSize = Number(item?.size || 0);
          const itemDescriptor = itemSize
            ? `${itemType}${itemType.includes(`${itemSize}GB`) ? "" : ` - ${itemSize}GB`}`
            : itemType;
          return (
            itemNetwork === offerNetwork &&
            (itemDescriptor === descriptor ||
              String(item?.id || "").toUpperCase() === descriptor)
          );
        });

        if (catalogMatch) {
          providerPackageId = String(catalogMatch.id || "");
          providerType = normalizeProviderType(
            String(catalogMatch.type || providerType),
          );
          providerSize = Number(catalogMatch.size || providerSize);
          network = offerNetwork;
        } else {
          // Older orders sometimes stored the local Super Agent offer ID in
          // provider_package_id. Never send that local ID to Jehuca.
          providerPackageId = "";
        }
      }
    }

    if (!providerPackageId || !providerSize || !providerType || !phone) {
      const { data: pricingRows, error: pricingError } = await admin
        .from("package_pricing")
        .select("package_id, network, type, size, base_price")
        .eq("is_active", true)
        .ilike("network", network);

      if (pricingError) {
        console.error(
          "[Reorder] Failed to load package pricing:",
          pricingError,
        );
      }

      const pricingMatch = (pricingRows || []).find((row) => {
        const rowSize = Number(
          row.size ||
            String(row.type || "").match(/(\d+(?:\.\d+)?)\s*GB/i)?.[1] ||
            0,
        );
        const sameSize = Math.abs(rowSize - providerSize) <= 0.01;
        const sameBase =
          !Number.isFinite(baseAmount) ||
          baseAmount <= 0 ||
          Math.abs(Number(row.base_price || 0) - baseAmount) <= 0.01;
        return sameSize && sameBase;
      });

      if (pricingMatch) {
        providerPackageId = String(pricingMatch.package_id || "");
        providerSize =
          Number(
            pricingMatch.size ||
              String(pricingMatch.type || "").match(
                /(\d+(?:\.\d+)?)\s*GB/i,
              )?.[1] ||
              providerSize,
          ) || providerSize;
        providerType = normalizeProviderType(
          String(pricingMatch.type || providerType),
        );
      }
    }

    if (!providerPackageId) {
      const catalogResponse = await fetch(
        "https://backend.jehucale-business.com/api/packages",
        { headers: { "X-API-Key": apiKey } },
      );
      const catalogPayload = await catalogResponse.json();
      const catalog = Array.isArray(catalogPayload?.payload)
        ? catalogPayload.payload
        : Array.isArray(catalogPayload)
          ? catalogPayload
          : [];
      const catalogMatch = catalog.find((item: any) => {
        const sameNetwork =
          String(item?.network || "")
            .trim()
            .toUpperCase() === network;
        const sameSize =
          Math.abs(Number(item?.size || 0) - providerSize) <= 0.01;
        const catalogBase = Number(item?.price || 0) / 100;
        const sameBase =
          !Number.isFinite(baseAmount) ||
          baseAmount <= 0 ||
          Math.abs(catalogBase - baseAmount) <= 0.01;
        return sameNetwork && sameSize && sameBase;
      });

      if (catalogMatch) {
        providerPackageId = String(catalogMatch.id || "");
        providerType = normalizeProviderType(
          String(catalogMatch.type || providerType),
        );
        providerSize = Number(catalogMatch.size || providerSize);
      }
    }

    if (providerType) providerType = normalizeProviderType(providerType);
    const providerSizeInMilliGb = Math.round(providerSize * 1000);
    console.log("[Reorder] Provider package resolved:", {
      order_id: order.id,
      provider_package_id: providerPackageId,
      provider_type: providerType,
      provider_size_gb: providerSize,
      provider_size_milli_gb: providerSizeInMilliGb,
      network,
      phone,
    });
    if (!providerPackageId || !providerSize || !providerType || !phone) {
      return respond(
        {
          error: "Held order is missing provider package details",
          details: {
            provider_package_id: providerPackageId,
            provider_size: providerSize,
            provider_type: providerType,
            recipient_phone: phone,
          },
        },
        400,
      );
    }

    const debitReference = `agent-order-retry-${order.id}`;
    const walletDebitAmount = Number(order.base_amount || 0);
    if (!Number.isFinite(walletDebitAmount) || walletDebitAmount <= 0) {
      return respond(
        { error: "Held order has no valid wallet debit amount" },
        400,
      );
    }
    console.log("[Reorder] Debiting Super Agent wallet", {
      order_id: order.id,
      amount: Number(order.base_amount || 0),
    });
    const { data: debit, error: debitError } = await admin.rpc(
      "debit_super_agent_wallet",
      {
        p_super_agent_id: user.id,
        p_amount: Number(order.base_amount || 0),
        p_reference: debitReference,
        p_order_id: order.id,
        p_reason: "held_agent_order_retry",
      },
    );
    if (debitError || !debit?.success) {
      return respond(
        {
          error: "Insufficient wallet balance",
          reason: debit?.reason,
          balance: debit?.balance,
          required: debit?.required,
        },
        400,
      );
    }

    const providerResponse = await fetch(
      "https://backend.jehucale-business.com/api/orders",
      {
        method: "POST",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          packages: [
            {
              packageId: providerPackageId,
              size: providerSizeInMilliGb,
              network: String(order.network || "").toUpperCase(),
              type: providerType,
              phone,
            },
          ],
        }),
      },
    );
    const providerData = await providerResponse.json();
    const accepted = providerResponse.ok && providerData?.status === true;
    console.log("[Reorder] Provider response", {
      order_id: order.id,
      http_status: providerResponse.status,
      accepted,
      provider_status: providerData?.status,
      message: providerData?.message,
    });
    if (!accepted) {
      await admin.rpc("credit_super_agent_wallet", {
        p_super_agent_id: user.id,
        p_amount: Number(order.base_amount || 0),
        p_reference: `wallet-refund-${order.id}`,
        p_reason: "held_agent_order_provider_failed",
        p_metadata: { order_id: order.id },
      });
      return respond(
        { error: "Provider order failed", details: providerData },
        502,
      );
    }

    const providerOrderId =
      providerData?.payload?.orderId ||
      providerData?.payload?.orders?.[0]?.id ||
      null;
    const providerStatus =
      providerData?.payload?.orders?.[0]?.status ||
      providerData?.status ||
      "accepted";
    const { error: orderUpdateError } = await admin
      .from("agent_orders")
      .update({
        status: "pending",
        transaction_status: "success",
        jehuca_order_id: providerOrderId,
        jehuca_order_status: providerStatus,
        jehuca_response: providerData,
        settlement_status: "settled",
      })
      .eq("id", order.id);
    if (orderUpdateError) {
      console.error("[Reorder] agent_orders update failed:", orderUpdateError);
    }

    const { error: ledgerUpdateError } = await admin
      .from("payment_transactions")
      .update({
        status: "success",
        jehuca_order_id: providerOrderId,
        jehuca_order_status: providerStatus,
        jehuca_response: providerData,
        settlement_status: "settled",
      })
      .eq("order_id", order.id)
      .eq("order_type", "agent");
    if (ledgerUpdateError) {
      console.error(
        "[Reorder] payment_transactions update failed:",
        ledgerUpdateError,
      );
    }

    return respond({
      success: true,
      order_id: order.id,
      provider_order_id: providerOrderId,
      wallet: debit,
    });
  } catch (error) {
    console.error("Held order retry failed:", error);
    return respond(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});
