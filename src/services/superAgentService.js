import { supabase } from "../lib/supabase.js";
import { invokeEdgeFunction } from "../lib/edgeFunctions.js";
import { getEdgeFunctionName } from "../lib/env.js";

// Client-side fallbacks use the authenticated anon client. Privileged work is
// performed by Supabase Edge Functions, never with a browser-exposed service key.
const adminClient = supabase;

const normalizeKey = (val) =>
  String(val || "")
    .trim()
    .toUpperCase();

export const formatBundleSizeFromDescriptor = (descriptor) => {
  const match = String(descriptor || "").match(/(\d+(?:\.\d+)?)\s*GB/i);
  return match ? `${match[1]} GB` : "";
};

const sizeFromDataValue = (dataValue) => {
  const match = String(dataValue || "").match(/(\d+(?:\.\d+)?)\s*GB/i);
  return match ? Number(match[1]) : null;
};

export const fetchCatalogPackages = async () => {
  // 1. Try edge function
  try {
    const { data: edgeData, error: edgeError } =
      await supabase.functions.invoke(getEdgeFunctionName("get-packages"), {});
    const catalog = edgeData?.payload || edgeData || [];
    if (Array.isArray(catalog) && catalog.length > 0) {
      return catalog;
    }
  } catch (err) {
    // Edge function failed, proceed to direct fetch
  }

  // 2. If the Edge Function is unavailable, return an empty catalog. The
  // provider API key must not be shipped in a Vercel/browser bundle.
  console.warn("Provider catalog Edge Function unavailable");
  return [];
};

const findCatalogPackageForOffer = (catalog, offer) => {
  if (!Array.isArray(catalog) || catalog.length === 0) return null;
  const net = normalizeKey(offer?.network);
  const dataVal = normalizeKey(offer?.data_value);
  if (!dataVal) return null;

  return (
    catalog.find((pkg) => {
      if (normalizeKey(pkg?.network) !== net) return false;
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
 */
export const loadSubAgentPackages = async ({ user, network = null }) => {
  if (!user) {
    return { offers: [], agent_tier: null, error: "User is required" };
  }

  const assignedSuperAgentId = String(
    user.user_metadata?.super_agent_id ||
      user.user_metadata?.superAgentId ||
      user.app_metadata?.super_agent_id ||
      user.app_metadata?.superAgentId ||
      "",
  ).trim();

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
        { body: { action: "getAgentPackages", network } },
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
      `${normalizeKey(row?.network)}::${normalizeKey(row?.data_value)}`;
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
    const networkFilter = network ? normalizeKey(network) : null;
    const { data: activePricingRows, error: activePricingError } =
      await adminClient
        .from("package_pricing")
        .select("package_id, network, type")
        .eq("is_active", true);

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
        return `${normalizeKey(row?.network)}::${descriptorWithSize}`;
      }),
    );
    const activePackageIds = new Set(
      (activePricingRows || [])
        .map((row) => String(row?.package_id || ""))
        .filter(Boolean),
    );

    const mappedPackages = selectedOffers
      .filter((row) => {
        const rowPackageId = String(row?.package_id || "");
        const catalogPackage = findCatalogPackageForOffer(catalog, row);
        const catalogPackageId = String(catalogPackage?.id || "");
        const rowKey = `${normalizeKey(row?.network)}::${normalizeKey(row?.data_value)}`;
        return (
          (rowPackageId && activePackageIds.has(rowPackageId)) ||
          (catalogPackageId && activePackageIds.has(catalogPackageId)) ||
          activePricingKeys.has(rowKey)
        );
      })
      .filter(
        (row) => !networkFilter || normalizeKey(row?.network) === networkFilter,
      )
      .map((row) => {
        const catalogPackage = findCatalogPackageForOffer(catalog, row);
        const descriptor = String(row?.data_value || "");
        const size = catalogPackage?.size ?? sizeFromDataValue(descriptor);

        const tierPrice = Number(row?.price || 0);
        const basePrice = catalogPackage?.price
          ? catalogPackage.price / 100
          : tierPrice;

        return {
          id: String(row.id),
          superAgentOfferId: row.id,
          package_id: catalogPackage?.id ?? null,
          network: normalizeKey(row?.network),
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
      });

    return {
      offers: mappedPackages,
      agent_tier: agentTier || null,
      super_agent_id: assignedSuperAgentId,
    };
  } catch (err) {
    console.error("Failed to load sub-agent packages directly:", err);
    return { offers: [], agent_tier: agentTier || null, error: err.message };
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
  const { network, data_value, tier_name, price } = offer;

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
            price: Number(price),
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
    const net = normalizeKey(network);
    const dataVal = String(data_value || "").trim();
    const tierName = String(tier_name || "").trim() || null;
    const priceNum = Number(price);

    // Check if an existing row matches (super_agent_id, network, data_value, tier_name)
    let query = adminClient
      .from("super_agent_offers")
      .select("id")
      .eq("super_agent_id", superAgentId)
      .eq("network", net)
      .eq("data_value", dataVal);

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
        tier_name: tierName,
        price: priceNum,
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
      network: normalizeKey(offer.network),
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
