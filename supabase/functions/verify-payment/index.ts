import { createClient } from "npm:@supabase/supabase-js@2";

// ---- PAYSTACK KEY RESOLUTION - INLINED, DUPLICATED ON PURPOSE ----------
// Supabase edge function secrets are PROJECT-WIDE, so `verify-payment` and
// `verify-payment-test` would otherwise read the same PAYSTACK_SECRET_KEY.
// The only per-function signal available at runtime is the request URL, which
// is https://<ref>.supabase.co/functions/v1/<deployed-name>.
//
// Do not import this from a shared module: the dashboard's "Deploy with
// upload file" bundles only the selected function folder and would fail to
// resolve a relative import. See the IDENTITY HELPERS block below.
// ---------------------------------------------------------------------------
function resolvePaystackKeys(req: Request) {
  let deployedName = "";
  try {
    const path = new URL(req.url).pathname;
    deployedName = path.split("/").filter(Boolean).pop() || "";
  } catch {
    deployedName = "";
  }
  const isTest = deployedName.endsWith("-test");
  return {
    isTest,
    keySet: (isTest ? "test" : "production") as "test" | "production",
    secret:
      Deno.env.get(
        isTest ? "TEST_PAYSTACK_SECRET_KEY" : "PAYSTACK_SECRET_KEY",
      ) || null,
    publicKey:
      Deno.env.get(
        isTest ? "TEST_PAYSTACK_PUBLIC_KEY" : "PAYSTACK_PUBLIC_KEY",
      ) || null,
  };
}

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

const JEHUCA_PACKAGES_URL =
  "https://backend.jehucale-business.com/api/packages";

/**
 * Looks up the live provider price for a package from the Jehuca catalog.
 *
 * This is deliberately fetched server-side rather than trusted from the client:
 * the API cost snapshot decides what the business is recorded as paying, so a
 * tampered client must not be able to inflate or deflate it.
 *
 * Returns the price in MAJOR units (the provider reports pesewas, e.g. 500 for
 * Ghc 5.00) or null when the catalog is unreachable / the package is missing.
 */
const fetchProviderPrice = async (packageId?: string | null) => {
  const id = String(packageId || "").trim();
  if (!id) return null;

  const apiKey = Deno.env.get("JEHUCA_API_KEY");
  if (!apiKey) return null;

  try {
    const response = await fetch(JEHUCA_PACKAGES_URL, {
      method: "GET",
      headers: { "X-API-Key": apiKey },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const list = Array.isArray(payload?.payload)
      ? payload.payload
      : Array.isArray(payload)
        ? payload
        : [];
    const match = list.find(
      (p: { id?: string | number }) => String(p?.id ?? "") === id,
    );
    const raw = Number(match?.price);
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Number((raw / 100).toFixed(2));
  } catch (error) {
    console.warn("[resolve-api-cost] provider catalog lookup failed:", error);
    return null;
  }
};

/**
 * Resolves and snapshots the effective provider cost for an order.
 *
 * Never throws: if the tier lookup fails we return nulls so a paid order is
 * still created and dispatch-order's own guard handles the missing cost.
 */
const resolveOrderApiCost = async (
  client: ReturnType<typeof createClient>,
  {
    audience,
    network,
    type,
    packageId,
    fallback,
  }: {
    audience: "super_agent" | "normal_user";
    network: string;
    type: string;
    packageId?: string | null;
    fallback: number;
  },
) => {
  try {
    const { data, error } = await client.rpc("resolve_api_cost", {
      p_audience: audience,
      p_network: network,
      p_type: type,
      p_package_id: packageId || null,
      p_live_cost: await fetchProviderPrice(packageId),
      p_fallback: fallback,
    });
    if (error) throw error;

    const cost = Number(data?.[0]?.api_cost);
    return {
      apiCost: Number.isFinite(cost) ? Number(cost.toFixed(2)) : null,
      costSource: String(data?.[0]?.cost_source || "fallback"),
      discount: Number(data?.[0]?.discount || 0),
    };
  } catch (error) {
    console.error("[resolve-api-cost] failed:", error);
    return { apiCost: null, costSource: "fallback", discount: 0 };
  }
};

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Initialize Supabase clients
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? supabaseAnonKey;

    // Get and validate Authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.error("Missing Authorization header");
      return new Response(
        JSON.stringify({ error: "Missing authorization token" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Client for user authentication
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    // Client for admin operations (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Get the current user
    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser();

    console.log("User authentication result:", {
      userId: user?.id,
      userEmail: user?.email,
      authError: authError?.message,
    });

    if (authError || !user) {
      console.error("User authentication failed:", authError);
      return new Response(
        JSON.stringify({
          error: "Unauthorized",
          details: authError?.message || "User not authenticated",
        }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Role and super-agent ownership now resolve from `public.user_profiles`
    // via the shared resolver. `user.user_metadata` is writable by the user
    // through `supabase.auth.updateUser`, so the previous reads of
    // `user_metadata.role` and `user_metadata.super_agent_id` were
    // attacker-controlled: a sub-agent could grant themselves a role, or
    // re-point `super_agent_id` at a richer super agent and have their
    // purchase debited from that wallet.
    const identity = await resolveIdentity({
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
      serviceRoleKey: supabaseServiceRoleKey,
      authClient: supabaseAuth,
      admin: supabaseAdmin,
    });

    if (identity.profileMissing) {
      console.warn(
        "[verify-payment] No user_profiles row; defaulted to sub_agent:",
        identity.id,
      );
    }

    const {
      reference,
      offer_id,
      provider_package_id,
      wallet_order,
      package_name,
      package_size,
      package_type,
      provider_type,
      provider_size,
      recipient_phone,
      amount,
      base_price,
      tier_extra,
      transaction_fee,
      network,
      super_agent_id,
    } = await req.json();

    console.log("Received request with params:", {
      reference,
      offer_id,
      recipient_phone,
      amount,
      network,
      super_agent_id,
    });

    // -------------------------------------------------------------------------
    // Replay guard
    // -------------------------------------------------------------------------
    // `reference` is client-supplied and every downstream effect is keyed on
    // it, so a repeated call re-runs the same debit and inserts a second
    // order. Two real consequences: the wallet path calls
    // `debit_super_agent_wallet` on every invocation (a replay debits twice
    // for one purchase), and the Paystack path creates a second order row
    // that is independently dispatchable (a replay buys data twice).
    //
    // Migration 20260926_008 adds partial UNIQUE indexes on
    // orders/agent_orders.payment_reference, so the database is the final
    // arbiter and concurrent replays cannot both win. This check is the fast
    // path that returns the ORIGINAL order instead of a raw 500 from a
    // constraint violation - so a double-tap is harmless rather than alarming.
    const normalizedReference = String(reference || "").trim();
    if (normalizedReference) {
      const { data: existing } = await supabaseAdmin
        .from("orders")
        .select("id, status, jehuca_order_id")
        .eq("payment_reference", normalizedReference)
        .maybeSingle();

      if (existing) {
        return new Response(
          JSON.stringify({
            success: true,
            duplicate: true,
            already_processed: true,
            is_agent_order: false,
            order: existing,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { data: existingAgent } = await supabaseAdmin
        .from("agent_orders")
        .select("id, status, jehuca_order_id")
        .eq("payment_reference", normalizedReference)
        .maybeSingle();

      if (existingAgent) {
        return new Response(
          JSON.stringify({
            success: true,
            duplicate: true,
            already_processed: true,
            is_agent_order: true,
            order: existingAgent,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    if (wallet_order) {
      // Server-authoritative role from `user_profiles`, not `user_metadata`.
      // The old check read `user.user_metadata?.role` first, and that field is
      // writable by the user via `supabase.auth.updateUser` - so a sub-agent
      // could set role='superagent' in their own metadata and then use the
      // wallet path, which debits a wallet by `p_super_agent_id => user.id`.
      const isSuperAgent = identity.role === "super_agent";
      const walletAmount = Number(amount);

      if (!isSuperAgent) {
        return new Response(
          JSON.stringify({ error: "Super Agent role required" }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      if (
        !reference ||
        !offer_id ||
        !Number.isFinite(walletAmount) ||
        walletAmount <= 0
      ) {
        return new Response(
          JSON.stringify({ error: "Missing or invalid wallet order fields" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // Pre-flight balance check - WHY THIS IS HERE
      // ------------------------------------------
      // Previously the wallet was debited AFTER the `orders` row was inserted,
      // and a failed debit simply flipped the row to `status='held'`. That
      // produced a held order on EVERY wallet purchase the super agent could
      // not immediately afford - which is a self-inflicted wound: the money
      // never left their balance, yet the order became an abandoned, expiring
      // record that only a "Reorder" tap could rescue.
      //
      // Rejecting up front is strictly better: nothing is created, nothing is
      // held, and the super agent gets an honest "fund your wallet" message
      // instead of an order that looks like it is in flight for 24 hours.
      //
      // This is a CHECK, not the debit. The authoritative `debit_super_agent_wallet`
      // still runs later and still holds the row lock, so a concurrent purchase
      // cannot slip past this read. The only cost of the race is that the
      // authoritative debit can still fail after this passes - which is exactly
      // the case the held path exists for.
      const { data: walletRow, error: walletReadError } = await supabaseAdmin
        .from("super_agent_wallets")
        .select("balance")
        .eq("super_agent_id", identity.id)
        .maybeSingle();

      if (walletReadError) {
        // Fail CLOSED. Proceeding on a read error would create the held order
        // this check exists to prevent.
        console.error(
          "[verify-payment] Could not read wallet for pre-flight check:",
          walletReadError,
        );
        return new Response(
          JSON.stringify({
            error: "Could not verify your wallet balance. Please try again.",
          }),
          {
            status: 503,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const availableBalance = Number(walletRow?.balance || 0);
      if (availableBalance < walletAmount) {
        console.warn("[verify-payment] Wallet pre-flight rejected order:", {
          user_id: identity.id,
          balance: availableBalance,
          required: walletAmount,
        });
        return new Response(
          JSON.stringify({
            error: "Insufficient wallet balance",
            insufficient_balance: true,
            balance: availableBalance,
            required: walletAmount,
            shortfall: Number((walletAmount - availableBalance).toFixed(2)),
          }),
          {
            // 402 Payment Required. Distinct from 400 so the client can tell
            // "you cannot afford this" from "your request was malformed".
            status: 402,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const normalizedSize = String(package_size || "").trim();
      const orderNetwork = String(network || "Unknown").toUpperCase();
      const orderTitle = normalizedSize
        ? `${orderNetwork} - ${normalizedSize} Data Bundle`
        : package_name || `${orderNetwork} Data Bundle`;
      const recipientPhone =
        recipient_phone || user.user_metadata?.phone || null;

      // Provider identity for this wallet order.
      //
      // These MUST be persisted: `dispatch-order` rejects any order that is
      // missing a package id, size or type, and it does so BEFORE it contacts
      // the provider. An order without them can never be delivered, yet the
      // wallet has already been debited - so the customer pays for nothing and
      // no error surfaces. The client sends these for the Paystack path; the
      // wallet path was the gap.
      const walletProviderPackageId = String(
        provider_package_id || offer_id || "",
      ).trim();
      const walletProviderType = String(
        provider_type || package_type || package_name || "",
      )
        .trim()
        .toUpperCase();
      let walletProviderSize = Number(provider_size || 0);
      if (!Number.isFinite(walletProviderSize) || walletProviderSize <= 0) {
        walletProviderSize = Number(
          normalizedSize.match(/(\d+(?:\.\d+)?)/)?.[1] || 0,
        );
      }

      const orderData = {
        user_id: user.id,
        user_name:
          user.user_metadata?.full_name ||
          user.email?.split("@")[0] ||
          "Unknown",
        user_email: user.email,
        phone: recipientPhone,
        offer_title: orderTitle,
        amount: walletAmount,
        network: orderNetwork,
        status: "pending",
        payment_reference: reference,
        is_self: recipientPhone === (user.user_metadata?.phone || ""),
        data_amount: orderTitle,
        buyer_type: "super_agent",
        // Deliberately null: the local offer FK must not be given an unrelated
        // provider package id. The provider identity lives in the three
        // provider_* columns instead.
        offer_id: null,
        provider_package_id: walletProviderPackageId || null,
        provider_type: walletProviderType || null,
        provider_size: walletProviderSize || null,
        device_token: null,
        country_code: "GH",
      };

      const walletOrderCost = await resolveOrderApiCost(supabaseAdmin, {
        audience: "super_agent",
        network: orderNetwork,
        type: walletProviderType || orderTitle,
        // Use the real provider package id so the live catalog price can be
        // fetched. Falling back to `offer_id` here (a local offer row id) would
        // silently resolve no live price and leave api_cost as the gross sale
        // amount, which under-states nothing but over-states the cost the
        // platform actually owes.
        packageId: walletProviderPackageId || null,
        fallback: walletAmount,
      });

      const { data: order, error: orderError } = await supabaseAdmin
        .from("orders")
        .insert({
          ...orderData,
          // A wallet order is a super-agent purchase, so it resolves against
          // the super_agent discount tier. Snapshotted here because this order
          // is created before the Paystack path's cost resolution runs.
          api_cost: walletOrderCost.apiCost,
          cost_source: walletOrderCost.costSource,
        })
        .select()
        .single();
      if (orderError) {
        console.error("Wallet order creation failed:", orderError);
        return new Response(
          JSON.stringify({
            error: "Failed to create wallet order",
            details: orderError,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data: debitResult, error: debitError } = await supabaseAdmin.rpc(
        "debit_super_agent_wallet",
        {
          p_super_agent_id: user.id,
          p_amount: walletAmount,
          p_reference: `wallet-order-${reference}`,
          p_order_id: order.id,
          p_reason: "super_agent_package_purchase",
        },
      );
      if (debitError || !debitResult?.success) {
        await supabaseAdmin
          .from("orders")
          .update({ status: "held" })
          .eq("id", order.id);
        return new Response(
          JSON.stringify({
            success: true,
            held: true,
            reason: debitResult?.reason || "wallet_debit_failed",
            balance: debitResult?.balance,
            required: debitResult?.required || walletAmount,
            order,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { error: transactionError } = await supabaseAdmin
        .from("payment_transactions")
        .insert({
          user_id: user.id,
          order_id: order.id,
          order_type: "regular",
          payment_reference: reference,
          buyer_type: "super_agent",
          gross_amount: walletAmount,
          base_amount: Number(base_price || walletAmount),
          transaction_fee: Number(transaction_fee || 0),
          main_account_amount: walletAmount,
          settlement_status: "settled",
          status: "success",
          network: orderNetwork,
          offer_title: orderTitle,
          recipient_phone: recipientPhone,
        });
      if (transactionError) {
        console.error(
          "Wallet transaction ledger insert failed:",
          transactionError,
        );
        return new Response(
          JSON.stringify({
            error: "Wallet debited but ledger creation failed",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          held: false,
          order,
          wallet: debitResult,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!reference || !offer_id) {
      console.error("Missing required fields:", { reference, offer_id });
      return new Response(
        JSON.stringify({
          error: "Missing required fields: reference and offer_id",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Verify payment with Paystack
    const paystackKeys = resolvePaystackKeys(req);
    const paystackSecret = paystackKeys.secret;
    if (!paystackSecret) {
      console.error(
        `Paystack secret not configured (keySet=${paystackKeys.keySet}). Set ${
          paystackKeys.isTest
            ? "TEST_PAYSTACK_SECRET_KEY"
            : "PAYSTACK_SECRET_KEY"
        } in edge function secrets.`,
      );
      return new Response(
        JSON.stringify({ error: "Payment service not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Verify the payment with Paystack
    console.log("Verifying payment with Paystack for reference:", reference);
    const verifyResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${paystackSecret}`,
          "Content-Type": "application/json",
        },
      },
    );

    const verifyData = await verifyResponse.json();
    console.log("Paystack verification response:", verifyData);
    console.log("Payment channel:", verifyData.data?.channel);
    console.log("Payment bank:", verifyData.data?.authorization?.bank);

    if (
      !verifyResponse.ok ||
      verifyData.status !== true ||
      verifyData.data.status !== "success"
    ) {
      console.error("Payment verification failed:", verifyData);
      return new Response(
        JSON.stringify({
          error: "Payment verification failed",
          details: verifyData,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Get offer details from the database.
    // Prefer the normal offers table for the current production schema,
    // but support a super-agent offer table if it has been added.
    console.log("Fetching offer with ID:", offer_id);
    let offer = null;
    let offerError = null;

    const offerQueries = [
      { table: "offers", select: "*" },
      { table: "super_agent_offers", select: "*, super_agent_id" },
    ];

    for (const query of offerQueries) {
      try {
        const { data, error } = await supabaseAdmin
          .from(query.table)
          .select(query.select)
          .eq("id", offer_id)
          .single();

        if (!error && data) {
          offer = data;
          offerError = null;
          break;
        }

        if (error && error.code !== "PGRST116") {
          offerError = error;
        }
      } catch (queryError) {
        console.log(`Query for ${query.table} failed:`, queryError);
      }
    }

    console.log("Offer query result:", { offer, offerError });

    if (!offer) {
      console.error("Offer not found:", offerError);
      console.log("Proceeding with frontend-provided data");
    }

    // Check if order already exists for this reference
    const { data: existingOrders } = await supabaseAdmin
      .from("orders")
      .select("id")
      .eq("payment_reference", reference);

    if (existingOrders && existingOrders.length > 0) {
      return new Response(
        JSON.stringify({ error: "Order already exists for this payment" }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Create the order with data from both the payment verification and the offer
    const isSelfPurchase =
      !recipient_phone || recipient_phone === (user.user_metadata?.phone || "");

    // Use offer data if available, otherwise use the provided amount and network
    const orderAmount = Number(
      amount || offer?.price || verifyData.data.amount / 100,
    );
    const chargedAmount = Number(verifyData.data.amount || 0) / 100;
    if (Math.abs(chargedAmount - orderAmount) > 0.01) {
      return new Response(
        JSON.stringify({
          error: "Payment amount does not match the order",
          expected: orderAmount,
          received: chargedAmount,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const orderNetwork = offer?.network || network || "Unknown";
    const normalizedPackageSize = String(package_size || "")
      .trim()
      .replace(/\s+/g, " ");
    const orderTitle =
      offer?.title ||
      (normalizedPackageSize
        ? `${orderNetwork} - ${normalizedPackageSize} Data Bundle`
        : package_name || `${orderNetwork} Data Bundle`);
    const localOfferId = offer?.id ? Number(offer.id) : null;

    console.log("Resolved local offer reference:", {
      requestedOfferId: offer_id,
      localOfferId,
      hasLocalOffer: Boolean(offer),
    });

    // Ownership from the authoritative profile, never from user metadata.
    //
    // The previous chain began with `user.user_metadata.super_agent_id`,
    // which the user can overwrite themselves. That let a sub-agent point
    // themselves at a different super agent, so `debit_super_agent_wallet`
    // would take the money from THAT agent's wallet to fund the sub-agent's
    // own purchase. `user_profiles.super_agent_id` is server-managed and
    // only admins write it.
    const userRole = identity.role;
    const resolvedSuperAgentId = identity.superAgentId;
    const isSubAgentOrder = Boolean(resolvedSuperAgentId);

    // Resolve the Paystack subaccount linked to the super agent (if any)
    // so the order and settlement can be traced back to where the funds were routed.
    let resolvedSubaccountCode: string | null = null;
    if (resolvedSuperAgentId) {
      try {
        const { data: subaccountRow } = await supabaseAdmin
          .from("super_agent_paystack")
          .select("subaccount_code, is_active")
          .eq("super_agent_id", resolvedSuperAgentId)
          .maybeSingle();

        if (subaccountRow?.is_active && subaccountRow.subaccount_code) {
          resolvedSubaccountCode = subaccountRow.subaccount_code;
        }
      } catch (subaccountError) {
        console.warn(
          "Could not resolve super-agent subaccount, continuing without it:",
          subaccountError,
        );
      }
    }

    // Paystack returns the subaccount it charged through on the transaction
    // object. Prefer that as the source of truth, then fall back to our DB record.
    const paystackSubaccountCode =
      verifyData.data?.subaccount?.subaccount_code ||
      verifyData.data?.subaccount_code ||
      resolvedSubaccountCode ||
      null;

    if (isSubAgentOrder && !paystackSubaccountCode) {
      return new Response(
        JSON.stringify({
          error: "Super Agent Paystack subaccount is not available",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: chargeSettings } = await supabaseAdmin
      .from("payment_charge_settings")
      .select("super_agent_percent")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const superAgentChargePercent = Number(
      chargeSettings?.super_agent_percent ?? 1.95,
    );

    const settlement = (() => {
      const gross = Number(orderAmount || 0);
      const requestedBase = Number(base_price);
      const requestedTierExtra = Number(tier_extra);
      const requestedTransactionFee = Number(transaction_fee);
      const hasPaymentSplit =
        Boolean(resolvedSuperAgentId) &&
        Number.isFinite(requestedBase) &&
        Number.isFinite(requestedTierExtra) &&
        requestedBase >= 0 &&
        requestedTierExtra >= 0 &&
        requestedTransactionFee >= 0 &&
        Math.abs(
          requestedBase + requestedTierExtra + requestedTransactionFee - gross,
        ) <= 0.01 &&
        Math.abs(
          requestedTransactionFee -
            requestedBase * (superAgentChargePercent / 100),
        ) <= 0.01;

      if (hasPaymentSplit) {
        return {
          adminShare: Number(requestedTransactionFee.toFixed(2)),
          superAgentShare: Number(
            (requestedBase + requestedTierExtra).toFixed(2),
          ),
          agentNet: 0,
          baseAmount: Number(requestedBase.toFixed(2)),
          agentMarkup: Number(requestedTierExtra.toFixed(2)),
          transactionFee: Number(requestedTransactionFee.toFixed(2)),
        };
      }

      const adminShareRate = 0.3;
      const superAgentShareRate = 0.2;
      const adminShare = Number((gross * adminShareRate).toFixed(2));
      const superAgentShare = Number((gross * superAgentShareRate).toFixed(2));
      const agentNet = Number(
        (gross - adminShare - superAgentShare).toFixed(2),
      );

      return {
        adminShare,
        superAgentShare,
        agentNet,
        baseAmount: Number(gross.toFixed(2)),
        agentMarkup: 0,
        transactionFee: 0,
      };
    })();

    const requestedBase = Number(base_price);
    const requestedTierExtra = Number(tier_extra);
    const requestedTransactionFee = Number(transaction_fee);
    const hasConfiguredSubAgentSplit =
      Boolean(resolvedSuperAgentId) &&
      Number.isFinite(requestedBase) &&
      Number.isFinite(requestedTierExtra) &&
      Number.isFinite(requestedTransactionFee) &&
      requestedBase >= 0 &&
      requestedTierExtra >= 0 &&
      requestedTransactionFee >= 0 &&
      Math.abs(
        requestedBase +
          requestedTierExtra +
          requestedTransactionFee -
          orderAmount,
      ) <= 0.01 &&
      Math.abs(
        requestedTransactionFee -
          requestedBase * (superAgentChargePercent / 100),
      ) <= 0.01;

    if (isSubAgentOrder && !hasConfiguredSubAgentSplit) {
      return new Response(
        JSON.stringify({
          error: "Invalid sub-agent settlement breakdown",
          details: {
            base_price,
            tier_extra,
            transaction_fee,
            amount: orderAmount,
            super_agent_charge_percent: superAgentChargePercent,
          },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Whether this purchase goes to `agent_orders` (the settlement-split
    // table) rather than `orders`.
    //
    // An earlier version of the second term compared a raw, un-cased
    // `user_metadata.role` against the literal "Agent". That read was both
    // user-writable and case-brittle: it missed "agent"/"sub_agent"/"Agent"
    // spellings depending on how the account was created, so an agent with no
    // assigned super agent could have their order written to the wrong table
    // and silently lose the settlement split. `sub_agent` is the normalized
    // spelling of both "agent" and "sub_agent".
    //
    // The inlined `normalizeRole` USED to collapse "normal_user" and "user"
    // onto "sub_agent" as well, which made this second term unconditionally
    // true and sent EVERY order in the platform - including ordinary
    // customers' - to `agent_orders` with `agent_id` set to the buyer's own id
    // and `buyer_type` = 'sub_agent'. `normalizeRole` now returns
    // "normal_user" for those spellings, so this gate excludes them as
    // intended. The rows the bad signup trigger had already mis-stamped are
    // repaired by migration 20260928_003.
    const isAgentOrder = Boolean(
      resolvedSuperAgentId || identity.role === "sub_agent",
    );
    const rawProviderType = String(
      provider_type || offer?.type || "",
    ).toUpperCase();
    const normalizedProviderType = rawProviderType.includes("BIG TIME")
      ? "BIG TIME"
      : rawProviderType.includes("ISHARE")
        ? "ISHARE"
        : rawProviderType.split(/[(-]/)[0].trim();
    const normalizedProviderSize = Number(
      provider_size ||
        normalizedPackageSize.match(/(\d+(?:\.\d+)?)\s*GB/i)?.[1] ||
        0,
    );

    // Resolve the TRUE provider cost (live Jehuca price minus any admin
    // discount) and snapshot it onto the order.
    //
    // A normal-user order has no settlement split, so `base_amount` is
    // currently set to the customer price. That makes analytics report a gross
    // profit of zero and lets the dispatch balance check under-check the funds
    // we actually need. Snapshotting the real cost fixes both.
    //
    // The audience is chosen by who is buying: a super agent buying on wallet
    // uses the super_agent pricing tier, everyone else the normal_user tier.
    const costAudience = resolvedSuperAgentId ? "super_agent" : "normal_user";
    const orderApiCost = await resolveOrderApiCost(supabaseAdmin, {
      audience: costAudience,
      network: orderNetwork,
      type: normalizedProviderType,
      packageId: provider_package_id || offer_id || null,
      // Last resort: an agent order's base_amount is already the provider cost,
      // and for a normal-user order the sale price bounds the cost.
      fallback: isAgentOrder ? settlement.baseAmount : Number(orderAmount || 0),
    });
    const apiCostSnapshot = orderApiCost.apiCost;
    const resolvedCostSource = orderApiCost.costSource;
    console.log("[resolve-api-cost] order cost resolved:", {
      audience: costAudience,
      apiCost: apiCostSnapshot,
      costSource: resolvedCostSource,
      discount: orderApiCost.discount,
    });

    const sharedOrderFields = {
      amount: orderAmount,
      network: orderNetwork,
      status: "pending",
      payment_reference: reference,
      paystack_transaction_id: verifyData.data.id.toString(),
      paystack_transaction_status: verifyData.data.status,
      paid_at: new Date(verifyData.data.paid_at).toISOString(),
      channel: verifyData.data.channel || null,
      bank: verifyData.data.authorization?.bank || null,
    };

    let order: any = null;
    let orderError: any = null;

    if (isAgentOrder) {
      // Sub-agent / super-agent path — use agent_orders so the settlement split
      // and super-agent chain survive the order lifecycle.
      const agentOrderData = {
        agent_id: user.id,
        offer_id: localOfferId,
        provider_package_id: String(provider_package_id || offer_id),
        provider_type: normalizedProviderType,
        provider_size: normalizedProviderSize,
        offer_title: orderTitle,
        network: orderNetwork,
        amount: orderAmount,
        recipient_phone: recipient_phone || user.user_metadata?.phone || null,
        // Agents buy on behalf of a recipient and no longer collect a name for
        // them, so this stays null rather than borrowing the buyer's own name.
        recipient_name: null,
        status: "pending",
        transaction_status: verifyData.data.status,
        // Persisted so the replay guard above can find this order, and so the
        // partial unique index from migration 20260926_008 can reject a
        // duplicate. Without this the column stays NULL, the guard's
        // agent_orders branch matches nothing, and a replayed call would debit
        // the super agent's wallet twice for a single purchase.
        payment_reference: reference,
        channel: sharedOrderFields.channel,
        device_token: null,
        buyer_type: "sub_agent",
        super_agent_id: resolvedSuperAgentId,
        admin_share: settlement.adminShare,
        super_agent_share: settlement.superAgentShare,
        agent_net: settlement.agentNet,
        base_amount: settlement.baseAmount,
        api_cost: apiCostSnapshot,
        cost_source: resolvedCostSource,
        agent_markup: settlement.agentMarkup,
        transaction_fee: settlement.transactionFee,
        main_account_amount: settlement.adminShare,
        settlement_status: "pending",
        paystack_subaccount_code: paystackSubaccountCode,
        paystack_transaction_id: sharedOrderFields.paystack_transaction_id,
        paystack_transaction_status:
          sharedOrderFields.paystack_transaction_status,
        paid_at: sharedOrderFields.paid_at,
        bank: sharedOrderFields.bank,
      };

      console.log("Creating agent_order with data:", agentOrderData);

      const { data, error } = await supabaseAdmin
        .from("agent_orders")
        .insert(agentOrderData)
        .select()
        .single();

      order = data;
      orderError = error;
    } else {
      const orderData = {
        user_id: user.id,
        user_name:
          user.user_metadata?.full_name ||
          user.email?.split("@")[0] ||
          "Unknown",
        user_email: user.email,
        phone: recipient_phone || user.user_metadata?.phone || null,
        offer_title: orderTitle,
        amount: orderAmount,
        network: orderNetwork,
        status: "pending",
        payment_reference: reference,
        is_self: isSelfPurchase,
        data_amount: orderTitle,
        buyer_type: "normal_user",
        // Normal-user package IDs come from Jehuca, not public.offers.
        // Keep this nullable unless a matching local offer was found so the
        // orders foreign key is not given an unrelated provider package ID.
        offer_id: localOfferId,
        // Persisted so the order can be dispatched to Jehuca later, including
        // from the admin retry action when the provider account was unfunded
        // at purchase time. Without these the provider request is not
        // reconstructable after the fact.
        provider_package_id: provider_package_id
          ? String(provider_package_id)
          : null,
        provider_type: normalizedProviderType || null,
        provider_size: normalizedProviderSize || null,
        base_amount: orderAmount,
        // The real provider cost, not the price the customer paid. Read back by
        // dispatch-order for its balance check and by analytics for margin.
        api_cost: apiCostSnapshot,
        cost_source: resolvedCostSource,
        paystack_transaction_id: sharedOrderFields.paystack_transaction_id,
        paystack_transaction_status:
          sharedOrderFields.paystack_transaction_status,
        paid_at: sharedOrderFields.paid_at,
        device_token: null,
        country_code: "GH", // Ghana
        channel: sharedOrderFields.channel,
        bank: sharedOrderFields.bank,
      };

      console.log("Creating order with data:", orderData);

      const { data, error } = await supabaseAdmin
        .from("orders")
        .insert(orderData)
        .select()
        .single();

      order = data;
      orderError = error;
    }

    if (orderError) {
      console.error("Order creation failed:", orderError);
      return new Response(
        JSON.stringify({
          error: "Failed to create order",
          details: orderError,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    let walletDebit: any = null;
    if (isSubAgentOrder) {
      const { data: debitResult, error: debitError } = await supabaseAdmin.rpc(
        "debit_super_agent_wallet",
        {
          p_super_agent_id: resolvedSuperAgentId,
          p_amount: settlement.baseAmount,
          p_reference: `agent-order-${order.id}`,
          p_order_id: order.id,
          p_reason: "sub_agent_order",
        },
      );

      walletDebit = debitResult;
      if (debitError || !debitResult?.success) {
        console.warn("Super Agent wallet debit held the order:", {
          debitError: debitError?.message,
          debitResult,
        });
        await supabaseAdmin
          .from("agent_orders")
          .update({
            status: "held",
            transaction_status: "wallet_insufficient",
            settlement_status: "pending",
          })
          .eq("id", order.id);
      }
    }

    // Optional: record settlement against the super-agent chain if the extended tables exist.
    // Only meaningful when the order is in agent_orders (i.e. when isAgentOrder is true).
    try {
      if (isAgentOrder && resolvedSuperAgentId) {
        const settlementInsert: Record<string, unknown> = {
          agent_order_id: order.id,
          agent_id: user.id,
          super_agent_id: resolvedSuperAgentId,
          admin_id: null,
          gross_amount: orderAmount,
          super_agent_share: settlement.superAgentShare,
          admin_share: settlement.adminShare,
          agent_net: settlement.agentNet,
          status: "pending",
        };

        if (paystackSubaccountCode) {
          // If the schema has been extended to record subaccount on the
          // settlement row it will be persisted; otherwise the column simply
          // doesn't exist and the insert succeeds without it.
          settlementInsert.paystack_subaccount_code = paystackSubaccountCode;
        }

        const { error: settlementError } = await supabaseAdmin
          .from("agent_payment_settlements")
          .insert(settlementInsert);

        if (settlementError) {
          // If the only issue is an unknown paystack_subaccount_code column,
          // retry without it so a fresh database without migration 004 still works.
          if (
            settlementError.code === "42703" &&
            /paystack_subaccount_code/.test(settlementError.message || "")
          ) {
            delete settlementInsert.paystack_subaccount_code;
            const { error: retryError } = await supabaseAdmin
              .from("agent_payment_settlements")
              .insert(settlementInsert);
            if (retryError) {
              console.warn(
                "Super-agent settlement insert (without subaccount) failed:",
                retryError.message,
              );
            } else {
              console.log("Settlement row created (without subaccount column)");
            }
          } else {
            console.warn(
              "Super-agent settlement table is unavailable or not migrated yet:",
              settlementError.message,
            );
          }
        } else {
          console.log(
            "Settlement row created successfully for super-agent split",
          );
        }
      }
    } catch (settlementCatchError) {
      console.warn(
        "Settlement creation skipped because extended tables are not available yet:",
        settlementCatchError,
      );
    }

    const { error: transactionError } = await supabaseAdmin
      .from("payment_transactions")
      .insert({
        user_id: user.id,
        order_id: order.id,
        order_type: isAgentOrder ? "agent" : "regular",
        payment_reference: reference,
        buyer_type: isAgentOrder ? "sub_agent" : "normal_user",
        paystack_transaction_id: sharedOrderFields.paystack_transaction_id,
        paystack_transaction_status:
          sharedOrderFields.paystack_transaction_status,
        gross_amount: orderAmount,
        base_amount: isAgentOrder ? settlement.baseAmount : orderAmount,
        agent_markup: settlement.agentMarkup,
        transaction_fee: settlement.transactionFee,
        main_account_amount: isAgentOrder ? settlement.adminShare : orderAmount,
        super_agent_amount: settlement.superAgentShare,
        agent_net: settlement.agentNet,
        super_agent_id: isAgentOrder ? resolvedSuperAgentId : null,
        settlement_status: isAgentOrder ? "pending" : "settled",
        status: isSubAgentOrder && !walletDebit?.success ? "held" : "success",
        network: orderNetwork,
        offer_title: orderTitle,
        recipient_phone: recipient_phone || user.user_metadata?.phone || null,
        channel: sharedOrderFields.channel,
        bank: sharedOrderFields.bank,
        paystack_subaccount_code: paystackSubaccountCode,
      });

    if (transactionError) {
      console.error(
        "Payment transaction ledger insert failed:",
        transactionError,
      );
      return new Response(
        JSON.stringify({
          error: "Payment recorded but transaction ledger failed",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Send notification to the user
    try {
      console.log("Sending push notification to user...");

      await supabaseAuth.functions.invoke("send-notification", {
        body: {
          userId: user.id,
          title: "Data Purchase Successful",
          message: `Your ${orderTitle} data bundle purchase has been confirmed and is being processed.`,
          type: "order",
        },
      });
    } catch (pushError) {
      console.error("Error sending push notification:", pushError);
    }

    // Send push notification to all admins about the new order
    try {
      console.log("Sending new order notification to admins...");

      // Use same method as user notifications (works with proper auth)
      const { data: notifyAdminsResult, error: notifyAdminsError } =
        await supabaseAuth.functions.invoke("send-notification", {
          body: {
            sendToAdmins: true,
            title: "New Order Received",
            message: `Order #${order.id} - ${orderTitle} for GHC ${orderAmount} from ${user.email}`,
            type: "order",
          },
        });

      if (notifyAdminsError) {
        console.error("Failed to notify admins:", notifyAdminsError);
      } else {
        console.log(
          "Admin notification sent successfully:",
          notifyAdminsResult,
        );
      }
    } catch (adminPushError) {
      console.error("Error sending admin notifications:", adminPushError);
      // Don't fail the request if admin notification fails
    }

    return new Response(
      JSON.stringify({
        success: true,
        order: order,
        is_agent_order: isAgentOrder,
        held: isSubAgentOrder && !walletDebit?.success,
        hold_reason:
          isSubAgentOrder && !walletDebit?.success
            ? walletDebit?.reason || "wallet_debit_failed"
            : null,
        super_agent_id: resolvedSuperAgentId,
        paystack_subaccount_code: paystackSubaccountCode,
        message: "Payment verified and order created successfully",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
