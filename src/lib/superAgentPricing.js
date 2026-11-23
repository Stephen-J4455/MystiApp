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

const currentPackageKey = (row, id) => {
  const provider = String(row.provider ?? "").trim().toLowerCase();
  const network = normalizeNetwork(row.network);
  const packageId = String(id ?? "").trim();
  return provider && network && packageId ? JSON.stringify([provider, network, packageId]) : null;
};

export const matchCurrentPackagePrices = (catalog, pricing) => {
  const available = new Map();
  for (const pkg of catalog) {
    const key = currentPackageKey(pkg, pkg.id);
    if (key && !available.has(key)) available.set(key, pkg);
  }

  const rows = pricing
    .filter((row) => row.is_active !== false)
    .sort((a, b) =>
      (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) ||
      Number(b.id || 0) - Number(a.id || 0)
    );
  const matches = [];
  for (const row of rows) {
    const key = currentPackageKey(row, row.package_id);
    const pkg = available.get(key);
    if (!pkg) continue;
    available.delete(key);
    matches.push({ key, pkg, row });
  }
  return matches;
};

export const matchAgentPackagePrices = (catalog, pricing, enabledProviders) => {
  const providers = new Set(enabledProviders ?? catalog.map(providerOf));
  return matchCurrentPackagePrices(catalog, pricing).filter(
    ({ pkg, row }) => providers.has(providerOf(pkg)) && usableBasePrice(row.base_price) !== null,
  );
};

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

// Existing published offers can omit the provider package ID. Match those
// against eligible current cards only, and skip ambiguous descriptions.
const findOfferCard = (entries, row) => {
  const candidates = entries.get(networkKey(row)) || [];
  const id = String(row.package_id ?? "").trim();
  if (id) return candidates.find(({ pkg }) => String(pkg.id) === id);
  const value = normalizeName(row.data_value);
  const explicit = value && candidates.find(({ pkg }) => normalizeName(pkg.id) === value);
  if (explicit) return explicit;
  const exact = candidates.filter(({ pkg }) => matchesDescriptor(row.data_value, pkg));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const byType = candidates.filter(({ pkg }) => value && normalizeName(pkg.type) === value);
  return byType.length === 1 ? byType[0] : undefined;
};

export const buildPackageCards = (catalog, pricing, offers, enabledProviders) => {
  const entries = new Map();
  const cards = [];
  for (const { key, pkg, row } of matchAgentPackagePrices(catalog, pricing, enabledProviders)) {
    const card = {
      key,
      pkg,
      descriptor: getPackageDescriptor(pkg),
      base: Number(row.base_price),
      offers: [],
    };
    const groupKey = networkKey(pkg);
    const candidates = entries.get(groupKey) || [];
    candidates.push(card);
    entries.set(groupKey, candidates);
    cards.push(card);
  }

  for (const offer of offers) {
    findOfferCard(entries, offer)?.offers.push(offer);
  }

  return cards.sort((a, b) =>
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
