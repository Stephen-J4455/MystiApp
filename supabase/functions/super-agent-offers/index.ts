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

// Display-casing only. Authorization comes from the resolved Identity.
const ROLE_DISPLAY: Record<string, string> = {
  admin: "Admin",
  super_agent: "SuperAgent",
  sub_agent: "Agent",
  normal_user: "Normal User",
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

const normalizeNetworkKey = (value: unknown) => {
  const key = normalizeKey(value);
  return key === "VODAFONE" || key === "VOD" ? "TELECEL" : key;
};

const providerOf = (row: any) =>
  String(row.provider || "jehuca").trim().toLowerCase();

const offerTier = (row: any) =>
  String(row.tier_name || row.default_tier_name || "").trim();

const positivePrice = (value: unknown) => {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
};

const packageKey = (provider: string, network: string, id: unknown) => {
  const packageId = String(id ?? "").trim();
  return provider && network && packageId
    ? JSON.stringify([provider, network, packageId])
    : null;
};

const compareNewest = (a: any, b: any) =>
  (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) ||
  Number(b.id || 0) - Number(a.id || 0);

const getPackageDescriptor = (pkg: any) => {
  const type = String(pkg.type || "").trim();
  const size = String(pkg.size ?? "").trim() ? `${pkg.size}GB` : "";
  if (size && !normalizeKey(type).includes(size)) return `${type} - ${size}`;
  return type || size || "DEFAULT";
};

const findOfferPackage = (candidates: any[], offer: any) => {
  const id = String(offer.package_id ?? "").trim();
  if (id) return candidates.find(({ pkg }) => String(pkg.id).trim() === id);

  const descriptor = normalizeKey(offer.data_value);
  if (!descriptor) return;
  const byId = candidates.find(({ pkg }) => normalizeKey(pkg.id) === descriptor);
  if (byId) return byId;

  // Older offers can be attached by description when it identifies one active package.
  const exact = candidates.filter(({ pkg }) => {
    const type = normalizeKey(pkg.type);
    const size = pkg.size == null ? "" : `${pkg.size}GB`;
    return descriptor === normalizeKey(getPackageDescriptor(pkg)) || Boolean(size && [
      `${type} - ${size}`, `${type} (${size})`, `${type} ${size}`, `${type}-${size}`,
    ].includes(descriptor));
  });
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;

  const byType = candidates.filter(({ pkg }) => normalizeKey(pkg.type) === descriptor);
  return byType.length === 1 ? byType[0] : undefined;
};

const resolveAgentPackages = (
  catalog: any[],
  pricingRows: any[],
  offers: any[],
  agentTier: string,
  networkFilter: string,
) => {
  const catalogById = new Map();
  for (const pkg of catalog) {
    const key = packageKey(providerOf(pkg), normalizeNetworkKey(pkg.network), pkg.id);
    if (key && !catalogById.has(key)) catalogById.set(key, pkg);
  }

  const cardsByNetwork = new Map();
  for (const row of [...pricingRows].sort(compareNewest)) {
    if (row.is_active === false) continue;
    const provider = String(row.provider ?? "").trim().toLowerCase();
    const network = normalizeNetworkKey(row.network);
    if (networkFilter && network !== networkFilter) continue;

    const key = packageKey(provider, network, row.package_id);
    if (!key || !catalogById.has(key)) continue;
    const pkg = catalogById.get(key);
    catalogById.delete(key);
    const base = positivePrice(row.base_price);
    if (base === null) continue;

    const group = JSON.stringify([provider, network]);
    const candidates = cardsByNetwork.get(group) || [];
    candidates.push({ key, pkg, base });
    cardsByNetwork.set(group, candidates);
  }

  const tier = normalizeKey(agentTier);
  const packages = new Map();
  const eligible = offers
    .filter((offer) => {
      const name = normalizeKey(offerTier(offer));
      return offer.is_active === true && (!name || name === tier);
    })
    .sort((a, b) =>
      Number(Boolean(offerTier(b))) - Number(Boolean(offerTier(a))) ||
      Number(Boolean(b.package_id)) - Number(Boolean(a.package_id)) ||
      compareNewest(a, b)
    );

  for (const offer of eligible) {
    const provider = providerOf(offer);
    const network = normalizeNetworkKey(offer.network);
    const candidates = cardsByNetwork.get(JSON.stringify([provider, network])) || [];
    const card = findOfferPackage(candidates, offer);
    if (!card || packages.has(card.key)) continue;

    const { key, pkg, base } = card;
    const price = offer.uses_admin_base_price ? base : positivePrice(offer.price);
    if (price === null) continue;
    const descriptor = getPackageDescriptor(pkg);
    packages.set(key, {
      id: Number(offer.id),
      network,
      data_value: descriptor,
      title: offer.title || `${network} — ${descriptor}`,
      price,
      base_price: base,
      tier_extra: Math.max(0, price - base),
      tier_name: offerTier(offer) || null,
      package_id: pkg.id,
      type: pkg.type || descriptor,
      size: pkg.size ?? null,
      provider,
    });
  }
  return [...packages.values()];
};

const getActiveProvider = async (admin: ReturnType<typeof createClient>) => {
  const { data, error } = await admin
    .from("data_provider_settings")
    .select("provider")
    .eq("id", true)
    .single();
  if (error) throw error;
  const provider = String(data.provider || "").toLowerCase();
  if (provider !== "jehuca" && provider !== "bisdel") {
    throw new Error("Configured data provider is invalid");
  }
  return provider;
};

const getEnabledProviders = async (
  admin: ReturnType<typeof createClient>,
) => {
  const { data, error } = await admin
    .from("data_provider_settings")
    .select("jehuca_enabled, bisdel_enabled")
    .eq("id", true)
    .single();
  if (error) throw error;
  return [
    ...(data.jehuca_enabled === true ? ["jehuca"] : []),
    ...(data.bisdel_enabled === true ? ["bisdel"] : []),
  ];
};

const fetchCatalogPackages = async (
  provider: string,
) => {
  if (provider === "bisdel") {
    const apiKey = (Deno.env.get("TELCOGH_API_KEY") ?? "").replace(/\0/g, "").trim() ||
      (Deno.env.get("BISDEL_DB") ?? "").replace(/\0/g, "").trim();
    if (!apiKey) {
      throw new Error("Bisdel API credentials are not configured");
    }
    const response = await fetch("https://telcogh.com/api/v1/products", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json();
    const products = data?.data?.products ?? data?.data ?? data?.products;
    if (!response.ok || data?.status === "error" || !Array.isArray(products)) {
      throw new Error(data?.message || data?.error || "Bisdel package request failed");
    }
    return products.map((product: Record<string, unknown>) => {
      const dataVolume = String(product.package_size ?? product.data_volume ?? product.size ?? "");
      const apiPrice = Number(product.api_price ?? product.price);
      return {
        id: String(product.product_id ?? product.id ?? ""),
        network: String(product.network || "").trim().toUpperCase()
          .replace(/^MTN.*$/, "MTN"),
        type: String(product.name || dataVolume).trim(),
        size: Number(
          dataVolume.match(/(\d+(?:\.\d+)?)\s*GB/i)?.[1] || 0,
        ),
        price: Number.isFinite(apiPrice) ? Math.round(apiPrice * 100) : 0,
        data_volume: dataVolume,
        provider,
      };
    }).filter((pkg: { id: string; size: number; price: number }) =>
      pkg.id && pkg.size > 0 && pkg.price > 0
    );
  }

  const apiKey = Deno.env.get("JEHUCA_API_KEY");
  if (!apiKey) throw new Error("Jehuca API key is not configured");
  const response = await fetch(
    "https://backend.jehucale-business.com/api/packages",
    { headers: { "X-API-Key": apiKey } },
  );
  const data = await response.json();
  return (Array.isArray(data?.payload) ? data.payload : []).map(
    (pkg: Record<string, unknown>) => ({ ...pkg, provider }),
  );
};

const fetchEnabledCatalog = async (providers: string[]) => {
  const catalogs = await Promise.all(providers.map(async (provider) => {
    try {
      return await fetchCatalogPackages(provider);
    } catch (error) {
      console.warn("Could not load package catalog for", provider, error);
      return [];
    }
  }));
  return catalogs.flat();
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
      const providers = await getEnabledProviders(supabaseAdmin);
      if (providers.length === 0) {
        return new Response(JSON.stringify({ offers: [], providers }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const catalog = await fetchEnabledCatalog(providers);
      const networkFilter = String(
        offer?.network || body?.network || "",
      ).trim().toUpperCase();
      const typeFilter = String(offer?.type || body?.type || "").trim();
      const offers = catalog.filter((pkg: Record<string, unknown>) =>
        (!networkFilter ||
          normalizeNetworkKey(pkg.network) ===
            normalizeNetworkKey(networkFilter)) &&
        (!typeFilter ||
          normalizeKey(pkg.type).includes(normalizeKey(typeFilter)))
      );
      return new Response(JSON.stringify({ offers, providers }), {
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
      if (offer?.uses_admin_base_price !== undefined) {
        updatePayload.uses_admin_base_price =
          Boolean(offer.uses_admin_base_price);
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
      const provider = String(offer?.provider || "jehuca").trim().toLowerCase();
      const price = Number(offer?.price || 0);
      const usesAdminBasePrice = offer?.uses_admin_base_price === true;
      const title = String(offer?.title || "").trim();
      const description = String(offer?.description || "").trim();

      if (!network || !dataValue || !["jehuca", "bisdel"].includes(provider)) {
        return new Response(
          JSON.stringify({ error: "Provider, network, and data value are required" }),
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
        .eq("provider", provider)
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
          uses_admin_base_price: usesAdminBasePrice,
          provider,
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
        provider,
        price,
        uses_admin_base_price: usesAdminBasePrice,
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
      const providers = await getEnabledProviders(supabaseAdmin);
      if (providers.length === 0) {
        return new Response(
          JSON.stringify({
            offers: [],
            agent_tier: null,
            super_agent_id: assignedSuperAgentId,
            providers,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // The tier is NOT on `user_profiles`, so it has to come from the auth
      // record. It is not on `identity` either, and it cannot be read off the
      // `user` alias above: that object is a synthetic
      // `{ id, email }` built from the verified token (see the comment where it
      // is declared) and deliberately carries no metadata, so
      // `user.user_metadata?.tier_name` was permanently `undefined`.
      //
      // The effect was silent and severe: `agentTier` was always "", so
      // `tierOffers` was always empty and ONLY the super agent's untiered
      // "General" offers ever reached a sub-agent. Any bundle priced under
      // that sub-agent's tier was filtered out by `tierOffers` never matching,
      // and a super agent who published tier-only pricing (no General offers at
      // all) produced an empty list - the Data Screen showed no packages.
      //
      // `super-agent-user-management` `updateSubAgent` writes this field to
      // `user_metadata` only, so that is the store to read. It is a display
      // and pricing-precedence input, not an authorization decision, so
      // reading the user-writable store is acceptable here - the same argument
      // as the badge read above. Ownership still comes from
      // `identity.superAgentId`, so this cannot be used to reach another
      // agent's offers.
      const { data: callerAuth } = await supabaseAdmin.auth.admin.getUserById(
        identity.id,
      );
      const callerMeta = {
        ...(callerAuth?.user?.app_metadata || {}),
        ...(callerAuth?.user?.user_metadata || {}),
      };
      const agentTier = String(callerMeta.tier_name || "").trim();

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
        .in("provider", providers)
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

      const { data: activePricingRows, error: activePricingError } =
        await supabaseAdmin
          .from("package_pricing")
          .select("id, provider, package_id, network, base_price, is_active, updated_at")
          .in("provider", providers)
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

      const catalog = await fetchEnabledCatalog(providers);
      const packages = resolveAgentPackages(
        catalog,
        activePricingRows || [],
        offerRows || [],
        agentTier,
        normalizeNetworkKey(body?.network),
      );

      return new Response(
        JSON.stringify({
          offers: packages,
          agent_tier: agentTier || null,
          super_agent_id: assignedSuperAgentId,
          providers,
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
      const provider = await getActiveProvider(supabaseAdmin);
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
            provider,
            network,
            type,
            base_price: basePrice,
            created_by: user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "provider,network,type" },
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
      const providers = await getEnabledProviders(supabaseAdmin);
      if (providers.length === 0) {
        return new Response(JSON.stringify({ pricing: [], providers }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let query = supabaseAdmin
        .from("package_pricing")
        .select("*")
        .in("provider", providers)
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

      return new Response(JSON.stringify({ pricing: data || [], providers }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "getPackageBasePrice") {
      const network = String(body?.network || "").trim();
      const type = String(body?.type || "").trim();
      const provider = String(
        body?.provider || await getActiveProvider(supabaseAdmin),
      ).trim().toLowerCase();
      if (!["jehuca", "bisdel"].includes(provider)) {
        return new Response(JSON.stringify({ error: "Unsupported provider" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

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
        .eq("provider", provider)
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

      return new Response(JSON.stringify({ pricing: data, provider }), {
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
