const slugPattern = /^(?=.{3,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sellers = ["agent", "subagent", "sub_agent", "superagent", "super_agent"];

async function database<T>(path: string): Promise<T> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing database configuration");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
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
    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("Storefront request failed:", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "Storefront temporarily unavailable" }, 503);
  }
});
