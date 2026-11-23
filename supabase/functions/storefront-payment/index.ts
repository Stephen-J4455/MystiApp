type Data = Record<string, unknown>;
type Quote = {
  id: string; network: string; bundle: string; price_pesewas: number;
  catalog_key: string | null; provider: string | null; data_value: string | null;
};
type Provider = "jehuca" | "bisdel";
type Product = { id: string; network: string; type: string; size: number; cost: number };

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const slug = /^(?=.{3,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const api = "https://backend.jehucale-business.com/api";
const readSecret = (name: string) => (Deno.env.get(name) ?? "").replace(/\0/g, "").trim();
const catalogCache = new Map<Provider, { until: number; products: Promise<Product[]> }>();

function json(result: string, status = 200, url?: string) {
  return Response.json({ result, ...(url ? { url } : {}) }, { status, headers: { "Cache-Control": "no-store" } });
}

async function database<T>(path: string, options: RequestInit = {}): Promise<T> {
  const key = readSecret("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${readSecret("SUPABASE_URL")}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...options.headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  return response.status === 204 ? undefined as T : response.json();
}

function networkKey(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z]/g, "");
  if (normalized.startsWith("MTN")) return "MTN";
  if (["VODAFONE", "VOD", "TELECEL"].includes(normalized)) return "Telecel";
  if (["AT", "AIRTELTIGO", "AIRTEL"].includes(normalized)) return "AT";
  return normalized;
}

function normalize(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9.]/g, "");
}

async function fetchProducts(provider: Provider): Promise<Product[]> {
  const bisdel = provider === "bisdel";
  const key = bisdel ? readSecret("TELCOGH_API_KEY") || readSecret("BISDEL_DB") : readSecret("JEHUCA_API_KEY");
  if (!key) throw new Error("Provider configuration missing");
  const response = await fetch(bisdel ? "https://telcogh.com/api/v1/products" : `${api}/packages`, {
    headers: bisdel ? { Authorization: `Bearer ${key}` } : { "X-API-Key": key },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  const products = bisdel ? data?.data?.products ?? data?.data ?? data?.products : data?.payload;
  if (!response.ok || !Array.isArray(products)) throw new Error("Provider catalog could not be read");
  return products.map((row: Data) => {
    const volume = String(row.package_size ?? row.data_volume ?? row.size ?? "");
    return {
      id: String(row.product_id ?? row.id ?? ""),
      network: String(row.network ?? "").trim().toUpperCase(),
      type: String(bisdel ? row.name || volume : row.type ?? "").trim(),
      size: bisdel ? Number(volume.match(/(\d+(?:\.\d+)?)\s*GB/i)?.[1] ?? 0) : Number(row.size),
      cost: bisdel ? Math.round(Number(row.api_price ?? row.price) * 100) : Number(row.price),
    };
  }).filter((row: Product) => row.id && row.type && Number.isFinite(row.size) && row.size > 0 &&
    Number.isFinite(row.cost) && row.cost > 0);
}

function providerProducts(provider: Provider) {
  const cached = catalogCache.get(provider);
  if (cached && cached.until > Date.now()) return cached.products;
  const products = fetchProducts(provider).catch((error) => {
    catalogCache.delete(provider);
    throw error;
  });
  catalogCache.set(provider, { until: Date.now() + 30_000, products });
  return products;
}

async function resolvePackage(quote: Quote) {
  const separator = quote.catalog_key?.indexOf(":") ?? -1;
  const provider = separator > 0 ? quote.catalog_key!.slice(0, separator) : quote.provider;
  if (provider !== "jehuca" && provider !== "bisdel") return null;
  const [settings] = await database<{ jehuca_enabled: boolean; bisdel_enabled: boolean }[]>(
    "data_provider_settings?select=jehuca_enabled,bisdel_enabled&id=eq.true",
  );
  if (!(provider === "jehuca" ? settings?.jehuca_enabled : settings?.bisdel_enabled)) return null;

  const products = (await providerProducts(provider)).filter((row) => networkKey(row.network) === quote.network);
  const key = quote.catalog_key?.slice(separator + 1);
  const descriptor = normalize(quote.data_value ?? "");
  const matches = products.filter((product) => {
    if (separator > 0) return product.id === key;
    const size = `${product.size}GB`;
    return descriptor === normalize(product.id) || descriptor === normalize(product.type) ||
      descriptor === normalize(`${product.type}-${size}`) ||
      (provider === "bisdel" && descriptor === size);
  });
  if (matches.length !== 1) return null;
  return { provider, ...matches[0] };
}

function validPaystackUrl(value: string) {
  try {
    const url = new URL(value);
    return url.origin === "https://checkout.paystack.com" && !url.username && !url.password;
  } catch {
    return false;
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json("invalid", 405);
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json("invalid", 413);
    let input;
    try { input = JSON.parse(raw); } catch { return json("invalid", 400); }
    const { slug: storeSlug, requestId, offerId, price, phone, network, bundle } = input ?? {};
    const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
    if (typeof storeSlug !== "string" || !slug.test(storeSlug) || typeof requestId !== "string" || !uuid.test(requestId) ||
        typeof offerId !== "string" || !uuid.test(offerId) || !Number.isInteger(price) || price < 1 || price > 10000000 ||
        typeof phone !== "string" || !/^0[235]\d{8}$/.test(phone) ||
        !["MTN", "Telecel", "AT"].includes(network) || typeof bundle !== "string" || !bundle.trim() || bundle.length > 60 ||
        email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json("invalid", 400);

    const isTest = new URL(request.url).pathname.split("/").filter(Boolean).at(-1)?.endsWith("-test") === true;
    const secret = readSecret(isTest ? "TEST_PAYSTACK_SECRET_KEY" : "PAYSTACK_SECRET_KEY");
    if (!secret.startsWith(isTest ? "sk_test_" : "sk_live_")) return json("payment_unavailable", 503);

    const [quote] = await database<Quote[]>(`mysti_store_payment_catalog?slug=eq.${storeSlug}&id=eq.${offerId}`);
    if (!quote) return json("unavailable", 404);
    if (quote.price_pesewas !== price) return json("price_changed", 409);
    if (quote.network !== network || quote.bundle !== bundle) return json("offer_changed", 409);
    const providerPackage = await resolvePackage(quote);
    if (!providerPackage) return json("provider_unavailable", 409);
    if (quote.price_pesewas < providerPackage.cost) return json("below_provider_cost", 409);

    const orderId = requestId.toLowerCase();
    const reference = `mysti-stf-${isTest ? "test" : "live"}-${orderId}`;
    const result = await database<string>("rpc/mysti_store_reserve_payment", {
      method: "POST",
      body: JSON.stringify({
        p_slug: storeSlug, p_offer_id: offerId, p_price: price, p_phone: phone, p_request_id: orderId,
        p_network: network, p_bundle: bundle, p_email: email, p_reference: reference,
        p_is_test: isTest, p_package: providerPackage,
      }),
    });
    if (result !== "accepted") return json(result, 409);

    const [payment] = await database<{ status: string; authorization_url: string | null }[]>(
      `mysti_store_payments?select=status,authorization_url&reference=eq.${reference}`,
    );
    if (payment?.status !== "awaiting_payment") return json("unavailable", 409);
    if (payment.authorization_url && validPaystackUrl(payment.authorization_url)) {
      return json("redirect", 200, payment.authorization_url);
    }

    const callback = isTest
      ? readSecret("STOREFRONT_TEST_CALLBACK_URL") || "https://mystistorefront.vercel.app/payment/storefront"
      : "https://mystistorefront.vercel.app/payment/storefront";
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        email, amount: quote.price_pesewas, currency: "GHS", reference, callback_url: callback,
      }),
    });
    const paystack = await response.json();
    const url = paystack?.data?.authorization_url;
    if (!response.ok || paystack?.status !== true || paystack?.data?.reference !== reference ||
        typeof url !== "string" || !validPaystackUrl(url)) return json("payment_unavailable", 502);

    await database(`mysti_store_payments?reference=eq.${reference}&status=eq.awaiting_payment`, {
      method: "PATCH", body: JSON.stringify({ authorization_url: url }),
    });
    return json("redirect", 200, url);
  } catch (error) {
    console.error("Storefront payment initialization failed:", error instanceof Error ? error.message : "Unknown error");
    return json("payment_unavailable", 503);
  }
});
