const slugPattern = /^(?=.{3,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const networks = ["MTN", "Telecel", "AT"];
const sellers = ["agent", "subagent", "sub_agent", "superagent", "super_agent"];

async function database<T>(path: string, input?: Record<string, unknown>): Promise<T> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing database configuration");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: input ? "POST" : "GET",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: input ? JSON.stringify(input) : undefined,
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  return response.json();
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function readCatalog(slug: string) {
  const [store] = await database<{
    owner_id: string; name: string; template?: string; theme?: string;
    accent_color?: string; store_icon?: string; welcome_text?: string;
    image_url?: string; whatsapp?: string; facebook_url?: string; instagram_url?: string;
    tiktok_url?: string; telegram_url?: string; website_url?: string; contact_email?: string;
  }[]>(
    `mysti_stores?select=*&slug=eq.${slug}&published=is.true`,
  );
  if (!store) return json(null, 404);
  const [profile] = await database<{ role: string }[]>(
    `user_profiles?select=role&id=eq.${store.owner_id}`,
  );
  if (!sellers.includes(profile?.role?.trim().toLowerCase() ?? "")) return json(null, 404);
  const bundles = await database(
    `mysti_store_published_bundles?select=id,network,bundle,price_pesewas&owner_id=eq.${store.owner_id}&order=network,price_pesewas,id`,
  );
  return json({
    name: store.name,
    template: store.template ?? "grid",
    theme: store.theme ?? "light",
    accent_color: store.accent_color ?? "#4933BC",
    store_icon: store.store_icon ?? "store",
    welcome_text: store.welcome_text ?? "",
    image_url: store.image_url ?? "",
    contacts: {
      whatsapp: store.whatsapp ?? "",
      facebook: store.facebook_url ?? "",
      instagram: store.instagram_url ?? "",
      tiktok: store.tiktok_url ?? "",
      telegram: store.telegram_url ?? "",
      website: store.website_url ?? "",
      email: store.contact_email ?? "",
    },
    bundles,
  });
}

async function placeOrder(slug: string, input: Record<string, unknown>) {
  const { offerId, requestId, price, phone, network, bundle } = input;
  if (typeof offerId !== "string" || !uuidPattern.test(offerId) ||
      typeof requestId !== "string" || !uuidPattern.test(requestId) ||
      typeof price !== "number" || !Number.isInteger(price) || price < 1 || price > 10000000 ||
      typeof phone !== "string" || !/^0[235]\d{8}$/.test(phone) ||
      typeof network !== "string" || !networks.includes(network) ||
      typeof bundle !== "string" || !bundle.trim() || bundle.length > 60) {
    return json({ result: "invalid" }, 400);
  }
  const result = await database<string>("rpc/mysti_store_checkout", {
    p_slug: slug, p_offer_id: offerId, p_price_pesewas: price, p_phone: phone,
    p_request_id: requestId, p_network: network, p_bundle: bundle,
  });
  return json({ result });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let input: Record<string, unknown>;
  try {
    const body = await request.text();
    if (body.length > 4096) return json({ error: "Request body too large" }, 413);
    input = JSON.parse(body);
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (!input || typeof input.slug !== "string" || !slugPattern.test(input.slug)) {
    return json({ error: "Invalid storefront" }, 400);
  }
  try {
    if (input.action === "catalog") return await readCatalog(input.slug);
    if (input.action === "checkout") return await placeOrder(input.slug, input);
    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("Storefront request failed:", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "Storefront temporarily unavailable" }, 503);
  }
});
