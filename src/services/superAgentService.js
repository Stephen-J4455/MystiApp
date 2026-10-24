import { supabase } from "../lib/supabase.js";
import { invokeEdgeFunction } from "../lib/edgeFunctions.js";
import { getEdgeFunctionName } from "../lib/env.js";

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

const normalizeKey = (val) => String(val || "").trim().toUpperCase();

const normalizeNetworkKey = (val) => {
  const key = normalizeKey(val);
  return key === "VODAFONE" || key === "VOD" ? "TELECEL" : key;
};

export const formatBundleSizeFromDescriptor = (descriptor) => {
  const match = String(descriptor || "").match(/(\d+(?:\.\d+)?)\s*GB/i);
  return match ? `${match[1]} GB` : "";
};

const sizeFromDataValue = (dataValue) => {
  const match = String(dataValue || "").match(/(\d+(?:\.\d+)?)\s*GB/i);
  return match ? Number(match[1]) : null;
};

const fetchCatalogPackagesUncached = async () => {
  try {
    const { data: providerData, error: providerError } =
      await supabase.functions.invoke(
        getEdgeFunctionName("get-bisdel-packages"),
      );
    if (providerError) {
      console.error("Could not load enabled provider settings:", providerError);
      return [];
    }

    const catalog = [];
    if (providerData?.jehuca_enabled === true) {
      const { data: jehucaData, error: jehucaError } =
        await supabase.functions.invoke(getEdgeFunctionName("get-packages"));
      if (jehucaError) {
        console.error("Could not fetch Jehuca packages:", jehucaError);
      } else {
        const jehucaPackages = jehucaData?.payload || jehucaData || [];
        if (Array.isArray(jehucaPackages)) {
          catalog.push(
            ...jehucaPackages.map((pkg) => ({
              ...pkg,
              provider: "jehuca",
            })),
          );
        }
      }
    }

    if (providerData?.bisdel_enabled === true) {
      if (providerData?.success === false) {
        console.error(
          "Could not fetch enabled Bisdel packages:",
          providerData.error || providerData,
        );
      } else if (Array.isArray(providerData?.payload)) {
        catalog.push(
          ...providerData.payload.map((pkg) => ({
            ...pkg,
          })),
        );
      }
    }

    if (
      providerData?.jehuca_enabled !== true &&
      providerData?.bisdel_enabled !== true
    ) {
      console.warn("No data provider APIs are enabled.");
    }

    if (catalog.length === 0 && providerData?.success === false) {
      console.error("No enabled provider catalog could be loaded.");
    }

    if (!Array.isArray(catalog)) {
      console.error("Combined provider catalog is invalid:", providerData);
      return [];
    }

    return catalog;
  } catch (err) {
    console.error("Provider catalog request failed:", err);
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

const findCatalogPackageForOffer = (catalog, offer) => {
  if (!Array.isArray(catalog) || catalog.length === 0) return null;
  const net = normalizeNetworkKey(offer?.network);
  const dataVal = normalizeKey(offer?.data_value);
  if (!dataVal) return null;

  return (
    catalog.find((pkg) => {
      if (
        offer?.provider &&
        String(pkg?.provider || "jehuca").toLowerCase() !==
          String(offer.provider).toLowerCase()
      ) {
        return false;
      }
      if (normalizeNetworkKey(pkg?.network) !== net) return false;
      const type = normalizeKey(pkg?.type);
      const size =
        pkg?.size !== undefined &&
        pkg?.size !== null &&
        String(pkg.size).trim() !== ""
          ? `${pkg.size}GB`
          : "";
      const descriptor =
        size && !type.includes(size) ? `${type} - ${size}` : type || size;

      if (descriptor && descriptor === dataVal) return true;
      if (
        String(pkg?.id || "")
          .trim()
          .toUpperCase() === dataVal
      )
        return true;
      if (
        size &&
        (dataVal === `${type} - ${size}` ||
          dataVal === `${type} (${size})` ||
          dataVal === `${type} ${size}` ||
          dataVal === `${type}-${size}`)
      ) {
        return true;
      }
      return false;
    }) || null
  );
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
  network = null,
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
        // Do not send the UI network filter to the edge. Bisdel calls its
        // Telecel catalog "Vodafone"; filtering there by "TELECEL" would
        // discard those offers before the client can normalize the alias.
        // Filter locally below, after the server returns authorized offers.
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

    const publishedOffers = Array.isArray(offerRows) ? offerRows : [];
    const packageKeyOf = (row) =>
      `${normalizeKey(row?.provider || "jehuca")}::${normalizeNetworkKey(row?.network)}::${normalizeKey(row?.data_value)}`;
    const offerTier = (row) =>
      String(row?.tier_name || row?.default_tier_name || "").trim();

    // Tier offers win; General (untiered) offers fill any bundle the tier does not cover
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
      if (!coveredKeys.has(key)) {
        coveredKeys.add(key);
        selectedOffers.push(row);
      }
    });

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
    const networkFilter = network ? normalizeNetworkKey(network) : null;
    const { data: activePricingRows, error: activePricingError } =
      await fetchPackagePricing(
        "package_pricing",
        providers,
        "provider, package_id, network, type, size, base_price",
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

    const activePricingKeys = new Set(
      (activePricingRows || []).map((row) => {
        const descriptor = normalizeKey(row?.type);
        const rowSize = row?.size;
        const descriptorWithSize =
          rowSize !== null &&
          rowSize !== undefined &&
          !descriptor.includes(`${rowSize}GB`)
            ? `${descriptor} - ${rowSize}GB`
            : descriptor;
        return `${normalizeKey(row?.provider)}::${normalizeNetworkKey(row?.network)}::${descriptorWithSize}`;
      }),
    );
    const activePackageIds = new Set(
      (activePricingRows || [])
        .map((row) => `${normalizeKey(row?.provider)}::${String(row?.package_id || "")}`)
        .filter(Boolean),
    );

    const mappedPackages = selectedOffers
      .filter((row) => {
        const rowPackageId = String(row?.package_id || "");
        const catalogPackage = findCatalogPackageForOffer(catalog, row);
        const catalogPackageId = String(catalogPackage?.id || "");
        const provider = String(row?.provider || "jehuca").toLowerCase();
        const rowKey = `${normalizeKey(provider)}::${normalizeNetworkKey(row?.network)}::${normalizeKey(row?.data_value)}`;
        return (
          (rowPackageId &&
            activePackageIds.has(`${normalizeKey(provider)}::${rowPackageId}`)) ||
          (catalogPackageId &&
            activePackageIds.has(`${normalizeKey(provider)}::${catalogPackageId}`)) ||
          activePricingKeys.has(rowKey)
        );
      })
      .filter(
        (row) => !networkFilter || normalizeNetworkKey(row?.network) === networkFilter,
      )
      .map((row) => {
        const provider = String(row?.provider || "jehuca").toLowerCase();
        const providerCatalog = catalog.filter(
          (pkg) => String(pkg?.provider || "jehuca").toLowerCase() === provider,
        );
        const catalogPackage = findCatalogPackageForOffer(providerCatalog, row);
        const descriptor = String(row?.data_value || "");
        const size = catalogPackage?.size ?? sizeFromDataValue(descriptor);

        const normalizedDescriptor = normalizeKey(descriptor);
        const packageBasePriceRow = (activePricingRows || []).find(
          (pricing) => {
            if (normalizeKey(pricing?.provider) !== normalizeKey(provider)) {
              return false;
            }
            if (
              catalogPackage?.id &&
              String(pricing?.package_id || "") === String(catalogPackage.id)
            ) {
              return true;
            }
            const pricingType = normalizeKey(pricing?.type);
            const pricingSize =
              pricing?.size !== null &&
              pricing?.size !== undefined &&
              String(pricing.size).trim() !== ""
                ? `${pricing.size}GB`
                : "";
            const pricingDescriptor =
              pricingSize && !pricingType.includes(pricingSize)
                ? `${pricingType} - ${pricingSize}`
                : pricingType;
            return (
              normalizeNetworkKey(pricing?.network) ===
                normalizeNetworkKey(row?.network) &&
              (pricingDescriptor === normalizedDescriptor ||
                pricingType === normalizedDescriptor)
            );
          },
        );
        const adminBasePrice = Number(packageBasePriceRow?.base_price);
        const hasAdminBasePrice =
          Number.isFinite(adminBasePrice) && adminBasePrice > 0;
        const tierPrice = row?.uses_admin_base_price
          ? hasAdminBasePrice
            ? adminBasePrice
            : 0
          : Number(row?.price || 0);
        const catalogPrice = Number(catalogPackage?.price);
        if (!Number.isFinite(tierPrice) || tierPrice <= 0) return null;
        const basePrice = hasAdminBasePrice
          ? adminBasePrice
          : Number.isFinite(catalogPrice) && catalogPrice > 0
            ? catalogPrice / 100
            : tierPrice;

        return {
          id: String(row.id),
          superAgentOfferId: row.id,
          package_id: catalogPackage?.id ?? null,
          provider,
          network: normalizeNetworkKey(row?.network),
          data_value: descriptor,
          type: String(catalogPackage?.type || descriptor).toUpperCase(),
          title:
            row?.title ||
            `${normalizeKey(row?.network)} — ${descriptor}`.trim(),
          name:
            row?.title ||
            `${normalizeKey(row?.network)} — ${descriptor}`.trim(),
          price: tierPrice,
          base_price: basePrice,
          tier_extra: Math.max(0, tierPrice - basePrice),
          tier_name: offerTier(row) || null,
          size: size !== null && size !== undefined ? size : null,
          dataSize:
            size !== null && size !== undefined
              ? `${size} GB`
              : formatBundleSizeFromDescriptor(descriptor),
        };
      })
      .filter(Boolean);

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

  // Load all networks once so the Home prefetch can serve any DataScreen route.
  const request = loadSubAgentPackagesUncached({
    ...options,
    network: null,
  })
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
