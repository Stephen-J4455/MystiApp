import { supabase } from "./supabase";
import { fetchCatalogPackages } from "../services/superAgentService";

export const orderPageSize = 20;
export const pesewasToCedis = (price) => (price / 100).toFixed(2);
export const storeContacts = [
  { key: "whatsapp", label: "WhatsApp number", placeholder: "+233 24 123 4567", keyboardType: "phone-pad" },
  { key: "facebook_url", label: "Facebook", placeholder: "https://facebook.com/your-store" },
  { key: "instagram_url", label: "Instagram", placeholder: "https://instagram.com/your-store" },
  { key: "tiktok_url", label: "TikTok", placeholder: "https://tiktok.com/@your-store" },
  { key: "telegram_url", label: "Telegram", placeholder: "https://t.me/your-store" },
  { key: "website_url", label: "Website", placeholder: "https://example.com" },
  { key: "contact_email", label: "Email", placeholder: "shop@example.com", keyboardType: "email-address" },
];
const contactKeys = storeContacts.map(({ key }) => key);
const storeFields = ["name", "slug", "published", "selected_tier_id", "selected_super_tier_id", "deleted_at",
  "template", "theme", "accent_color", "store_icon", "welcome_text", "image_url", ...contactKeys].join(",");

export const storeTemplates = [
  { key: "grid", label: "Grid", summary: "Classic catalog" },
  { key: "list", label: "List", summary: "Full-width rows" },
  { key: "showcase", label: "Showcase", summary: "Centered hero" },
  { key: "split", label: "Split", summary: "Photo beside title" },
  { key: "cover", label: "Cover", summary: "Full-width cover" },
  { key: "networks", label: "Networks", summary: "Grouped by carrier" },
  { key: "sidebar", label: "Sidebar", summary: "Side shop profile" },
  { key: "tiles", label: "Tiles", summary: "Image-led tiles" },
  { key: "editorial", label: "Editorial", summary: "Masthead and lead card" },
  { key: "compact", label: "Compact", summary: "Dense catalog" },
];
export const storeThemes = [{ key: "light", label: "Light" }, { key: "dark", label: "Dark" }];
export const storeIcons = [
  { key: "store", label: "Store", symbol: "🏪" },
  { key: "signal", label: "Signal", symbol: "📶" },
  { key: "bolt", label: "Bolt", symbol: "⚡" },
  { key: "globe", label: "Globe", symbol: "🌐" },
  { key: "star", label: "Star", symbol: "⭐" },
  { key: "gem", label: "Gem", symbol: "💎" },
];
export const storeColors = [
  { label: "Violet", value: "#4933BC" }, { label: "Teal", value: "#007367" },
  { label: "Blue", value: "#2159B6" }, { label: "Rose", value: "#A62F62" },
  { label: "Orange", value: "#A74611" }, { label: "Graphite", value: "#333D52" },
];
export const defaultBranding = {
  template: "grid", theme: "light", accent_color: storeColors[0].value, store_icon: "store", welcome_text: "",
  image_url: "", ...Object.fromEntries(contactKeys.map((key) => [key, ""])),
};
export const isStoreColor = (color) => /^#[0-9a-f]{6}$/i.test(color);

export function safeStoreUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function contactValues(draft) {
  const values = {};
  for (const { key, label } of storeContacts) {
    const raw = draft[key].trim();
    if (key === "whatsapp") {
      const digits = raw.replace(/[+\s()-]/g, "").replace(/^0([235]\d{8})$/, "233$1");
      if (raw && !/^[1-9]\d{7,14}$/.test(digits)) throw new Error("Enter a valid WhatsApp phone number.");
      values[key] = digits;
    } else if (key === "contact_email") {
      if (raw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw new Error("Enter a valid contact email.");
      values[key] = raw;
    } else {
      values[key] = safeStoreUrl(raw);
      if (raw && (!values[key] || values[key].length > 500)) throw new Error(`Enter a valid HTTPS link for ${label}.`);
    }
  }
  return values;
}

export function selectedStoreTier(store) {
  if (store?.selected_super_tier_id != null) return `super:${store.selected_super_tier_id}`;
  return store?.selected_tier_id ?? "";
}

export function storeLink(slug) {
  return `https://mystistorefront.vercel.app/store/${encodeURIComponent(slug)}`;
}

function checked({ data, error }) {
  if (error) throw error;
  return data;
}

export async function loadStorefront(ownerId) {
  const [storeResult, tiersResult, itemsResult, choicesResult] = await Promise.all([
    supabase.from("mysti_stores").select(storeFields).eq("owner_id", ownerId).maybeSingle(),
    supabase.from("mysti_store_tiers").select("id,name,active").eq("owner_id", ownerId).order("name"),
    supabase.from("mysti_store_tier_items").select("id,tier_id,catalog_key,network,bundle,price_pesewas,active")
      .eq("owner_id", ownerId).order("network").order("bundle").order("id"),
    supabase.from("mysti_store_tier_choices").select("tier_key,name").eq("owner_id", ownerId).order("name"),
  ]);
  return {
    store: checked(storeResult),
    tiers: checked(tiersResult), items: checked(itemsResult),
    choices: checked(choicesResult),
  };
}

export async function loadStoreOrders(ownerId, page) {
  const first = page * orderPageSize;
  return checked(await supabase.from("mysti_store_orders")
    .select("id,network,bundle,price_pesewas,phone,status,created_at")
    .eq("owner_id", ownerId).order("created_at", { ascending: false }).order("id")
    .range(first, first + orderPageSize));
}

export async function saveStorefront(ownerId, draft, exists) {
  const name = draft.name.trim();
  const slug = draft.slug.trim().toLowerCase();
  if (name.length < 2 || name.length > 80 || slug.length < 3 || slug.length > 48 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Enter a store name and a 3–48 character link name using letters, numbers and hyphens.");
  }

  const accent_color = draft.accent_color.trim().toUpperCase();
  if (!isStoreColor(accent_color)) throw new Error("Enter a six-digit hex color, such as #4933BC.");
  const image_url = safeStoreUrl(draft.image_url.trim());
  if (draft.image_url.trim() && (!image_url || image_url.length > 500)) throw new Error("Enter a valid HTTPS image URL.");
  const values = {
    name, slug, published: draft.published, accent_color,
    template: draft.template, theme: draft.theme, store_icon: draft.store_icon,
    welcome_text: draft.welcome_text.trim(), image_url, ...contactValues(draft),
  };
  const stores = supabase.from("mysti_stores");
  const query = exists
    ? stores.update(values).eq("owner_id", ownerId).is("deleted_at", null)
    : stores.insert({ ...values, owner_id: ownerId });
  return checked(await query.select(storeFields).single());
}

export async function saveStoreTierSelection(ownerId, key) {
  if (!key) throw new Error("Select a pricing tier.");
  const existing = /^super:(\d+)$/.exec(key);
  return checked(await supabase.from("mysti_stores").update({
    selected_tier_id: existing ? null : key,
    selected_super_tier_id: existing?.[1] ?? null,
  }).eq("owner_id", ownerId).is("deleted_at", null).select(storeFields).single());
}

export async function deleteStorefront(ownerId) {
  const deleted = checked(await supabase.from("mysti_stores").delete()
    .eq("owner_id", ownerId).select("owner_id").maybeSingle());
  if (!deleted) throw new Error("The storefront changed. Reopen this screen and try again.");
}

export async function saveStoreTier(ownerId, draft) {
  const name = draft.name.trim();
  if (name.length < 2 || name.length > 60) throw new Error("Enter a tier name of 2–60 characters.");
  const table = supabase.from("mysti_store_tiers");
  const values = { name, active: draft.active };
  const query = draft.id
    ? table.update(values).eq("id", draft.id).eq("owner_id", ownerId)
    : table.insert({ ...values, owner_id: ownerId });
  return checked(await query.select("id,name,active").single());
}

export async function saveTierItem(ownerId, tierId, draft) {
  const price = draft.price.trim();
  const [whole, fraction = ""] = price.split(".");
  const price_pesewas = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(price) || price_pesewas < 1 || price_pesewas > 10000000) {
    throw new Error("Enter a price between GH₵0.01 and GH₵100,000.");
  }
  if (!draft.id && !draft.package) throw new Error("Select a bundle from the Mysti catalog.");
  const table = supabase.from("mysti_store_tier_items");
  const values = { price_pesewas, active: draft.active };
  const query = draft.id
    ? table.update(values).eq("id", draft.id).eq("tier_id", tierId).eq("owner_id", ownerId)
    : table.insert({ ...values, ...draft.package, tier_id: tierId, owner_id: ownerId });
  return checked(await query.select("id,tier_id,catalog_key,network,bundle,price_pesewas,active").single());
}

const catalogNetworks = {
  MTN: "MTN", TELECEL: "Telecel", VOD: "Telecel", VODAFONE: "Telecel",
  AT: "AT", AIRTELTIGO: "AT",
};

export async function loadTierCatalog() {
  const packages = await fetchCatalogPackages();
  const catalog = new Map();
  for (const pkg of packages) {
    const networkKey = String(pkg.network ?? "").toUpperCase().replace(/[^A-Z]/g, "");
    const network = catalogNetworks[networkKey];
    const catalog_key = `${pkg.provider}:${pkg.id}`;
    const type = String(pkg.type ?? "").trim();
    const size = Number(pkg.size);
    const sizeLabel = size > 0 ? `${size} GB` : "";
    const bundle = sizeLabel && !type.replace(/\s/g, "").toUpperCase().includes(sizeLabel.replace(" ", ""))
      ? [sizeLabel, type].filter(Boolean).join(" · ")
      : type || sizeLabel;
    if (network && pkg.id && bundle && bundle.length <= 60 && catalog_key.length <= 200) {
      catalog.set(catalog_key, { catalog_key, network, bundle });
    }
  }
  return [...catalog.values()];
}

export async function resolveStoreOrder(ownerId, id, status) {
  return checked(await supabase.from("mysti_store_orders").update({ status })
    .eq("id", id).eq("owner_id", ownerId).eq("status", "pending").select("id,status").maybeSingle());
}
