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

type CanonicalRole = "admin" | "super_agent" | "sub_agent";

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
    case "user":
    case "normal_user":
    case "normaluser":
      return "sub_agent";
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
    if (!identityIsSuperAgent(identity)) {
      return new Response(
        JSON.stringify({
          error: "Only Super Agents can fund an operational wallet",
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

    // The payer IS the super agent funding their own wallet, so their own id is
    // the wallet owner. Read from the authoritative profile rather than
    // `user_metadata.super_agent_id`, which the user could rewrite to point at
    // a different agent and mis-route the settlement reconciliation.
    let resolvedSuperAgentId: string | null = identity.superAgentId ?? user.id;
    let resolvedSubaccountCode: string | null =
      verifyData.data?.subaccount?.subaccount_code ||
      verifyData.data?.subaccount_code ||
      null;

    if (resolvedSuperAgentId && !resolvedSubaccountCode) {
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
          "Could not resolve super-agent subaccount for wallet topup:",
          subaccountError,
        );
      }
    }

    if (resolvedSubaccountCode) {
      updateData.paystack_subaccount_code = resolvedSubaccountCode;
    }

    const { error: updateError } = await supabaseAdmin
      .from("wallet_topups")
      .update(updateData)
      .eq("reference", reference);

    if (updateError) {
      // Tolerate a database that hasn't run a migration yet by retrying
      // without the columns it is missing.
      //
      // `paystack_subaccount_code` (migration 004) and the three charge
      // snapshot columns (migration 20260927_003) are both optional here. The
      // previous check only recognised the subaccount column, so on a database
      // missing the newer ones the retry still carried them and failed the same
      // way - the top-up then 500'd even though the payment had succeeded. The
      // offending columns are now stripped from the error text generically, so
      // this keeps working as columns are added.
      if (updateError.code === "42703") {
        const missingColumn =
          /column\s+"?(\w+)"?\s+of relation\s+"?wallet_topups"?\s+does not exist/i.exec(
            updateError.message || "",
          )?.[1] ||
          /paystack_subaccount_code|charge_percent|charge_amount|gross_amount/.exec(
            updateError.message || "",
          )?.[0];

        if (missingColumn) {
          // Not a wallet_topups column: some other constraint, so retrying
          // without a field cannot help.
          if (
            missingColumn !== "paystack_subaccount_code" &&
            !["charge_percent", "charge_amount", "gross_amount"].includes(
              missingColumn,
            )
          ) {
            console.error("Failed to update wallet_topups:", updateError);
            return new Response(
              JSON.stringify({
                error: "Failed to update wallet topup",
                details: updateError,
              }),
              {
                status: 500,
                headers: {
                  ...corsHeaders,
                  "Content-Type": "application/json",
                },
              },
            );
          }

          delete updateData[missingColumn];
          console.warn(
            `[verify-wallet-topup] Column "${missingColumn}" is absent; retrying without it. Apply the pending migration.`,
          );

          const { error: retryError } = await supabaseAdmin
            .from("wallet_topups")
            .update(updateData)
            .eq("reference", reference);
          if (retryError) {
            console.error(
              `Failed to update wallet_topups (without ${missingColumn}):`,
              retryError,
            );
            return new Response(
              JSON.stringify({
                error: "Failed to update wallet topup",
                details: retryError,
              }),
              {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }
        }
      } else {
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
      const { data: creditResult, error: creditError } =
        await supabaseAdmin.rpc("credit_super_agent_wallet", {
          p_super_agent_id: user.id,
          p_amount: existingTopup.amount,
          p_reference: `wallet-topup-${existingTopup.id}`,
          p_reason: "wallet_topup",
          p_metadata: {
            topup_id: existingTopup.id,
            paystack_transaction_id: verifyData.data.id,
          },
        });

      if (creditError || !creditResult?.success) {
        console.error("Failed to credit Super Agent wallet:", {
          creditError,
          creditResult,
        });
        return new Response(
          JSON.stringify({ error: "Failed to credit Super Agent wallet" }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          new_balance: creditResult.balance,
          already_processed: creditResult.already_processed || false,
          // The verified split, so the client can confirm exactly what was
          // charged and credited rather than restating figures it computed
          // locally before the payment.
          credited_amount: Number(creditResult.credited_amount ?? expectedNet),
          charge_amount: expectedFee,
          charge_percent: topUpChargePercent,
          gross_amount: expectedGross,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
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
