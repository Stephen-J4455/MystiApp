import { createClient } from "npm:@supabase/supabase-js@2";

// ---- PAYSTACK KEY RESOLUTION - INLINED, DUPLICATED ON PURPOSE ----------
// Supabase edge function secrets are PROJECT-WIDE, so `verify-wallet-topup` and
// `verify-wallet-topup-test` would otherwise read the same
// PAYSTACK_SECRET_KEY. The only per-function signal available at runtime is
// the request URL, which is
// https://<ref>.supabase.co/functions/v1/<deployed-name>.
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

  // Fail closed. `sub_agent` is the trigger's default and the least privileged
  // role, so an unknown user can only ever act on themselves.
  //
  // A NULL IN AN EXISTING PROFILE IS AN ANSWER, NOT A GAP
  // ---------------------------------------------------
  // `app_metadata` is consulted ONLY when there is NO profile row at all.
  //
  // The previous chain used `??` on `profile?.role`, which conflates "the
  // profile does not exist" with "the profile exists and this value is NULL".
  // Those are different facts, and conflating them is what let a demoted
  // account keep its old identity:
  //
  //   admin demotes Enterprise Super Agent -> Sub Agent, assigning no owner
  //   (a legitimate state - migration 20260928_003 exists precisely because an
  //   admin can set a role without picking an owner).
  //
  //   `user_profiles.super_agent_id` is then NULL. `??` read that as "no value,
  //   try the next source" and fell through to `app_metadata.super_agent_id`,
  //   which `admin-users.setUserRole` never clears - so it still held the id
  //   from before the promotion.
  //
  //   The purchase was then debited against the WRONG super agent's wallet and
  //   the buyer resolved as a Super Agent rather than the Sub Agent they are.
  //
  // A NULL in a row that EXISTS is authoritative and is honoured. The metadata
  // fallback is reserved for a genuinely absent row, where `profileMissing` is
  // already flagged for the console warning below.
  const role = profile
    ? (normalizeRole(profile.role) ?? "sub_agent")
    : (normalizeRole(user.app_metadata?.role) ?? "sub_agent");

  // Ownership comes from the profile, and the same rule applies.
  // `user_metadata.super_agent_id` is user-writable, so reading it would let a
  // sub-agent re-point themselves at another super agent and have their
  // purchase debited from that wallet.
  //
  // An ownerless sub agent resolving to null is CORRECT, and it is what callers
  // act on: `verify-payment`'s wallet branch returns 403 "You are not assigned
  // to a Super Agent" rather than spending from a stale owner's wallet.
  const superAgentId = profile
    ? ((profile.super_agent_id as string | null | undefined) ?? null)
    : typeof user.app_metadata?.super_agent_id === "string"
      ? user.app_metadata.super_agent_id
      : null;

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

// `wallet_topups` columns that a database may not have yet, because the
// migration that adds them has not been applied. None of them are required for
// the credit to be correct - they are provenance only - so a top-up whose
// payment already succeeded must never 500 just because bookkeeping is
// missing. The credit itself is idempotent via the RPC's p_reference.
const OPTIONAL_TOPUP_COLUMNS = [
  "paystack_subaccount_code",
  "charge_percent",
  "charge_amount",
  "gross_amount",
  // migration 20260928_007 - records who paid and whose wallet was funded
  "funder_user_id",
  "wallet_owner_id",
];

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

    // Server-authoritative role from `public.user_profiles`.
    const identity = await resolveIdentity({
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
      serviceRoleKey: supabaseServiceRoleKey,
      authClient: supabaseAuth,
      admin: supabaseAdmin,
    });
    if (identity.profileMissing) {
      console.warn(
        "[verify-wallet-topup] No user_profiles row; defaulted to sub_agent:",
        identity.id,
      );
    }

    const { reference } = await req.json();

    console.log("Received request with params:", {
      reference,
    });

    if (!reference) {
      console.error("Missing required fields:", { reference });
      return new Response(
        JSON.stringify({
          error: "Missing required field: reference",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Role and ownership from `public.user_profiles`, never from
    // `user_metadata`. The old read of `user.user_metadata?.role` was
    // self-assignable, so any authenticated user could claim Super Agent and
    // top up a wallet; and `user_metadata?.super_agent_id` could be re-pointed
    // at somebody else, mis-routing the settlement lookup below.
    //
    // WHO MAY FUND A WALLET
    // ---------------------
    // A Super Agent funds their own. A SUB-AGENT funds their assigned Super
    // Agent's wallet, which is the whole point of the mirror model: their money
    // becomes that agent's real balance and raises their own spending power by
    // the same figure.
    //
    // This gate used to be `identityIsSuperAgent(identity)` alone, admitting
    // only `role === "super_agent"`. That made EVERYTHING below it unreachable
    // for a sub-agent - `isSelfFundedSuperAgent`, the
    // `resolvedWalletOwnerId = identity.superAgentId` resolution, the double
    // credit on both sides of the mirror, and `funded_someone_else` /
    // `sub_agent_balance` in the response. The sub-agent implementation was
    // complete and dead: every sub-agent top-up returned 403 before reaching
    // it. It failed SILENTLY in the dashboard because this branch had no
    // `console.error`, so the log simply stopped after the request line.
    //
    // A sub-agent with NO `super_agent_id` is still refused, and refused HERE
    // rather than deeper in: that is the same case the handler returns 400 for
    // ("no wallet for this top-up to fund"), and their money genuinely has no
    // destination. Failing at the gate keeps that one answer in one place.
    //
    // A `normal_user` is still refused by omission: their `superAgentId` is
    // null, so the new arm cannot be satisfied. This is the check that
    // `WalletTopUpScreen` mirrors client-side, and the reason the client can
    // hide the entry without being the thing that enforces it.
    const canFundWallet =
      identityIsSuperAgent(identity) ||
      (identity.role === "sub_agent" && Boolean(identity.superAgentId));
    if (!canFundWallet) {
      console.error(
        "[verify-wallet-topup] Refused: role may not fund a wallet",
        {
          user_id: identity.id,
          role: identity.role,
          // Present-but-null is the diagnostic: it means a sub_agent with no
          // assignment, which is a data problem an admin can fix.
          super_agent_id: identity.superAgentId,
          profile_missing: identity.profileMissing,
        },
      );
      return new Response(
        JSON.stringify({
          error:
            identity.role === "sub_agent"
              ? "You are not assigned to a Super Agent, so there is no wallet for this top-up to fund."
              : "Only Super Agents can fund an operational wallet",
        }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Verify payment with Paystack. The key set is chosen from this
    // function's own deployed name, so `verify-wallet-topup-test` uses
    // TEST_PAYSTACK_SECRET_KEY and the unsuffixed function uses the live one.
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

    console.log(
      "[DEBUG] secret starts with:",
      paystackSecret ? paystackSecret.substring(0, 7) : "NONE",
    );
    console.log("[DEBUG] Reference:", reference, "| User:", user?.id);

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
    console.log(
      "[DEBUG] Paystack response ok:",
      verifyResponse.ok,
      "| status:",
      verifyData.status,
      "| data.status:",
      verifyData.data?.status,
    );

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

    // Check if wallet_topup exists for this reference
    const { data: existingTopup, error: topupError } = await supabaseAdmin
      .from("wallet_topups")
      .select("*")
      .eq("reference", reference)
      .single();

    console.log(
      "[DEBUG] Wallet topup found:",
      existingTopup ? "yes" : "no",
      "| agent_id:",
      existingTopup?.agent_id,
      "| user.id:",
      user.id,
      "| status:",
      existingTopup?.status,
    );

    if (topupError || !existingTopup) {
      console.error("Wallet topup not found:", topupError);
      return new Response(JSON.stringify({ error: "Wallet topup not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Ensure the topup belongs to the authenticated user
    if (existingTopup.agent_id !== user.id) {
      console.error("Unauthorized: topup does not belong to user");
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if already verified
    if (existingTopup.status === "success") {
      return new Response(
        JSON.stringify({ error: "Wallet topup already verified" }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // =========================================================================
    // AMOUNT VERIFICATION - WHY THIS EXISTS
    // =========================================================================
    // `wallet_topups.amount` is the NET figure the wallet should be credited,
    // written by the client BEFORE the Paystack redirect. The GROSS actually
    // charged (net + 1.95% Paystack charge) only ever existed in client state.
    //
    // Nothing here checked that Paystack's `data.amount` matched what was owed,
    // so the amount paid was never verified against the amount credited. A
    // caller could initialize a transaction for a token amount, redirect
    // Paystack to whatever they liked, and have `credit_super_agent_wallet`
    // credit the full recorded top-up anyway - the Paystack check that
    // `status === "success"` provides is about the payment SUCCEEDING, not
    // about it being the right size.
    //
    // The expected gross is therefore RECOMPUTED HERE from the authoritative
    // server-side rate, never taken from the request. Reading a client-supplied
    // expected amount would let the caller set the bar to whatever they had
    // actually paid.
    const { data: chargeSettings, error: chargeSettingsError } =
      await supabaseAdmin
        .from("payment_charge_settings")
        .select("wallet_topup_percent")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (chargeSettingsError) {
      // Fail closed. Guessing a rate here is what would let a mismatched
      // amount through, and the fallback below is the only reason this can
      // continue at all.
      console.error(
        "[verify-wallet-topup] Could not read charge settings:",
        chargeSettingsError,
      );
    }

    // Mirrors DEFAULT_PAYMENT_SETTINGS.walletTopUpPercent in
    // src/lib/paymentSettings.js. The client applies the same fallback.
    const topUpChargePercent = Number(
      chargeSettings?.wallet_topup_percent ?? 1.95,
    );

    const expectedNet = Number(existingTopup.amount || 0);
    if (!Number.isFinite(expectedNet) || expectedNet <= 0) {
      console.error(
        "[verify-wallet-topup] Recorded top-up amount is not a positive number:",
        existingTopup.amount,
      );
      return new Response(JSON.stringify({ error: "Invalid top-up amount" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Paystack reports in pesewas. Same order of operations as
    // getTransactionChargeAmount in src/lib/paymentSettings.js: fee on the
    // NET, then add it back, then round once at the end.
    const expectedFee = Number(
      ((expectedNet * topUpChargePercent) / 100).toFixed(2),
    );
    const expectedGross = Number((expectedNet + expectedFee).toFixed(2));
    const chargedGross = Number(verifyData.data.amount || 0) / 100;

    // 0.01 tolerance for float/rounding drift only - the fee itself is already
    // rounded to 2dp on both sides, so a real mismatch is far larger than this.
    if (Math.abs(chargedGross - expectedGross) > 0.01) {
      console.error("[verify-wallet-topup] Charged amount does not match:", {
        reference,
        recorded_net: expectedNet,
        expected_gross: expectedGross,
        charged_gross: chargedGross,
        charge_percent: topUpChargePercent,
      });
      return new Response(
        JSON.stringify({
          error: "Top-up amount does not match the payment received",
          expected: expectedGross,
          received: chargedGross,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    console.log("[verify-wallet-topup] Amount verified:", {
      reference,
      net: expectedNet,
      fee: expectedFee,
      gross: expectedGross,
      charged: chargedGross,
    });

    // Update wallet_topups
    const updateData: Record<string, unknown> = {
      status: "success",
      paystack_transaction_id: verifyData.data.id.toString(),
      paystack_transaction_status: verifyData.data.status,
      paid_at: new Date(verifyData.data.paid_at).toISOString(),
      channel: verifyData.data.channel || null,
      bank: verifyData.data.authorization?.bank || null,
      // Charge snapshot. Recorded so the platform can reconcile what Paystack
      // actually collected, and so the rate that applied is pinned at
      // settlement time - editing `payment_charge_settings` later must not
      // retroactively change the fee attributed to this top-up. Requires
      // migration 20260927_003; tolerated as absent below.
      gross_amount: expectedGross,
      charge_amount: expectedFee,
      charge_percent: topUpChargePercent,
    };

    // WHO FUNDS WHOSE WALLET
    // -----------------------
    // A Super Agent funding their own wallet owns it, so owner == payer. A
    // SUB-AGENT's top-up funds the SUPER AGENT they report to: the sub-agent
    // has no spendable wallet of their own, because `verify-payment` debits by
    // `p_super_agent_id => user.id` and their own row would never be touched.
    //
    // The previous code computed `resolvedSuperAgentId` here and then ignored
    // it, crediting `user.id` unconditionally. So a sub-agent's money settled
    // to their super agent's Paystack SUB-ACCOUNT but was credited to a wallet
    // row keyed on the sub-agent - a row no order ever debits. Reconciling a
    // settlement against that is how money goes missing at month end.
    //
    // Ownership comes from `user_profiles.super_agent_id`, the AUTHORITATIVE
    // column. `user_metadata.super_agent_id` is writable by the account itself
    // via `auth.updateUser()`, so reading it would let a sub-agent name ANY
    // super agent as the destination of their money.
    const isSelfFundedSuperAgent = identity.role === "super_agent";
    // Fail closed for a sub-agent with no super agent assigned: their money
    // has no legitimate destination, and guessing one would credit a stranger.
    const resolvedWalletOwnerId: string | null = isSelfFundedSuperAgent
      ? user.id
      : identity.superAgentId;

    if (!isSelfFundedSuperAgent && !resolvedWalletOwnerId) {
      console.error(
        "[verify-wallet-topup] Sub-agent top-up with no super agent assigned; refusing to credit an unknown wallet:",
        { userId: user.id, reference },
      );
      return new Response(
        JSON.stringify({
          error:
            "Your account is not assigned to a Super Agent, so there is no wallet for this top-up to fund. Contact support.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Settlement routing. A self-funded super agent's money already arrived at
    // their own sub-account (Paystack resolved it from the token), so that
    // value wins. A sub-agent's payment is charged to the PLATFORM main
    // account, and the super agent's sub-account is only recorded for
    // reconciliation.
    let resolvedSubaccountCode: string | null =
      verifyData.data?.subaccount?.subaccount_code ||
      verifyData.data?.subaccount_code ||
      null;

    // Stamped onto the top-up row so the credit, the settlement record and the
    // analytics can never disagree about who funded what. Requires migration
    // 20260928_007; tolerated as absent below.
    updateData.funder_user_id = user.id;
    updateData.wallet_owner_id = resolvedWalletOwnerId;

    if (
      isSelfFundedSuperAgent &&
      resolvedWalletOwnerId &&
      !resolvedSubaccountCode
    ) {
      try {
        const { data: subaccountRow } = await supabaseAdmin
          .from("super_agent_paystack")
          .select("subaccount_code, is_active")
          .eq("super_agent_id", resolvedWalletOwnerId)
          .maybeSingle();
        if (subaccountRow?.is_active && subaccountRow.subaccount_code) {
          resolvedSubaccountCode = subaccountRow.subaccount_code;
        }
      } catch (subaccountError) {
        console.warn(
          "Could not resolve super-agent subaccount for wallet topup:",
          subaccountError,
        );
      }
    }

    if (resolvedSubaccountCode) {
      updateData.paystack_subaccount_code = resolvedSubaccountCode;
    }

    {
      // Tolerate a database that hasn't run a migration yet by retrying
      // without the columns it is missing.
      //
      // `paystack_subaccount_code` (migration 004), the three charge snapshot
      // columns (migration 20260927_003) and the two owner columns
      // (migration 20260928_007) are all optional here. The previous check
      // only recognised the subaccount column, so on a database missing the
      // newer ones the retry still carried them and failed the same way - the
      // top-up then 500'd even though the payment had succeeded. The offending
      // columns are now stripped from the error text generically, so this keeps
      // working as columns are added.
      //
      // This is a LOOP, not a single retry: Postgres reports one missing column
      // per error, so a database several migrations behind needs several
      // passes. A single retry stripped one column, found the next one missing,
      // and gave up - 500 after a successful payment. Every pass removes one
      // entry from a fixed list, so it cannot loop forever.
      let updateError: { code?: string; message?: string } | null = null;
      for (;;) {
        const attempt = await supabaseAdmin
          .from("wallet_topups")
          .update(updateData)
          .eq("reference", reference);
        updateError = attempt.error;
        if (!updateError || updateError.code !== "42703") break;

        const missingColumn =
          /column\s+"?(\w+)"?\s+of relation\s+"?wallet_topups"?\s+does not exist/i.exec(
            updateError.message || "",
          )?.[1] ||
          /paystack_subaccount_code|charge_percent|charge_amount|gross_amount|funder_user_id|wallet_owner_id/.exec(
            updateError.message || "",
          )?.[0];

        // A 42703 naming no column we recognise is some other missing
        // relation/column, and retrying without a field cannot help.
        if (!missingColumn || !OPTIONAL_TOPUP_COLUMNS.includes(missingColumn)) {
          break;
        }

        delete updateData[missingColumn];
        console.warn(
          `[verify-wallet-topup] Column "${missingColumn}" is absent; retrying without it. Apply the pending migration.`,
        );
      }

      if (updateError) {
        console.error("Failed to update wallet_topups:", updateError);
        return new Response(
          JSON.stringify({
            error: "Failed to update wallet topup",
            details: updateError,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    {
      // Credit BOTH the payer and the wallet owner, by the same NET figure.
      //
      // WHY TWO CREDITS
      // ---------------
      // The model is a MIRROR, not a duplicate pot. A sub-agent who tops up
      // 100 has 100 of real money added to their super agent's wallet, and
      // 100 of SPENDING POWER, which is a ceiling drawn against that money.
      // Crediting only the super agent - the previous behaviour - left the
      // sub-agent with no balance and nothing they could see or spend, which
      // is why the wallet looked "missing" on their account.
      //
      // Crediting only the sub-agent would be worse: `verify-payment` debits
      // the super agent, so their real balance would never move and the
      // platform would fund orders out of thin air.
      //
      // It must be the SAME amount on both sides. Crediting `gross_amount` to
      // one and `amount` to the other would quietly have the platform absorb
      // 1.95% of the mirror, and the two ledger rows would not reconcile
      // against Paystack. The 1.95% is charged once, here, at top-up, and is
      // already netted out of `existingTopup.amount`.
      //
      // INVARIANT: super_agent.balance - sum(sub_agent.balance) >= 0. Since
      // every order debits both sides by the same amount, and the pre-flight
      // check refuses an order the payer cannot afford, the mirror can never
      // overspend what the super agent actually holds.
      //
      // REFERENCES MUST DIFFER. `super_agent_wallet_ledger.reference` is
      // `text NOT NULL UNIQUE` GLOBALLY, so two rows cannot share one. The
      // mirrored entry is suffixed with the sub-agent's id, which is derived
      // from the ids rather than a counter or a clock - that is what makes a
      // replay of the same reference idempotent on BOTH rows.
      const creditErrorFrom = (result: { data: unknown; error: unknown }) => {
        const payload = result.data as { success?: boolean } | null;
        return result.error || !payload?.success;
      };

      const creditOwner = async (
        walletId: string,
        referenceSuffix: string,
        reason: string,
      ) => {
        const result = await supabaseAdmin.rpc("credit_super_agent_wallet", {
          p_super_agent_id: walletId,
          p_amount: existingTopup.amount,
          p_reference: `wallet-topup-${existingTopup.id}${referenceSuffix}`,
          p_reason: reason,
          p_metadata: {
            topup_id: existingTopup.id,
            paystack_transaction_id: verifyData.data.id,
            // Recorded so reconciliation can tell a super agent's own top-up
            // from one their sub-agent funded, and which side of the mirror
            // this row is.
            funded_by: user.id,
            funded_by_role: identity.role,
            wallet_side: reason,
          },
        });

        if (creditErrorFrom(result)) {
          console.error("Failed to credit wallet:", {
            result,
            walletId,
            reason,
            fundedBy: user.id,
          });
          throw new Error(`credit failed for ${walletId}`);
        }
        return result;
      };

      try {
        // Side 1: the super agent's REAL money. Always.
        const ownerCredit = await creditOwner(
          resolvedWalletOwnerId as string,
          "",
          isSelfFundedSuperAgent
            ? "wallet_topup"
            : "sub_agent_wallet_topup_super_agent_side",
        );

        // Side 2: the sub-agent's spending power. Only when payer != owner.
        // Skipped entirely for a super agent, so the common case is one RPC
        // and one ledger row exactly as before.
        let subAgentBalance: number | null = null;
        if (!isSelfFundedSuperAgent) {
          const subAgentCredit = await creditOwner(
            user.id,
            `:sub:${user.id}`,
            "sub_agent_wallet_topup_sub_agent_side",
          );
          subAgentBalance = Number(
            (subAgentCredit.data as { balance?: number } | null)?.balance ?? 0,
          );
        }

        const ownerBalance = Number(
          (ownerCredit.data as { balance?: number } | null)?.balance ?? 0,
        );

        return new Response(
          JSON.stringify({
            success: true,
            // The OWNER's balance, which is the real money. Unchanged
            // semantics for a super agent, who is their own owner.
            new_balance: ownerBalance,
            already_processed:
              (ownerCredit.data as { already_processed?: boolean } | null)
                ?.already_processed || false,
            // The verified split, so the client can confirm exactly what was
            // charged and credited rather than restating figures it computed
            // locally before the payment.
            credited_amount: Number(
              (ownerCredit.data as { credited_amount?: number } | null)
                ?.credited_amount ?? expectedNet,
            ),
            charge_amount: expectedFee,
            charge_percent: topUpChargePercent,
            gross_amount: expectedGross,
            // Echoed so a sub-agent is told plainly whose real money was
            // funded, rather than seeing their own "top up" succeed with no
            // indication the money went to someone else.
            wallet_owner_id: resolvedWalletOwnerId,
            funded_someone_else: !isSelfFundedSuperAgent,
            // The sub-agent's own spending power. Null for a super agent.
            sub_agent_balance: subAgentBalance,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      } catch (mirrorError) {
        // Side 1 may have committed before side 2 failed, so this is a genuine
        // partial write. It is NOT rolled back here: the money was received
        // and the super agent's side is real and correct. Both credits are
        // idempotent on their reference, so a retry converges rather than
        // double-crediting - `verify-wallet-topup` is re-invoked by the client
        // on failure, and a completed top-up row is rejected with 409 anyway.
        console.error(
          "[verify-wallet-topup] Mirror credit incomplete; the super agent side may be committed:",
          mirrorError,
        );
        return new Response(
          JSON.stringify({
            error:
              "Your payment succeeded but the wallet could not be fully credited. Contact support with your reference.",
            partial_credit: true,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }
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
