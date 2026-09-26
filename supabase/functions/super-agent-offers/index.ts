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

// Display-casing only. Authorization comes from the resolved Identity.
const ROLE_DISPLAY: Record<string, string> = {
  admin: "Admin",
  super_agent: "SuperAgent",
  sub_agent: "Agent",
};

const isMissingDatabaseObject = (error: any) => {
  const code = String(error?.code || "");
  const message = String(error?.message || "");

  return (
    code === "42P01" ||
    code === "42703" ||
    /does not exist|relation .* does not exist|column .* does not exist|missing column|missing table|relation/i.test(
      message,
    )
  );
};

const normalizeKey = (value: unknown) =>
  String(value || "")
    .trim()
    .toUpperCase();

const sizeFromDataValue = (dataValue: unknown) => {
  const match = String(dataValue || "").match(/(\d+(?:\.\d+)?)\s*GB/i);
  return match ? Number(match[1]) : null;
};

// Matches a super-agent offer (e.g. "ISHARE - 1GB") to a Jehuca catalog package
// so sub-agents still get a package id, size, and bundle type for display.
const findCatalogPackageForOffer = (catalog: any[], offer: any) => {
  const network = normalizeKey(offer?.network);
  const dataValue = normalizeKey(offer?.data_value);
  if (!dataValue) return null;

  return (
    catalog.find((pkg: any) => {
      if (normalizeKey(pkg?.network) !== network) return false;
      const type = normalizeKey(pkg?.type);
      const size =
        pkg?.size !== undefined &&
        pkg?.size !== null &&
        String(pkg.size).trim() !== ""
          ? `${pkg.size}GB`
          : "";
      const descriptor =
        size && !type.includes(size) ? `${type} - ${size}` : type || size;

      if (descriptor && descriptor === dataValue) return true;
      if (
        String(pkg?.id || "")
          .trim()
          .toUpperCase() === dataValue
      )
        return true;
      if (
        size &&
        (dataValue === `${type} - ${size}` ||
          dataValue === `${type} (${size})` ||
          dataValue === `${type} ${size}` ||
          dataValue === `${type}-${size}`)
      ) {
        return true;
      }

      return false;
    }) || null
  );
};

const fetchCatalogPackages = async () => {
  const apiKey = Deno.env.get("JEHUCA_API_KEY");
  if (!apiKey) return [];

  const response = await fetch(
    "https://backend.jehucale-business.com/api/packages",
    { headers: { "X-API-Key": apiKey } },
  );
  const data = await response.json();

  return Array.isArray(data?.payload) ? data.payload : [];
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

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({
          error:
            "Missing config: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for this edge function.",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Role and ownership from `public.user_profiles`. The previous
    // `normalizeRole(user)` read `user_metadata.role` first, so a caller could
    // self-grant SuperAgent and publish or edit every offer in the platform.
    const identity: Identity = await resolveIdentity({
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
      serviceRoleKey: supabaseServiceRoleKey,
      authClient: supabaseAuth,
      admin: supabaseAdmin,
    });
    if (identity.profileMissing) {
      console.warn(
        "[super-agent-offers] No user_profiles row; defaulted to sub_agent:",
        identity.id,
      );
    }

    // Token-derived id/email, not spoofable. Alias keeps the `user.id` call
    // sites below unchanged.
    const user = { id: identity.id, email: identity.email } as {
      id: string;
      email?: string | null;
    };

    const body = await req.json().catch(() => ({}));
    const { action, superAgentId, offer, assignment } = body;
    const targetSuperAgentId = superAgentId || user.id;

    const userRole = ROLE_DISPLAY[identity.role] ?? null;
    // Sub-agents may read the packages their super agent published for their tier.
    const isAgentPackageRead =
      userRole === "Agent" && action === "getAgentPackages";

    if (
      userRole !== "SuperAgent" &&
      userRole !== "Admin" &&
      !isAgentPackageRead
    ) {
      return new Response(JSON.stringify({ error: "User not allowed" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (userRole === "SuperAgent") {
      // Badge from `app_metadata` only, and NO default. The old code read the
      // self-writable `user_metadata.super_agent_badge` first and fell back to
      // "enterprise", so any Pro super agent could add that key to their own
      // metadata and unlock offer management.
      const { data: callerAuth } = await supabaseAdmin.auth.admin.getUserById(
        identity.id,
      );
      const badge = String(
        callerAuth?.user?.app_metadata?.super_agent_badge || "",
      ).toLowerCase();
      if (badge !== "enterprise") {
        return new Response(
          JSON.stringify({
            error: "The Pro badge does not include Offer Management access",
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    if (action === "listOffers") {
      // Load packages from Jehuca API instead of database
      const apiKey = Deno.env.get("JEHUCA_API_KEY");
      if (!apiKey) {
        return new Response(
          JSON.stringify({
            offers: [],
            error: "Jehuca API key not configured on server",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const baseUrl = "https://backend.jehucale-business.com/api/packages";
      const queryParts: string[] = [];
      const networkFilter = String(
        offer?.network || body?.network || "",
      ).trim();
      const typeFilter = String(offer?.type || body?.type || "").trim();
      if (networkFilter) {
        queryParts.push(`network=${encodeURIComponent(networkFilter)}`);
      }
      if (typeFilter) {
        queryParts.push(`type=${encodeURIComponent(typeFilter)}`);
      }
      const requestUrl = queryParts.length
        ? `${baseUrl}?${queryParts.join("&")}`
        : baseUrl;

      console.log(
        "Fetching offers from Jehuca API:",
        requestUrl,
        "for super agent:",
        targetSuperAgentId,
      );

      const response = await fetch(requestUrl, {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
        },
      });

      const apiData = await response.json();
      const offers = apiData.payload || [];

      return new Response(JSON.stringify({ offers }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "createOffer") {
      const title = String(offer?.title || "").trim();
      const network = String(offer?.network || "").trim();
      const dataValue = String(
        offer?.data_value || offer?.dataValue || "",
      ).trim();
      const price = Number(offer?.price || 0);
      const tierName = String(
        offer?.tier_name || offer?.default_tier_name || "",
      ).trim();
      const description = String(offer?.description || "").trim();

      if (
        !title ||
        !network ||
        !dataValue ||
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return new Response(
          JSON.stringify({
            error: "Title, network, data value, and valid price are required",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const insertPayload: Record<string, unknown> = {
        super_agent_id: targetSuperAgentId,
        title,
        network,
        data_value: dataValue,
        price,
        description: description || null,
        is_active: true,
      };

      // Only attach tier columns when supplied so the function stays
      // compatible with databases that haven't run the tier migrations yet.
      if (tierName) insertPayload.tier_name = tierName;
      if (tierName) insertPayload.default_tier_name = tierName;

      const { data, error } = await supabaseAdmin
        .from("super_agent_offers")
        .insert(insertPayload)
        .select();

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_offers table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        throw error;
      }

      return new Response(JSON.stringify({ offer: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "updateOffer") {
      const offerId = Number(offer?.id || 0);
      if (!Number.isFinite(offerId) || offerId <= 0) {
        return new Response(
          JSON.stringify({ error: "A valid offer id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const updatePayload: Record<string, unknown> = {};
      if (offer?.title !== undefined) {
        updatePayload.title = String(offer.title).trim();
      }
      if (offer?.network !== undefined) {
        updatePayload.network = String(offer.network).trim();
      }
      if (offer?.data_value !== undefined) {
        updatePayload.data_value = String(offer.data_value).trim();
      }
      if (offer?.price !== undefined) {
        const numericPrice = Number(offer.price);
        if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
          return new Response(
            JSON.stringify({ error: "Price must be greater than 0" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        updatePayload.price = numericPrice;
      }
      if (offer?.description !== undefined) {
        updatePayload.description = String(offer.description).trim() || null;
      }
      if (offer?.tier_name !== undefined) {
        updatePayload.tier_name = String(offer.tier_name).trim() || null;
      }
      if (offer?.default_tier_name !== undefined) {
        updatePayload.default_tier_name =
          String(offer.default_tier_name).trim() || null;
      }
      if (offer?.is_active !== undefined) {
        updatePayload.is_active = Boolean(offer.is_active);
      }

      if (Object.keys(updatePayload).length === 0) {
        return new Response(
          JSON.stringify({ error: "No editable fields supplied" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data, error } = await supabaseAdmin
        .from("super_agent_offers")
        .update(updatePayload)
        .eq("id", offerId)
        .eq("super_agent_id", targetSuperAgentId)
        .select();

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_offers table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw error;
      }

      return new Response(JSON.stringify({ offer: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "deleteOffer") {
      const offerId = Number(offer?.id || 0);
      if (!Number.isFinite(offerId) || offerId <= 0) {
        return new Response(
          JSON.stringify({ error: "A valid offer id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { error } = await supabaseAdmin
        .from("super_agent_offers")
        .delete()
        .eq("id", offerId)
        .eq("super_agent_id", targetSuperAgentId);

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_offers table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw error;
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "listAssignments") {
      const { data, error } = await supabaseAdmin
        .from("super_agent_assignments")
        .select("*")
        .eq("super_agent_id", targetSuperAgentId)
        .order("assigned_at", { ascending: false });

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(JSON.stringify({ assignments: [] }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        throw error;
      }

      return new Response(JSON.stringify({ assignments: data || [] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "createAssignment") {
      const agentId = String(assignment?.agent_id || "").trim();
      const offerId = Number(assignment?.offer_id || 0);
      const tierName = String(assignment?.tier_name || "").trim();
      const agentPrice = Number(assignment?.agent_price || 0);

      if (!agentId || !Number.isFinite(offerId) || offerId <= 0) {
        return new Response(
          JSON.stringify({ error: "Agent and offer are required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data, error } = await supabaseAdmin
        .from("super_agent_assignments")
        .insert({
          super_agent_id: targetSuperAgentId,
          agent_id: agentId,
          offer_id: offerId,
          tier_name: tierName || null,
          agent_price: Number.isFinite(agentPrice) ? agentPrice : null,
          is_active: true,
        })
        .select();

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_assignments table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        throw error;
      }

      return new Response(JSON.stringify({ assignment: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "updateAssignment") {
      const assignmentId = Number(assignment?.id || 0);
      if (!Number.isFinite(assignmentId) || assignmentId <= 0) {
        return new Response(
          JSON.stringify({ error: "A valid assignment id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const updatePayload: Record<string, unknown> = {};
      if (assignment?.tier_name !== undefined) {
        updatePayload.tier_name = String(assignment.tier_name).trim() || null;
      }
      if (assignment?.agent_price !== undefined) {
        const numericPrice = Number(assignment.agent_price);
        if (!Number.isFinite(numericPrice) || numericPrice < 0) {
          return new Response(
            JSON.stringify({ error: "Agent price must be 0 or greater" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        updatePayload.agent_price = numericPrice;
      }
      if (assignment?.is_active !== undefined) {
        updatePayload.is_active = Boolean(assignment.is_active);
      }

      if (Object.keys(updatePayload).length === 0) {
        return new Response(
          JSON.stringify({ error: "No editable fields supplied" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data, error } = await supabaseAdmin
        .from("super_agent_assignments")
        .update(updatePayload)
        .eq("id", assignmentId)
        .eq("super_agent_id", targetSuperAgentId)
        .select();

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_assignments table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw error;
      }

      return new Response(JSON.stringify({ assignment: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "deleteAssignment") {
      const assignmentId = Number(assignment?.id || 0);
      if (!Number.isFinite(assignmentId) || assignmentId <= 0) {
        return new Response(
          JSON.stringify({ error: "A valid assignment id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { error } = await supabaseAdmin
        .from("super_agent_assignments")
        .delete()
        .eq("id", assignmentId)
        .eq("super_agent_id", targetSuperAgentId);

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_assignments table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw error;
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "listSuperAgentOffers") {
      // List the super agent's own offers stored in the database
      // (optionally filtered by tier name). This complements listOffers,
      // which returns the upstream Jehuca package catalog instead.
      const tierNameFilter = String(body?.tierName || "").trim();

      let query = supabaseAdmin
        .from("super_agent_offers")
        .select("*")
        .eq("super_agent_id", targetSuperAgentId)
        .order("created_at", { ascending: false });

      if (tierNameFilter) {
        query = query.eq("tier_name", tierNameFilter);
      }

      const { data, error } = await query;

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              offers: [],
              error:
                "The super_agent_offers table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw error;
      }

      return new Response(JSON.stringify({ offers: data || [] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "upsertTierOffer") {
      const network = String(offer?.network || "").trim();
      const dataValue = String(
        offer?.data_value || offer?.dataValue || "",
      ).trim();
      const tierName = String(
        offer?.tier_name || offer?.default_tier_name || "",
      ).trim();
      const price = Number(offer?.price || 0);
      const title = String(offer?.title || "").trim();
      const description = String(offer?.description || "").trim();

      if (!network || !dataValue) {
        return new Response(
          JSON.stringify({ error: "Network and data value are required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      if (!Number.isFinite(price) || price <= 0) {
        return new Response(
          JSON.stringify({ error: "Price must be greater than 0" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      let existingQuery = supabaseAdmin
        .from("super_agent_offers")
        .select("id")
        .eq("super_agent_id", targetSuperAgentId)
        .eq("network", network)
        .eq("data_value", dataValue)
        .limit(1);

      if (tierName) {
        existingQuery = existingQuery.eq("tier_name", tierName);
      } else {
        existingQuery = existingQuery.is("tier_name", null);
      }

      const { data: existingRows, error: existingError } = await existingQuery;

      if (existingError) {
        if (isMissingDatabaseObject(existingError)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_offers table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw existingError;
      }

      const existing = existingRows?.[0] || null;

      if (existing) {
        const tierUpdatePayload: Record<string, unknown> = {
          price,
          tier_name: tierName || null,
          is_active: true,
          updated_at: new Date().toISOString(),
        };
        if (title) tierUpdatePayload.title = title;
        tierUpdatePayload.description = description || null;

        const { data, error } = await supabaseAdmin
          .from("super_agent_offers")
          .update(tierUpdatePayload)
          .eq("id", existing.id)
          .eq("super_agent_id", targetSuperAgentId)
          .select();

        if (error) {
          if (isMissingDatabaseObject(error)) {
            return new Response(
              JSON.stringify({
                error:
                  "The super_agent_offers table is not available yet. Run the staged migration first.",
                migration_required: true,
              }),
              {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }
          throw error;
        }

        return new Response(JSON.stringify({ offer: data?.[0] || null }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const tierInsertPayload: Record<string, unknown> = {
        super_agent_id: targetSuperAgentId,
        title: title || `${network} — ${dataValue}`,
        network,
        data_value: dataValue,
        price,
        description: description || null,
        tier_name: tierName || null,
        is_active: true,
      };

      // Only attach the default tier column when supplied so the function
      // stays compatible with databases that haven't run the tier migrations.
      if (tierName) tierInsertPayload.default_tier_name = tierName;

      const { data: inserted, error: insertError } = await supabaseAdmin
        .from("super_agent_offers")
        .insert(tierInsertPayload)
        .select();

      if (insertError) {
        if (isMissingDatabaseObject(insertError)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_offers table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw insertError;
      }

      return new Response(JSON.stringify({ offer: inserted?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "getAgentPackages") {
      // The sub-agent's super agent, from the authoritative profile. This read
      // `user_metadata.super_agent_id` first, so a sub-agent could point
      // themselves at a different super agent and read that agent's offers.
      const assignedSuperAgentId = String(identity.superAgentId || "").trim();
      const agentTier = String(
        user.user_metadata?.tier_name || user.app_metadata?.tier_name || "",
      ).trim();

      if (!assignedSuperAgentId) {
        return new Response(
          JSON.stringify({
            offers: [],
            agent_tier: null,
            reason: "no_super_agent",
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data: offerRows, error: offerError } = await supabaseAdmin
        .from("super_agent_offers")
        .select("*")
        .eq("super_agent_id", assignedSuperAgentId)
        .eq("is_active", true)
        .order("network", { ascending: true });

      if (offerError) {
        if (isMissingDatabaseObject(offerError)) {
          return new Response(
            JSON.stringify({
              offers: [],
              agent_tier: agentTier || null,
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw offerError;
      }

      const publishedOffers = (offerRows || []) as any[];
      const packageKeyOf = (row: any) =>
        `${normalizeKey(row?.network)}::${normalizeKey(row?.data_value)}`;
      const offerTier = (row: any) =>
        String(row?.tier_name || row?.default_tier_name || "").trim();

      // Tier prices win; the super agent's untiered (General) offers fill any
      // bundle the tier does not cover. Bundles priced nowhere stay hidden.
      const tierOffers = agentTier
        ? publishedOffers.filter(
            (row) => normalizeKey(offerTier(row)) === normalizeKey(agentTier),
          )
        : [];
      const coveredKeys = new Set(tierOffers.map(packageKeyOf));
      const generalOffers = publishedOffers.filter(
        (row) => offerTier(row) === "",
      );

      const selectedOffers = [...tierOffers];
      generalOffers.forEach((row) => {
        const key = packageKeyOf(row);
        if (coveredKeys.has(key)) return;
        coveredKeys.add(key);
        selectedOffers.push(row);
      });

      const { data: activePricingRows, error: activePricingError } =
        await supabaseAdmin
          .from("package_pricing")
          .select("package_id, network, type, size, is_active")
          .eq("is_active", true);

      if (activePricingError) {
        if (isMissingDatabaseObject(activePricingError)) {
          return new Response(
            JSON.stringify({
              offers: [],
              agent_tier: agentTier || null,
              migration_required: true,
              error: "The package pricing table is not available yet.",
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw activePricingError;
      }

      const activePackageIds = new Set(
        (activePricingRows || [])
          .map((row: any) => String(row?.package_id || "").trim())
          .filter(Boolean),
      );
      const activePricingKeys = new Set(
        (activePricingRows || []).map((row: any) => {
          const descriptor = normalizeKey(row?.type);
          const size = row?.size;
          const descriptorWithSize =
            size !== null &&
            size !== undefined &&
            !descriptor.includes(`${size}GB`)
              ? `${descriptor} - ${size}GB`
              : descriptor;
          return `${normalizeKey(row?.network)}::${descriptorWithSize}`;
        }),
      );

      let catalog: any[] = [];
      try {
        catalog = await fetchCatalogPackages();
      } catch (catalogError) {
        console.warn(
          "Could not load the package catalog for offer enrichment:",
          catalogError,
        );
      }

      const networkFilter = normalizeKey(body?.network);
      const enabledOffers = selectedOffers.filter((row: any) => {
        const networkKey = normalizeKey(row?.network);
        const descriptorKey = normalizeKey(row?.data_value);
        const offerPackageId = String(row?.package_id || "").trim();
        const catalogPackage = findCatalogPackageForOffer(catalog, row);
        const catalogPackageId = String(catalogPackage?.id || "").trim();
        return (
          (offerPackageId && activePackageIds.has(offerPackageId)) ||
          (catalogPackageId && activePackageIds.has(catalogPackageId)) ||
          activePricingKeys.has(`${networkKey}::${descriptorKey}`)
        );
      });

      const packages = enabledOffers
        .filter(
          (row) =>
            !networkFilter || normalizeKey(row?.network) === networkFilter,
        )
        .map((row) => {
          const catalogPackage = findCatalogPackageForOffer(catalog, row);
          const size =
            catalogPackage?.size ?? sizeFromDataValue(row?.data_value);
          const dataValue = String(row?.data_value || "");

          return {
            id: Number(row?.id),
            network: normalizeKey(row?.network),
            data_value: dataValue,
            title: row?.title || `${row?.network || ""} — ${dataValue}`.trim(),
            price: Number(row?.price || 0),
            base_price: catalogPackage?.price
              ? Number(catalogPackage.price) / 100
              : Number(row?.price || 0),
            tier_extra: Math.max(
              0,
              Number(row?.price || 0) -
                (catalogPackage?.price
                  ? Number(catalogPackage.price) / 100
                  : Number(row?.price || 0)),
            ),
            tier_name: offerTier(row) || null,
            package_id: catalogPackage?.id ?? null,
            type: catalogPackage?.type ?? null,
            size: size !== null && size !== undefined ? size : null,
          };
        });

      return new Response(
        JSON.stringify({
          offers: packages,
          agent_tier: agentTier || null,
          super_agent_id: assignedSuperAgentId,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (action === "setPackageBasePrice") {
      if (userRole !== "Admin") {
        return new Response(
          JSON.stringify({ error: "Admin access required" }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const network = String(body?.network || "").trim();
      const type = String(body?.type || "").trim();
      const basePrice = Number(body?.basePrice || body?.base_price || 0);

      if (!network || !type) {
        return new Response(
          JSON.stringify({ error: "Network and type are required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      if (!Number.isFinite(basePrice) || basePrice < 0) {
        return new Response(
          JSON.stringify({ error: "Valid base price is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data, error } = await supabaseAdmin
        .from("package_pricing")
        .upsert(
          {
            network,
            type,
            base_price: basePrice,
            created_by: user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "package_pricing_network_type_unique" },
        )
        .select();

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The package_pricing table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw error;
      }

      return new Response(JSON.stringify({ pricing: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "getPackageBasePrices") {
      const networkFilter = String(body?.network || "").trim();

      let query = supabaseAdmin
        .from("package_pricing")
        .select("*")
        .eq("is_active", true)
        .order("network", { ascending: true });

      if (networkFilter) {
        query = query.eq("network", networkFilter);
      }

      const { data, error } = await query;

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              pricing: [],
              error:
                "The package_pricing table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw error;
      }

      return new Response(JSON.stringify({ pricing: data || [] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "getPackageBasePrice") {
      const network = String(body?.network || "").trim();
      const type = String(body?.type || "").trim();

      if (!network || !type) {
        return new Response(
          JSON.stringify({ error: "Network and type are required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data, error } = await supabaseAdmin
        .from("package_pricing")
        .select("*")
        .eq("network", network)
        .eq("type", type)
        .eq("is_active", true)
        .single();

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              pricing: null,
              error:
                "The package_pricing table is not available yet. Run the staged migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        // No row found
        return new Response(JSON.stringify({ pricing: null }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ pricing: data }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unsupported action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("super-agent-offers error:", error);
    return new Response(
      JSON.stringify({
        error: error?.message || "Internal server error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
