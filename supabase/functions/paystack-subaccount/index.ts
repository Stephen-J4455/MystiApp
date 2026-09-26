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

const paystackRequest = async (
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  paystackSecret: string,
  body?: Record<string, unknown>,
) => {
  const response = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${paystackSecret}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization token" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({
          error:
            "Missing config: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (!paystackSecret) {
      return new Response(
        JSON.stringify({ error: "PAYSTACK_SECRET_KEY is not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Role from `public.user_profiles`. The old gate read
    // `user_metadata.role` first, so any authenticated user could claim
    // SuperAgent and create, verify or read Paystack subaccounts - which
    // determines where sub-agent payments are settled.
    let identity;
    try {
      identity = await resolveIdentity({
        url: supabaseUrl,
        anonKey: supabaseAnonKey,
        serviceRoleKey: supabaseServiceRoleKey,
        authClient: supabaseAuth,
        admin: createClient(supabaseUrl, supabaseServiceRoleKey),
      });
    } catch {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!isSuperAgent(identity)) {
      return new Response(
        JSON.stringify({ error: "Only super agents can manage subaccounts" }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    // Badge comes from `app_metadata` ONLY. The old code read
    // `user_metadata.super_agent_badge` first and defaulted to "enterprise",
    // so a Pro super agent could set that key on their own metadata and
    // unlock sub-account management - which controls where sub-agent payments
    // are settled. Fail closed rather than defaulting.
    const { data: callerAuth } = await createClient(
      supabaseUrl,
      supabaseServiceRoleKey,
    ).auth.admin.getUserById(identity.id);
    const badge = String(
      callerAuth?.user?.app_metadata?.super_agent_badge || "",
    ).toLowerCase();
    if (badge !== "enterprise") {
      return new Response(
        JSON.stringify({
          error: "The Pro badge does not include Paystack Sub-Account access",
        }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Token-derived id/email, not spoofable. Alias keeps the `user.id` call
    // sites below unchanged.
    const user = { id: identity.id, email: identity.email } as {
      id: string;
      email?: string | null;
    };

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const body = await req.json().catch(() => ({}));
    const { action, subaccount } = body;

    if (action === "createSubaccount") {
      return await handleCreateSubaccount(
        supabaseAdmin,
        paystackSecret,
        user.id,
        subaccount,
        corsHeaders,
      );
    }
    if (action === "getSubaccount") {
      return await handleGetSubaccount(
        supabaseAdmin,
        paystackSecret,
        user.id,
        corsHeaders,
      );
    }
    if (action === "updateSubaccount") {
      return await handleUpdateSubaccount(
        supabaseAdmin,
        paystackSecret,
        user.id,
        subaccount,
        corsHeaders,
      );
    }
    if (action === "listBanks") {
      return await handleListBanks(paystackSecret, corsHeaders);
    }
    if (action === "verifySubaccount") {
      return await handleVerifySubaccount(
        supabaseAdmin,
        paystackSecret,
        user.id,
        corsHeaders,
      );
    }

    return new Response(JSON.stringify({ error: "Unsupported action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("paystack-subaccount error:", error);
    return new Response(
      JSON.stringify({ error: error?.message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

async function handleCreateSubaccount(
  supabaseAdmin: any,
  paystackSecret: string,
  superAgentId: string,
  subaccount: any,
  corsHeaders: Record<string, string>,
) {
  const businessName = String(subaccount?.business_name || "").trim();
  const settlementBankCode = String(
    subaccount?.settlement_bank_code || "",
  ).trim();
  const accountNumber = String(subaccount?.account_number || "").trim();
  const percentageCharge = Number(subaccount?.percentage_charge ?? 0);
  const description = String(subaccount?.description || "").trim();

  if (!businessName || !settlementBankCode || !accountNumber) {
    return new Response(
      JSON.stringify({
        error:
          "business_name, settlement_bank_code, and account_number are required",
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  if (
    !Number.isFinite(percentageCharge) ||
    percentageCharge < 0 ||
    percentageCharge > 100
  ) {
    return new Response(
      JSON.stringify({
        error: "percentage_charge must be a number between 0 and 100",
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const paystackPayload: Record<string, unknown> = {
    business_name: businessName,
    settlement_bank: settlementBankCode,
    account_number: accountNumber,
    percentage_charge: percentageCharge,
  };
  if (description) paystackPayload.description = description;

  const paystackResult = await paystackRequest(
    "/subaccount",
    "POST",
    paystackSecret,
    paystackPayload,
  );

  if (!paystackResult.ok || !paystackResult.data?.status) {
    console.error("Paystack create subaccount failed:", paystackResult);
    return new Response(
      JSON.stringify({
        error:
          paystackResult.data?.message ||
          "Paystack rejected the subaccount request",
        details: paystackResult.data,
      }),
      {
        status: paystackResult.status || 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const created = paystackResult.data?.data || {};
  const subaccountCode = created.subaccount_code;
  if (!subaccountCode) {
    return new Response(
      JSON.stringify({
        error: "Paystack did not return a subaccount_code",
        details: paystackResult.data,
      }),
      {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const upsertPayload: Record<string, unknown> = {
    super_agent_id: superAgentId,
    subaccount_code: subaccountCode,
    business_name: businessName,
    settlement_bank: created.settlement_bank || null,
    settlement_bank_code: settlementBankCode,
    account_number: accountNumber,
    percentage_charge: percentageCharge,
    is_active: true,
    paystack_raw_response: paystackResult.data,
    updated_at: new Date().toISOString(),
  };

  const { data: stored, error: upsertError } = await supabaseAdmin
    .from("super_agent_paystack")
    .upsert(upsertPayload, { onConflict: "super_agent_id" })
    .select();

  if (upsertError) {
    if (
      upsertError.code === "42P01" ||
      /does not exist|relation .* does not exist/i.test(
        upsertError.message || "",
      )
    ) {
      return new Response(
        JSON.stringify({
          error:
            "The super_agent_paystack table is not available yet. Run the latest migration first.",
          migration_required: true,
          paystack_subaccount: created,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    throw upsertError;
  }

  return new Response(JSON.stringify({ subaccount: stored?.[0] || null }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleGetSubaccount(
  supabaseAdmin: any,
  paystackSecret: string,
  superAgentId: string,
  corsHeaders: Record<string, string>,
) {
  const { data, error } = await supabaseAdmin
    .from("super_agent_paystack")
    .select("*")
    .eq("super_agent_id", superAgentId)
    .maybeSingle();

  if (error) {
    if (
      error.code === "42P01" ||
      /does not exist|relation .* does not exist/i.test(error.message || "")
    ) {
      return new Response(JSON.stringify({ subaccount: null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    throw error;
  }

  if (data?.subaccount_code) {
    try {
      const remote = await paystackRequest(
        `/subaccount/${encodeURIComponent(data.subaccount_code)}`,
        "GET",
        paystackSecret,
      );
      if (remote.ok && remote.data?.data) {
        return new Response(
          JSON.stringify({
            subaccount: { ...data, paystack_remote: remote.data.data },
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    } catch (remoteError) {
      console.warn(
        "Failed to refresh Paystack subaccount details:",
        remoteError,
      );
    }
  }

  return new Response(JSON.stringify({ subaccount: data || null }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleUpdateSubaccount(
  supabaseAdmin: any,
  paystackSecret: string,
  superAgentId: string,
  subaccount: any,
  corsHeaders: Record<string, string>,
) {
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("super_agent_paystack")
    .select("*")
    .eq("super_agent_id", superAgentId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) {
    return new Response(
      JSON.stringify({ error: "No subaccount linked to this super agent" }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const subaccountCode = String(
    subaccount?.subaccount_code || existing.subaccount_code || "",
  ).trim();
  if (!subaccountCode) {
    return new Response(
      JSON.stringify({ error: "subaccount_code is required" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const paystackPayload: Record<string, unknown> = {};
  if (subaccount?.business_name !== undefined)
    paystackPayload.business_name = String(subaccount.business_name).trim();
  if (subaccount?.settlement_bank_code !== undefined)
    paystackPayload.settlement_bank = String(
      subaccount.settlement_bank_code,
    ).trim();
  if (subaccount?.account_number !== undefined)
    paystackPayload.account_number = String(subaccount.account_number).trim();
  if (subaccount?.percentage_charge !== undefined) {
    const numeric = Number(subaccount.percentage_charge);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
      return new Response(
        JSON.stringify({
          error: "percentage_charge must be between 0 and 100",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    paystackPayload.percentage_charge = numeric;
  }
  if (subaccount?.description !== undefined)
    paystackPayload.description = String(subaccount.description).trim() || null;
  if (subaccount?.active !== undefined)
    paystackPayload.active = Boolean(subaccount.active);

  if (Object.keys(paystackPayload).length === 0) {
    return new Response(
      JSON.stringify({ error: "No editable fields supplied" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const paystackResult = await paystackRequest(
    `/subaccount/${encodeURIComponent(subaccountCode)}`,
    "PUT",
    paystackSecret,
    paystackPayload,
  );

  if (!paystackResult.ok || !paystackResult.data?.status) {
    return new Response(
      JSON.stringify({
        error:
          paystackResult.data?.message ||
          "Paystack rejected the update request",
        details: paystackResult.data,
      }),
      {
        status: paystackResult.status || 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const updatePayload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    paystack_raw_response: paystackResult.data,
  };
  if (subaccount?.business_name !== undefined)
    updatePayload.business_name =
      String(subaccount.business_name).trim() || null;
  if (subaccount?.settlement_bank_code !== undefined) {
    updatePayload.settlement_bank_code =
      String(subaccount.settlement_bank_code).trim() || null;
    updatePayload.settlement_bank =
      paystackResult.data?.data?.settlement_bank || null;
  }
  if (subaccount?.account_number !== undefined)
    updatePayload.account_number =
      String(subaccount.account_number).trim() || null;
  if (subaccount?.percentage_charge !== undefined)
    updatePayload.percentage_charge = Number(subaccount.percentage_charge);
  if (subaccount?.active !== undefined)
    updatePayload.is_active = Boolean(subaccount.active);

  const { data: updated, error: updateError } = await supabaseAdmin
    .from("super_agent_paystack")
    .update(updatePayload)
    .eq("super_agent_id", superAgentId)
    .select();

  if (updateError) throw updateError;

  return new Response(JSON.stringify({ subaccount: updated?.[0] || null }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleVerifySubaccount(
  supabaseAdmin: any,
  paystackSecret: string,
  superAgentId: string,
  corsHeaders: Record<string, string>,
) {
  const { data, error } = await supabaseAdmin
    .from("super_agent_paystack")
    .select("*")
    .eq("super_agent_id", superAgentId)
    .maybeSingle();

  if (error) {
    if (
      error.code === "42P01" ||
      /does not exist|relation .* does not exist/i.test(error.message || "")
    ) {
      return new Response(JSON.stringify({ subaccount: null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    throw error;
  }

  if (!data?.subaccount_code) {
    return new Response(
      JSON.stringify({
        subaccount: null,
        verified: false,
        message: "No sub-account configured.",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const remote = await paystackRequest(
      `/subaccount/${encodeURIComponent(data.subaccount_code)}`,
      "GET",
      paystackSecret,
    );

    if (!remote.ok || !remote.data?.status) {
      console.error("Paystack verify failed:", remote.data);
      return new Response(
        JSON.stringify({
          subaccount: data,
          verified: false,
          error: remote.data?.message || "Failed to verify with Paystack",
        }),
        {
          status: remote.status || 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const paystackData = remote.data.data;

    // Unverified status values Paystack may return
    const UNVERIFIED_STATUSES = [
      "pending",
      "unverified",
      "processing",
      "review",
      "failed",
    ];

    // Mirror ExpressMart's getEffectiveVerificationState logic:
    //   1. sub.active must be true  (Paystack uses 'active', not 'is_active')
    //   2. is_verified / verified must NOT be false
    //   3. verification_status must not be in the unverified list
    const rawActive = paystackData?.active;
    const effectiveVerified =
      rawActive === true &&
      paystackData?.is_verified !== false &&
      paystackData?.verified !== false &&
      !UNVERIFIED_STATUSES.includes(
        String(
          paystackData.verification_status ||
            paystackData.account_verification_status ||
            "",
        )
          .trim()
          .toLowerCase(),
      );

    const isActive = Boolean(effectiveVerified);

    // Update local record with latest Paystack data
    const updatePayload = {
      updated_at: new Date().toISOString(),
      paystack_raw_response: remote.data,
      is_active: isActive,
    };
    if (paystackData.business_name !== undefined)
      updatePayload.business_name = String(paystackData.business_name) || null;
    if (paystackData.settlement_bank)
      updatePayload.settlement_bank = paystackData.settlement_bank;
    if (paystackData.percentage_charge !== undefined)
      updatePayload.percentage_charge = Number(paystackData.percentage_charge);

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("super_agent_paystack")
      .update(updatePayload)
      .eq("super_agent_id", superAgentId)
      .select();

    if (updateError) {
      console.error("Failed to update subaccount after verify:", updateError);
    }

    return new Response(
      JSON.stringify({
        subaccount: updated?.[0] || data,
        verified: true,
        paystack_status: isActive ? "active" : "inactive",
        paystack_remote: paystackData,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (remoteError) {
    console.error("Verify subaccount error:", remoteError);
    return new Response(
      JSON.stringify({
        subaccount: data,
        verified: false,
        error: "Network error while verifying with Paystack",
      }),
      {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}

async function handleListBanks(
  paystackSecret: string,
  corsHeaders: Record<string, string>,
) {
  const paystackResult = await paystackRequest(
    "/bank?country=ghana&per_page=100",
    "GET",
    paystackSecret,
  );

  const rawBanks = paystackResult.data?.data || [];

  // Merge banks with same code (like ExpressMart normalizeBanks)
  const seen = new Set<string>();
  const mergedBanks: any[] = [];
  for (const b of rawBanks) {
    if (!b || b.active === false || b.is_deleted === true) continue;
    const code = String(b.code || "").trim();
    const name = String(b.name || "").trim();
    if (!code || !name) continue;
    const key = code; // merge by code only
    if (seen.has(key)) continue;
    seen.add(key);
    mergedBanks.push({ ...b, code, name });
  }

  return new Response(
    JSON.stringify({
      banks: mergedBanks,
      paystack_ok: paystackResult.ok,
    }),
    {
      status: paystackResult.ok ? 200 : paystackResult.status || 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}
