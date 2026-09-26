import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

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
const identityIsSuperAgent = (identity: Identity) => identity.role === "super_agent";

/**
 * Creates the anon/auth clients. Kept separate from `resolveIdentity` so a
 * function can fail fast on missing configuration with its own error shape.
 */
const getSupabaseClients = (
  authorizationHeader: string,
): SupabaseClients => {
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
const resolveIdentity = async (
  clients: SupabaseClients,
): Promise<Identity> => {
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
): boolean => identityIsAdmin(identity) || (ownerId != null && ownerId === identity.id);


// Display-casing only. The comparisons below match on these exact strings, so
// keep them in sync with `resolveIdentity`'s canonical role.
const ROLE_DISPLAY: Record<string, string> = {
  admin: "Admin",
  super_agent: "SuperAgent",
  sub_agent: "Agent",
};

const clean = (value: unknown, maxLength = 200) =>
  String(value ?? "")
    .trim()
    .slice(0, maxLength);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization token" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceKey)
      return json({ error: "Server is not configured" }, 500);

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceKey);
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    // Role and super-agent ownership now come from `public.user_profiles`.
    // Previously `normalizeRole` read `user.user_metadata.role` first, which
    // the user can rewrite via `supabase.auth.updateUser` - so anyone could
    // declare themselves a Super Agent and pay the (different) super-agent
    // price, and the two `super_agent_id` reads below were equally spoofable,
    // letting a sub-agent bill a super agent who was not their own.
    const identity = await resolveIdentity({
      url: supabaseUrl,
      anonKey: anonKey,
      serviceRoleKey: serviceKey,
      authClient,
      admin,
    });
    const role = ROLE_DISPLAY[identity.role] ?? null;

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "getStatus");

    if (action === "getStatus" || action === "create") {
      const { data: settings, error: settingsError } = await admin
        .from("afa_registration_settings")
        .select(
          "registration_fee, super_agent_base_price, sub_agent_base_price, currency, is_enabled",
        )
        .eq("id", true)
        .maybeSingle();
      if (settingsError) throw settingsError;

      let registrationsQuery = admin
        .from("afa_registrations")
        .select("*")
        .eq("registered_user_id", user.id)
        .order("created_at", { ascending: false });
      const { data: registrations, error: registrationsError } =
        await registrationsQuery;
      if (registrationsError) throw registrationsError;

      // The price this user will actually be charged. Resolved server-side so
      // the figure the screen shows is the figure the registration records.
      const callerIsSuperAgent = role === "SuperAgent";
      const callerSuperAgentId = callerIsSuperAgent
        ? user.id
        : identity.superAgentId;
      const { data: pricing, error: pricingError } = await admin.rpc(
        "resolve_afa_base_price",
        {
          p_payer_is_super_agent: callerIsSuperAgent,
          p_payer_super_agent_id: callerSuperAgentId,
        },
      );
      if (pricingError) throw pricingError;

      // A super agent also owns the price charged to their sub-agents, so the
      // settings screen needs it alongside the price they pay themselves.
      let ownAgentPricing = null;
      if (callerIsSuperAgent) {
        const { data } = await admin
          .from("super_agent_afa_pricing")
          .select("*")
          .eq("super_agent_id", user.id)
          .maybeSingle();
        ownAgentPricing = data || null;
      }

      return json({
        settings,
        registrations: registrations || [],
        quotedFee: pricing?.[0]?.base_price ?? null,
        priceSource: pricing?.[0]?.price_source ?? "platform_default",
        ownAgentPricing,
      });
    }

    // A super agent sets the base price charged to THEIR OWN sub-agents.
    // Scoped to `user.id` server-side; the RLS policy on
    // super_agent_afa_pricing is the second line of defence, but the edge
    // function is what actually decides the owner so a crafted request cannot
    // retarget somebody else's price.
    if (action === "saveSubAgentPricing") {
      if (role !== "SuperAgent") {
        return json({ error: "Super Agent role required" }, 403);
      }

      const rawPrice = clean(body.subAgentBasePrice, 20);
      const price = Number(rawPrice);
      if (rawPrice === "" || !Number.isFinite(price) || price < 0) {
        return json({ error: "Enter a valid base price" }, 400);
      }

      const { data, error: saveError } = await admin
        .from("super_agent_afa_pricing")
        .upsert(
          {
            super_agent_id: user.id,
            sub_agent_base_price: price,
            currency: "GHS",
            is_enabled: body.isEnabled !== false,
            notes: clean(body.notes, 500) || null,
            updated_by: user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "super_agent_id" },
        )
        .select()
        .single();
      if (saveError) throw saveError;

      return json({ success: true, pricing: data });
    }

    if (action === "createRegistration") {
      const { data: settings, error: settingsError } = await admin
        .from("afa_registration_settings")
        .select("*")
        .eq("id", true)
        .maybeSingle();
      if (settingsError) throw settingsError;

      const { data: pendingRegistration, error: pendingLookupError } =
        await admin
          .from("afa_registrations")
          .select("id")
          .eq("registered_user_id", user.id)
          .eq("status", "pending_payment")
          .maybeSingle();
      if (pendingLookupError) throw pendingLookupError;
      if (pendingRegistration) {
        return json(
          {
            error: "Complete or cancel the existing pending AFA request first",
          },
          409,
        );
      }

      const fullName = clean(body.fullName, 120);
      const phone = clean(body.phone, 30);
      const idType = clean(body.idType, 30);
      const idNumber = clean(body.idNumber, 80).toUpperCase();
      const townCity = clean(body.townCity, 120);
      const occupation = clean(body.occupation, 120);
      if (!fullName || !phone || !idNumber || !townCity || !occupation) {
        return json({ error: "All registration details are required" }, 400);
      }
      if (!["National ID", "Voters ID"].includes(idType)) {
        return json({ error: "Select a valid ID type" }, 400);
      }

      const isSuperAgent = role === "SuperAgent";
      const paymentMethod = isSuperAgent ? "wallet" : "paystack";
      const reference = `afa_${Date.now()}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const superAgentId = isSuperAgent ? user.id : identity.superAgentId;

      // Tiered pricing: a super agent pays the platform's super-agent price,
      // a sub-agent pays whatever their own super agent set (falling back to
      // the platform default). The enabled flag is checked against the QUOTED
      // price rather than the legacy global fee, so enabling is per-tier.
      const { data: pricing, error: pricingError } = await admin.rpc(
        "resolve_afa_base_price",
        {
          p_payer_is_super_agent: isSuperAgent,
          p_payer_super_agent_id: superAgentId,
        },
      );
      if (pricingError) throw pricingError;
      const quotedFee = Number(pricing?.[0]?.base_price ?? 0);
      const priceSource = pricing?.[0]?.price_source ?? "platform_default";

      if (!settings?.is_enabled || quotedFee <= 0) {
        return json(
          { error: "AFA registration is not currently available" },
          400,
        );
      }

      // When a sub-agent pays their own super agent's price, the money must go
      // to that super agent - not to the platform. Paystack sub-accounts are
      // the existing mechanism for exactly this (the data-order path already
      // routes sub-agent orders to the super agent's subaccount).
      let paystackSubaccountCode: string | null = null;
      let beneficiarySuperAgentId: string | null = null;
      if (!isSuperAgent && superAgentId) {
        const { data: subaccount } = await admin
          .from("super_agent_paystack")
          .select("subaccount_code, is_active")
          .eq("super_agent_id", superAgentId)
          .maybeSingle();
        if (subaccount?.is_active && subaccount.subaccount_code) {
          paystackSubaccountCode = subaccount.subaccount_code;
          beneficiarySuperAgentId = superAgentId;
        }
      }

      const { data: registration, error: createError } = await admin
        .from("afa_registrations")
        .insert({
          registered_user_id: user.id,
          payer_user_id: user.id,
          assigned_super_agent_id: superAgentId,
          full_name: fullName,
          phone,
          id_type: idType,
          id_number: idNumber,
          town_city: townCity,
          occupation,
          additional_info: clean(body.additionalInfo, 1000)
            ? { details: clean(body.additionalInfo, 1000) }
            : {},
          // What the payer is charged (tiered), and the platform base price it
          // was derived from. Both snapshotted - editing a price later must
          // never rewrite what a historical registration was worth.
          fee_amount: quotedFee,
          platform_fee_amount: Number(settings.registration_fee || 0),
          price_source: priceSource,
          currency: settings.currency || "GHS",
          payment_method: paymentMethod,
          payment_reference: reference,
          status: "pending_payment",
        })
        .select()
        .single();
      if (createError) throw createError;

      if (isSuperAgent) {
        const { data: result, error: walletError } = await admin.rpc(
          "pay_afa_registration_from_wallet",
          {
            p_registration_id: registration.id,
            p_super_agent_id: user.id,
            p_reference: reference,
          },
        );
        if (walletError) throw walletError;
        if (!result?.success) {
          await admin
            .from("afa_registrations")
            .delete()
            .eq("id", registration.id);
          return json(
            {
              error:
                result?.reason === "insufficient_balance"
                  ? "Insufficient wallet balance for AFA registration"
                  : "Unable to pay from wallet",
              balance: result?.debit?.balance,
              required: result?.debit?.required,
            },
            400,
          );
        }
        return json({
          success: true,
          registration: result.registration,
          balance: result.debit?.balance,
        });
      }

      return json({
        success: true,
        registration,
        paymentMethod,
        paystackSubaccountCode,
        beneficiarySuperAgentId,
        quotedFee,
        priceSource,
      });
    }

    if (action === "verifyPaystack") {
      const reference = clean(body.reference, 100);
      const registrationId = clean(body.registrationId, 100);
      if (!reference || !registrationId)
        return json({ error: "Registration and reference are required" }, 400);

      const { data: registration, error: lookupError } = await admin
        .from("afa_registrations")
        .select("*")
        .eq("id", registrationId)
        .eq("registered_user_id", user.id)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (!registration) return json({ error: "Registration not found" }, 404);

      const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");
      if (!paystackSecret)
        return json({ error: "Paystack is not configured" }, 500);

      const paystackResponse = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${paystackSecret}` } },
      );
      const paystack = await paystackResponse.json();
      if (
        !paystackResponse.ok ||
        !paystack?.status ||
        paystack?.data?.status !== "success"
      ) {
        return json(
          { error: paystack?.message || "Paystack payment was not successful" },
          400,
        );
      }
      if (paystack.data.reference !== registration.payment_reference) {
        return json(
          { error: "Payment reference does not match registration" },
          400,
        );
      }
      if (
        Number(paystack.data.amount) / 100 !==
        Number(registration.fee_amount)
      ) {
        return json(
          { error: "Paid amount does not match the registration fee" },
          400,
        );
      }
      if (String(paystack.data.currency || "").toUpperCase() !== "GHS") {
        return json({ error: "Payment currency is invalid" }, 400);
      }

      const { data: result, error: finalizeError } = await admin.rpc(
        "finalize_afa_registration_payment",
        {
          p_registration_id: registrationId,
          p_reference: reference,
          p_paystack_transaction_id: String(paystack.data.id),
          p_paystack_status: paystack.data.status,
          p_paid_at: paystack.data.paid_at || null,
        },
      );
      if (finalizeError) throw finalizeError;
      return json({
        success: true,
        registration: result.registration,
        alreadyProcessed: result.already_processed,
      });
    }

    if (action === "list") {
      if (role !== "Admin" && role !== "SuperAgent")
        return json({ error: "Admin access required" }, 403);
      let query = admin
        .from("afa_registrations")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (role === "SuperAgent") query = query.eq("payer_user_id", user.id);
      const { data, error } = await query;
      if (error) throw error;
      let ledgerQuery = admin
        .from("afa_payment_ledger")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (role === "SuperAgent")
        ledgerQuery = ledgerQuery.eq("payer_user_id", user.id);
      const { data: ledger, error: ledgerError } = await ledgerQuery;
      if (ledgerError) throw ledgerError;
      return json({ registrations: data || [], ledger: ledger || [] });
    }

    if (action === "updateSettings") {
      if (role !== "Admin")
        return json({ error: "Admin access required" }, 403);
      const fee = Number(body.registrationFee);
      if (!Number.isFinite(fee) || fee < 0)
        return json({ error: "Invalid registration fee" }, 400);

      // The per-tier base prices are optional: an absent or null value means
      // "not configured, fall back to registration_fee". That is what lets the
      // platform enable the tiers independently without a forced decision.
      const parseOptionalPrice = (raw: unknown) => {
        if (raw === undefined || raw === null || raw === "") return null;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error("Invalid base price");
        }
        return parsed;
      };

      let superAgentBasePrice = null;
      let subAgentBasePrice = null;
      try {
        superAgentBasePrice = parseOptionalPrice(body.superAgentBasePrice);
        subAgentBasePrice = parseOptionalPrice(body.subAgentBasePrice);
      } catch (error: any) {
        return json({ error: error.message }, 400);
      }

      const { data, error } = await admin
        .from("afa_registration_settings")
        .update({
          registration_fee: fee,
          super_agent_base_price: superAgentBasePrice,
          sub_agent_base_price: subAgentBasePrice,
          is_enabled: Boolean(body.isEnabled),
          updated_by: user.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", true)
        .select()
        .single();
      if (error) throw error;
      return json({ success: true, settings: data });
    }

    return json({ error: "Unsupported action" }, 400);
  } catch (error: any) {
    console.error("AFA registration error:", error);
    return json({ error: error?.message || "Internal server error" }, 500);
  }
});
