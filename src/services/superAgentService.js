import { supabase } from "../lib/supabase.js";
import { getEdgeFunctionErrorMessage, invokeEdgeFunction } from "../lib/edgeFunctions.js";
import { getEdgeFunctionName } from "../lib/env.js";
import {
  getPackageDescriptor,
  normalizeNetwork,
  providerOf,
  resolveAgentPackageOffers,
  tierOf,
} from "../lib/superAgentPricing.js";

// Client-side fallbacks use the authenticated anon client. Privileged work is
// performed by Supabase Edge Functions, never with a browser-exposed service key.
const adminClient = supabase;
const PACKAGE_CACHE_MS = 30_000;
let catalogCache = null;
let catalogRequest = null;
const packagePricingCache = new Map();
const packagePricingRequests = new Map();
const subAgentPackageCache = new Map();
const subAgentPackageRequests = new Map();

export const formatBundleSizeFromDescriptor = (descriptor) => {
  const match = String(descriptor || "").match(/(\d+(?:\.\d+)?)\s*GB/i);
  return match ? `${match[1]} GB` : "";
};

const fetchProviderPackages = async (provider, functionName) => {
  try {
    const { data, error } = await supabase.functions.invoke(
      getEdgeFunctionName(functionName),
    );
    if (error || data?.success === false) {
      throw error || new Error(data.error || "Package request failed");
    }

    const packages = data?.payload ?? data;
    return Array.isArray(packages)
      ? packages.map((pkg) => ({ ...pkg, provider }))
      : [];
  } catch (error) {
    console.error("Could not fetch packages for", provider, error);
    return [];
  }
};

const fetchCatalogPackagesUncached = async () => {
  try {
    const { data: settings, error } = await supabase.functions.invoke(
      getEdgeFunctionName("get-provider-settings"),
    );
    if (error) throw error;

    const requests = [];
    if (settings?.jehuca_enabled === true) {
      requests.push(fetchProviderPackages("jehuca", "get-packages"));
    }
    if (settings?.bisdel_enabled === true) {
      requests.push(fetchProviderPackages("bisdel", "get-bisdel-packages"));
    }
    if (requests.length === 0) {
      console.warn("No data provider APIs are enabled.");
    }

    return (await Promise.all(requests)).flat();
  } catch (error) {
    console.error("Could not load enabled provider settings:", error);
    return [];
  }
};

export const fetchCatalogPackages = async () => {
  if (catalogCache && catalogCache.expiresAt > Date.now()) {
    return catalogCache.data;
  }
  if (catalogRequest) return catalogRequest;

  catalogRequest = fetchCatalogPackagesUncached()
    .then((catalog) => {
      if (catalog.length > 0) {
        catalogCache = {
          data: catalog,
          expiresAt: Date.now() + PACKAGE_CACHE_MS,
        };
      }
      return catalog;
    })
    .finally(() => {
      catalogRequest = null;
    });

  return catalogRequest;
};

export const fetchPackagePricing = async (
  table,
  providers,
  columns,
  cacheScope = "",
) => {
  const uniqueProviders = [...new Set(providers)].sort();
  if (uniqueProviders.length === 0) return { data: [], error: null };

  const key = `${cacheScope}:${table}:${uniqueProviders.join(",")}:${columns}`;
  const cached = packagePricingCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { data: cached.data, error: null };
  }

  const existingRequest = packagePricingRequests.get(key);
  if (existingRequest) return existingRequest;

  const request = adminClient
    .from(table)
    .select(columns)
    .in("provider", uniqueProviders)
    .eq("is_active", true)
    .then((result) => {
      if (!result.error && Array.isArray(result.data)) {
        packagePricingCache.set(key, {
          data: result.data,
          expiresAt: Date.now() + PACKAGE_CACHE_MS,
        });
      }
      return result;
    })
    .finally(() => {
      packagePricingRequests.delete(key);
    });

  packagePricingRequests.set(key, request);
  return request;
};

export const fetchSuperAgentPackageBasePrices = async () => {
  const { data, error } = await invokeEdgeFunction("super-agent-offers", {
    body: { action: "getPackageBasePrices" },
  });
  if (error) throw new Error(await getEdgeFunctionErrorMessage(error));
  if (data?.error) throw new Error(data.error);
  return {
    pricing: data?.pricing || [],
    providers: data?.providers ?? null,
  };
};

/**
 * Loads data packages for a sub-agent from their assigned super agent's published offers.
 * Resolves tier pricing precedence (tier-specific prices win; General untiered offers fill the rest).
 *
 * `superAgentId` is PASSED IN from `public.user_profiles.super_agent_id`, read by
 * the caller through `ProfileContext`. It used to be dug out of
 * `user.user_metadata.super_agent_id` here, which the account owner can rewrite
 * at will with `auth.updateUser()` - so a sub-agent could point their package
 * list at any Super Agent's catalogue, and the offers/prices returned here were
 * resolved against that chosen owner. The server enforces the real owner
 * (`resolveIdentity` reads the profile), so the client must not nominate one.
 *
 * `tier_name` still comes from metadata: it is display/pricing context rather
 * than an authorization input, and `user_profiles` has no such column.
 */
const loadSubAgentPackagesUncached = async ({
  user,
  superAgentId: resolvedSuperAgentId = null,
}) => {
  if (!user) {
    return { offers: [], agent_tier: null, error: "User is required" };
  }

  const assignedSuperAgentId = String(resolvedSuperAgentId || "").trim();

  const agentTier = String(
    user.user_metadata?.tier_name || user.app_metadata?.tier_name || "",
  ).trim();

  if (!assignedSuperAgentId) {
    return {
      offers: [],
      agent_tier: null,
      reason: "no_super_agent",
    };
  }

  // 1. Attempt edge function first
  try {
    const { data: edgeData, error: edgeError } =
      await supabase.functions.invoke(
        getEdgeFunctionName("super-agent-offers"),
        // Load every network so the Home prefetch can serve any DataScreen route.
        { body: { action: "getAgentPackages" } },
      );

    if (!edgeError && edgeData && Array.isArray(edgeData.offers)) {
      if (edgeData.migration_required) {
        return {
          offers: [],
          agent_tier: edgeData.agent_tier || agentTier || null,
          super_agent_id: assignedSuperAgentId,
          error:
            edgeData.error || "The assigned package database is not ready.",
        };
      }

      return {
        offers: edgeData.offers,
        agent_tier: edgeData.agent_tier || agentTier || null,
        super_agent_id: edgeData.super_agent_id || assignedSuperAgentId,
      };
    }

    if (edgeError) {
      return {
        offers: [],
        agent_tier: agentTier || null,
        super_agent_id: assignedSuperAgentId,
        error: edgeError.message || "Could not load assigned packages.",
      };
    }
  } catch (edgeErr) {
    console.warn(
      "Edge function getAgentPackages error, using direct service:",
      edgeErr,
    );
  }

  // 2. Direct fallback via adminClient
  try {
    const { data: offerRows, error: offerError } = await adminClient
      .from("super_agent_offers")
      .select("*")
      .eq("super_agent_id", assignedSuperAgentId)
      .eq("is_active", true)
      .order("network", { ascending: true });

    if (offerError) {
      console.error("Direct query super_agent_offers error:", offerError);
      return {
        offers: [],
        agent_tier: agentTier || null,
        error: offerError.message,
      };
    }

    const catalog = await fetchCatalogPackages();
    const providers = [...new Set(catalog.map((pkg) => pkg.provider))];
    if (providers.length === 0) {
      return {
        offers: [],
        agent_tier: agentTier || null,
        super_agent_id: assignedSuperAgentId,
        providers: [],
      };
    }
    const { data: activePricingRows, error: activePricingError } =
      await fetchPackagePricing(
        "package_pricing",
        providers,
        "id, provider, package_id, network, base_price, is_active, updated_at",
        user.id,
      );

    if (activePricingError) {
      console.warn(
        "Could not load active package pricing:",
        activePricingError,
      );
      return {
        offers: [],
        agent_tier: agentTier || null,
        error: "Could not load enabled packages.",
      };
    }

    const mappedPackages = resolveAgentPackageOffers(
      catalog,
      activePricingRows || [],
      offerRows || [],
      agentTier,
    ).map(({ pkg, base, offer, price }) => {
      const descriptor = getPackageDescriptor(pkg);
      const network = normalizeNetwork(pkg.network);
      const title = offer.title || `${network} — ${descriptor}`;

      return {
        id: String(offer.id),
        superAgentOfferId: offer.id,
        package_id: pkg.id,
        provider: providerOf(pkg),
        network,
        data_value: descriptor,
        type: pkg.type || descriptor,
        title,
        name: title,
        price,
        base_price: base,
        tier_extra: Math.max(0, price - base),
        tier_name: tierOf(offer) || null,
        size: pkg.size ?? null,
        dataSize: pkg.size == null ? "" : `${pkg.size} GB`,
      };
    });

    return {
      offers: mappedPackages,
      agent_tier: agentTier || null,
      super_agent_id: assignedSuperAgentId,
      providers,
    };
  } catch (err) {
    console.error("Failed to load sub-agent packages directly:", err);
    return { offers: [], agent_tier: agentTier || null, error: err.message };
  }
};

export const loadSubAgentPackages = async (options) => {
  const { user, superAgentId } = options || {};
  if (!user) {
    return { offers: [], agent_tier: null, error: "User is required" };
  }

  const tier = String(
    user.user_metadata?.tier_name || user.app_metadata?.tier_name || "",
  ).trim();
  const key = `${user.id}:${String(superAgentId || "")}:${tier}`;
  const cached = subAgentPackageCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const existingRequest = subAgentPackageRequests.get(key);
  if (existingRequest) return existingRequest;

  const request = loadSubAgentPackagesUncached(options)
    .then((result) => {
      if (!result.error) {
        subAgentPackageCache.set(key, {
          data: result,
          expiresAt: Date.now() + PACKAGE_CACHE_MS,
        });
      }
      return result;
    })
    .finally(() => {
      subAgentPackageRequests.delete(key);
    });

  subAgentPackageRequests.set(key, request);
  return request;
};

export const preloadDataPackages = async ({
  user,
  isSubAgent,
  isSuperAgent,
  superAgentId,
}) => {
  if (isSubAgent && superAgentId) {
    await loadSubAgentPackages({ user, superAgentId });
    return;
  }

  const catalog = await fetchCatalogPackages();
  if (catalog.length === 0) return;

  const providers = [...new Set(catalog.map((pkg) => pkg.provider))];
  const table = isSuperAgent || isSubAgent
    ? "package_pricing"
    : "normal_user_package_pricing";
  const { error } = await fetchPackagePricing(
    table,
    providers,
    "provider, package_id, network, type, size, base_price, is_active",
    user.id,
  );
  if (error) {
    console.warn("Could not prefetch package pricing:", error);
  }
};

/**
 * Super agent updates a sub-agent's assigned tier.
 * Saves immediately to user_metadata.tier_name.
 */
export const updateSubAgentTier = async ({
  superAgentId,
  agentId,
  tierName,
}) => {
  if (!superAgentId || !agentId) {
    throw new Error("superAgentId and agentId are required");
  }

  const cleanTierName = String(tierName || "").trim() || null;

  // 1. Try edge function first
  try {
    const { data: edgeData, error: edgeError } =
      await supabase.functions.invoke(
        getEdgeFunctionName("super-agent-user-management"),
        {
          body: {
            action: "updateSubAgent",
            userData: { agent_id: agentId, tier_name: cleanTierName },
          },
        },
      );

    if (!edgeError && edgeData && !edgeData.error) {
      return { success: true, tier_name: cleanTierName };
    }
  } catch (edgeErr) {
    console.warn(
      "Edge function updateSubAgent failed, using direct admin fallback:",
      edgeErr,
    );
  }

  // 2. Direct fallback via adminClient
  try {
    const { data: userData, error: fetchError } =
      await adminClient.auth.admin.getUserById(agentId);

    if (fetchError || !userData?.user) {
      throw new Error("Sub-agent not found");
    }

    const existingMeta = userData.user.user_metadata || {};
    const subAgentSuperId = String(
      existingMeta.super_agent_id || existingMeta.superAgentId || "",
    );

    if (subAgentSuperId !== String(superAgentId)) {
      throw new Error("Sub-agent does not belong to this super agent");
    }

    const mergedMeta = {
      ...existingMeta,
      tier_name: cleanTierName,
    };

    const { data: updatedData, error: updateError } =
      await adminClient.auth.admin.updateUserById(agentId, {
        user_metadata: mergedMeta,
      });

    if (updateError) {
      throw updateError;
    }

    return {
      success: true,
      tier_name: cleanTierName,
      user: updatedData?.user,
    };
  } catch (err) {
    console.error("Direct updateSubAgentTier error:", err);
    throw err;
  }
};

/**
 * Fetches active tiers configured by a super agent.
 */
export const fetchSuperAgentTiers = async (superAgentId) => {
  if (!superAgentId) return [];

  // 1. Try edge function
  try {
    const { data, error } = await supabase.functions.invoke(
      getEdgeFunctionName("super-agent-tier-management"),
      { body: { action: "listTiers" } },
    );
    if (!error && Array.isArray(data?.tiers)) {
      return data.tiers.filter((t) => t.is_active !== false);
    }
  } catch (e) {
    // proceed to direct fallback
  }

  // 2. Direct query fallback
  try {
    const { data, error } = await adminClient
      .from("super_agent_tiers")
      .select("*")
      .eq("super_agent_id", superAgentId)
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("Failed to fetch super agent tiers:", err);
    return [];
  }
};

/**
 * Upserts a tier-specific offer for a super agent.
 */
export const upsertTierOffer = async ({ superAgentId, offer }) => {
  const {
    network,
    data_value,
    tier_name,
    price,
    provider = "jehuca",
    uses_admin_base_price = false,
  } = offer;

  // 1. Try edge function
  try {
    const { data, error } = await supabase.functions.invoke(
      getEdgeFunctionName("super-agent-offers"),
      {
        body: {
          action: "upsertTierOffer",
          offer: {
            network,
            data_value,
            tier_name,
            provider,
            price: Number(price),
            uses_admin_base_price: uses_admin_base_price === true,
          },
        },
      },
    );

    if (!error && data && !data.error) {
      return data;
    }
  } catch (e) {
    // proceed to direct fallback
  }

  // 2. Direct fallback via adminClient
  try {
    const net = String(network || "").trim();
    const dataVal = String(data_value || "").trim();
    const tierName = String(tier_name || "").trim() || null;
    const priceNum = Number(price);

    // Check if an existing row matches (super_agent_id, network, data_value, tier_name)
    let query = adminClient
      .from("super_agent_offers")
      .select("id")
      .eq("super_agent_id", superAgentId)
      .eq("network", net)
      .eq("data_value", dataVal)
      .eq("provider", provider);

    if (tierName) {
      query = query.eq("tier_name", tierName);
    } else {
      query = query.is("tier_name", null);
    }

    const { data: existingRows } = await query.limit(1);

    if (existingRows && existingRows.length > 0) {
      const existingId = existingRows[0].id;
      const { data, error } = await adminClient
        .from("super_agent_offers")
        .update({
          price: priceNum,
          uses_admin_base_price: uses_admin_base_price === true,
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingId)
        .select();

      if (error) throw error;
      return { offer: data?.[0] };
    }

    const { data, error } = await adminClient
      .from("super_agent_offers")
      .insert({
        super_agent_id: superAgentId,
        title: `${net} — ${dataVal}`,
        network: net,
        data_value: dataVal,
        provider,
        tier_name: tierName,
        price: priceNum,
        uses_admin_base_price: uses_admin_base_price === true,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select();

    if (error) throw error;
    return { offer: data?.[0] };
  } catch (err) {
    console.error("Direct upsertTierOffer error:", err);
    throw err;
  }
};

/**
 * Upserts a general or custom offer for a super agent.
 */
export const upsertSuperAgentOffer = async ({ superAgentId, offer }) => {
  // 1. Try edge function
  try {
    const { data, error } = await supabase.functions.invoke(
      getEdgeFunctionName("super-agent-offers"),
      {
        body: {
          action: "upsertOffer",
          offer,
        },
      },
    );

    if (!error && data && !data.error) {
      return data;
    }
  } catch (e) {
    // proceed to direct fallback
  }

  // 2. Direct fallback
  try {
    const offerId = offer.id ? Number(offer.id) : null;
    const payload = {
      super_agent_id: superAgentId,
      title: offer.title || `${offer.network} — ${offer.data_value}`,
      network: String(offer.network || "").trim(),
      data_value: String(offer.data_value || "").trim(),
      price: Number(offer.price),
      tier_name: offer.tier_name ? String(offer.tier_name).trim() : null,
      is_active: offer.is_active !== false,
      updated_at: new Date().toISOString(),
    };

    if (offerId) {
      const { data, error } = await adminClient
        .from("super_agent_offers")
        .update(payload)
        .eq("id", offerId)
        .select();
      if (error) throw error;
      return { offer: data?.[0] };
    }

    const { data, error } = await adminClient
      .from("super_agent_offers")
      .insert({
        ...payload,
        created_at: new Date().toISOString(),
      })
      .select();

    if (error) throw error;
    return { offer: data?.[0] };
  } catch (err) {
    console.error("Direct upsertSuperAgentOffer error:", err);
    throw err;
  }
};

/**
 * Creates a sub-agent assigned to the given super agent and initial tier.
 */
export const createSubAgent = async ({
  superAgentId,
  email,
  password,
  fullName,
  businessName,
  phone = null,
  tierName = null,
}) => {
  const cleanEmail = String(email || "").trim();
  const cleanPassword = String(password || "").trim();
  const cleanFullName = String(fullName || "").trim();
  const cleanBusinessName = String(businessName || "").trim();
  const cleanPhone = String(phone || "").trim() || null;
  const cleanTier = String(tierName || "").trim() || null;

  const { data, error } = await supabase.functions.invoke(
    getEdgeFunctionName("super-agent-user-management"),
    {
      body: {
        action: "createSubAgent",
        userData: {
          email: cleanEmail,
          password: cleanPassword,
          full_name: cleanFullName,
          business_name: cleanBusinessName,
          phone: cleanPhone,
          tier_name: cleanTier,
        },
      },
    },
  );

  if (error) throw error;
  if (!data || data.error || !data.user) {
    throw new Error(
      data?.error || "Unable to create this sub-agent right now.",
    );
  }
  return data;
};

/**
 * Updates an offer's price or active status with edge function + direct fallback.
 */
export const updateSuperAgentOffer = async ({ offerId, updates }) => {
  // 1. Try edge function
  try {
    const { data, error } = await supabase.functions.invoke(
      getEdgeFunctionName("super-agent-offers"),
      {
        body: {
          action: "updateOffer",
          offer: { id: offerId, ...updates },
        },
      },
    );
    if (!error && data && !data.error) {
      return data;
    }
  } catch (e) {
    // proceed to direct fallback
  }

  // 2. Direct fallback
  try {
    const payload = {
      ...updates,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await adminClient
      .from("super_agent_offers")
      .update(payload)
      .eq("id", offerId)
      .select();
    if (error) throw error;
    return { offer: data?.[0] };
  } catch (err) {
    console.error("Direct updateSuperAgentOffer error:", err);
    throw err;
  }
};

/**
 * Deletes an offer with edge function + direct fallback.
 */
export const deleteSuperAgentOffer = async (offerId) => {
  // 1. Try edge function
  try {
    const { data, error } = await supabase.functions.invoke(
      getEdgeFunctionName("super-agent-offers"),
      { body: { action: "deleteOffer", offer: { id: offerId } } },
    );
    if (!error && data && !data.error) {
      return data;
    }
  } catch (e) {
    // proceed to direct fallback
  }

  // 2. Direct fallback
  try {
    const { error } = await adminClient
      .from("super_agent_offers")
      .delete()
      .eq("id", offerId);
    if (error) throw error;
    return { success: true };
  } catch (err) {
    console.error("Direct deleteSuperAgentOffer error:", err);
    throw err;
  }
};
