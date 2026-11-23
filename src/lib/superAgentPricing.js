export const getPackageDescriptor = (pkg) => {
  if (!pkg) return "";
  const type = String(pkg.type || "").trim();
  const size =
    pkg.size !== undefined &&
    pkg.size !== null &&
    String(pkg.size).trim() !== ""
      ? `${pkg.size}GB`
      : "";
  if (size && !type.toUpperCase().includes(size.toUpperCase())) {
    return `${type} - ${size}`;
  }
  return type || size || "DEFAULT";
};

export const formatGhc = (value) => `Ghc ${Number(value || 0).toFixed(2)}`;

export const formatPriceInput = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "";
};

export const getOffersProviderLabel = (provider) => {
  const key = String(provider || "jehuca").trim().toLowerCase();
  if (key === "jehuca") return "MystiwanEbiz";
  if (key === "bisdel") return "MystiwanEbiz-VIP";
  return "Data provider";
};

// Admin base prices are the default an offer price starts from. A base price of
// 0 counts as "not set" because offer prices must be greater than 0.
export const usableBasePrice = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

export const getBundleFamily = (item) => {
  const type = [
    item?.type,
    item?.data_value,
    item?.title,
    item?.name,
    item?.category,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
  if (type.includes("ISHARE")) return "ishare";
  if (type.includes("BIGTIME")) return "big_time";
  return "everyday";
};

export const normalizeNetwork = (network) => {
  const value = String(network || "").trim().toUpperCase();
  return value === "VODAFONE" || value === "VOD" ? "TELECEL" : value;
};

export const providerOf = (row) => String(row.provider || "jehuca").trim().toLowerCase();
export const normalizeName = (value) => String(value ?? "").trim().toUpperCase();
export const tierOf = (offer) => String(offer.tier_name || offer.default_tier_name || "").trim();

const networkKey = (row) => JSON.stringify([providerOf(row), normalizeNetwork(row.network)]);
const cardKey = (row, descriptor) => JSON.stringify([
  networkKey(row),
  normalizeName(descriptor),
]);

const matchesDescriptor = (value, pkg) => {
  const descriptor = normalizeName(value);
  const type = normalizeName(pkg.type);
  const size = pkg.size == null ? "" : `${pkg.size}GB`;
  return Boolean(descriptor) && (
    descriptor === normalizeName(getPackageDescriptor(pkg)) ||
    (size && [
      `${type} - ${size}`, `${type} (${size})`, `${type} ${size}`, `${type}-${size}`,
    ].includes(descriptor))
  );
};

// Resolve explicit package IDs before historical descriptors. A bare plan
// type can refer to several sizes, so only accept it when it identifies one.
const findPackageEntry = (entries, row, descriptor) => {
  const candidates = entries.get(networkKey(row)) || [];
  const id = normalizeName(row.package_id);
  const value = normalizeName(descriptor);
  const explicitId = id || value;
  const explicit = explicitId && candidates.find(({ pkg }) => normalizeName(pkg.id) === explicitId);
  if (explicit) return explicit;
  const exact = candidates.find(({ pkg }) => matchesDescriptor(descriptor, pkg));
  if (exact) return exact;
  const byType = candidates.filter(({ pkg }) => value && normalizeName(pkg.type) === value);
  return byType.length === 1 ? byType[0] : undefined;
};

export const buildPackageCards = (catalog, pricing, offers, enabledProviders) => {
  const entries = new Map();
  const cards = new Map();
  const providers = new Set(enabledProviders ?? catalog.map(providerOf));
  for (const pkg of catalog) {
    if (!providers.has(providerOf(pkg))) continue;
    const key = networkKey(pkg);
    const candidates = entries.get(key) || [];
    const descriptor = getPackageDescriptor(pkg);
    candidates.push({ pkg, descriptor, key: cardKey(pkg, descriptor), base: null });
    entries.set(key, candidates);
  }

  for (const row of pricing) {
    if (row.is_active === false) continue;
    const entry = findPackageEntry(entries, row, row.type);
    const base = usableBasePrice(row.base_price);
    if (entry && base !== null) {
      entry.base = base;
      cards.set(entry.key, { ...entry, offers: [] });
    }
  }

  for (const offer of offers) {
    if (!providers.has(providerOf(offer))) continue;
    const entry = findPackageEntry(entries, offer, offer.data_value);
    const key = entry?.key ?? cardKey(offer, offer.data_value);
    let card = cards.get(key);
    if (!card) {
      card = { key, pkg: entry?.pkg ?? offer, descriptor: entry?.descriptor ?? offer.data_value, base: null, offers: [] };
      cards.set(key, card);
    }
    card.offers.push(offer);
  }

  return [...cards.values()].sort((a, b) =>
    normalizeNetwork(a.pkg.network).localeCompare(normalizeNetwork(b.pkg.network)) ||
    (a.base ?? Infinity) - (b.base ?? Infinity) ||
    String(a.descriptor).localeCompare(String(b.descriptor))
  );
};

export const buildTierOverview = (tiers, cards, agents) => {
  const packages = cards.filter((card) => card.base !== null).map((card) => {
    const prices = new Map();
    for (const offer of card.offers) {
      const tier = normalizeName(tierOf(offer));
      if (offer.is_active === true && !prices.has(tier)) prices.set(tier, offer);
    }
    return { card, prices };
  });

  const assigned = new Map();
  for (const agent of agents) {
    const metadata = { ...agent.app_metadata, ...agent.user_metadata };
    const tier = normalizeName(metadata.tier_name);
    const group = assigned.get(tier) || [];
    group.push({
      id: agent.id,
      name: metadata.full_name || metadata.business_name || agent.email || "Sub-agent",
    });
    assigned.set(tier, group);
  }

  return [{ id: null, name: "General" }, ...tiers].map((tier) => {
    const key = tier.id === null ? "" : normalizeName(tier.name);
    return {
      ...tier,
      agents: assigned.get(key) || [],
      packages: packages.flatMap(({ card, prices }) => {
        const direct = prices.get(key);
        const offer = direct ?? prices.get("");
        if (!offer) return [];
        return [{
          key: card.key,
          name: card.descriptor,
          network: normalizeNetwork(card.pkg.network),
          provider: getOffersProviderLabel(card.pkg.provider),
          price: usableBasePrice(offer.uses_admin_base_price ? card.base : offer.price),
          inherited: !direct && Boolean(key),
        }];
      }),
    };
  });
};
