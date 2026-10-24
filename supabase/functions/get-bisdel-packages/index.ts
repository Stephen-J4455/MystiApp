import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

const readSecret = (name: string) =>
  (Deno.env.get(name) ?? "").replace(/\0/g, "").trim();

const normalizeProducts = (products: unknown[]) =>
  products.map((item) => {
    const product = item && typeof item === "object"
      ? item as Record<string, unknown>
      : {};
    const volume = String(product.data_volume || "");
    const size = Number(volume.match(/(\d+(?:\.\d+)?)\s*GB/i)?.[1] || 0);
    const apiPrice = Number(product.api_price);
    const rawNetwork = String(product.network || "").trim().toUpperCase();
    const network = rawNetwork.startsWith("MTN") ? "MTN" : rawNetwork;

    return {
      id: String(product.product_id ?? ""),
      network,
      type: String(product.name || volume || "").trim(),
      size,
      price: Number.isFinite(apiPrice) ? Math.round(apiPrice * 100) : 0,
      provider: "bisdel",
      data_volume: volume,
      validity_days: product.validity_days ?? null,
      category: product.category ?? null,
    };
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRoleKey) {
      return json(
        { success: false, error: "Supabase service configuration is missing" },
        500,
      );
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const isAdminCatalogRequest = body?.admin_catalog === true;
    const { data: settings, error: settingsError } = await admin
      .from("data_provider_settings")
      .select("provider, jehuca_enabled, bisdel_enabled")
      .eq("id", true)
      .single();
    if (settingsError) throw settingsError;

    const activeProvider = String(settings.provider || "").toLowerCase();
    if (activeProvider !== "jehuca" && activeProvider !== "bisdel") {
      throw new Error("Configured data provider is invalid");
    }

    if (isAdminCatalogRequest) {
      const authorization = req.headers.get("Authorization");
      if (!authorization) {
        return json({ success: false, error: "Unauthorized" }, 401);
      }

      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
      if (!anonKey) {
        return json(
          { success: false, error: "Supabase anon key is not configured" },
          500,
        );
      }
      const authClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authorization } },
      });
      const {
        data: { user },
        error: authError,
      } = await authClient.auth.getUser();
      if (authError || !user) {
        return json({ success: false, error: "Unauthorized" }, 401);
      }
      const { data: profile, error: profileError } = await admin
        .from("user_profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      if (profileError) throw profileError;
      if (profile?.role !== "admin") {
        return json(
          { success: false, error: "Administrator access required" },
          403,
        );
      }
    } else if (settings.bisdel_enabled !== true) {
      return json({
        success: true,
        data_provider: activeProvider,
        jehuca_enabled: settings.jehuca_enabled,
        bisdel_enabled: settings.bisdel_enabled,
        payload: [],
      });
    }

    const apiKey = readSecret("BISDEL_DB");
    const apiSecret = readSecret("BISDEL_SECRET_KEY");
    if (!apiKey || !apiSecret) {
      return json(
        { success: false, error: "Bisdel API credentials are not configured" },
        500,
      );
    }

    const response = await fetch(
      "https://bisdelgh.com/api/xx1/products.php",
      {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
          "X-API-Secret": apiSecret,
        },
      },
    );
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.success !== true) {
      return json(
        {
          success: false,
          error: data?.error || "Bisdel package request failed",
          provider_status: response.status,
        },
        response.ok ? 502 : response.status,
      );
    }

    const products = Array.isArray(data?.data?.products)
      ? data.data.products
      : [];
    const networkCounts = products.reduce(
      (counts: Record<string, number>, item) => {
        const product = item && typeof item === "object"
          ? item as Record<string, unknown>
          : {};
        const network = String(product.network || "UNKNOWN")
          .trim()
          .toUpperCase();
        counts[network] = (counts[network] || 0) + 1;
        return counts;
      },
      {},
    );
    console.log("Bisdel catalog package counts:", {
      total: products.length,
      byNetwork: networkCounts,
    });
    return json({
      success: true,
      data_provider: activeProvider,
      catalog_provider: "bisdel",
      jehuca_enabled: settings.jehuca_enabled,
      bisdel_enabled: settings.bisdel_enabled,
      payload: normalizeProducts(products),
    });
  } catch (error) {
    console.error("Error fetching Bisdel packages:", error);
    return json(
      {
        success: false,
        error: "Failed to fetch Bisdel packages",
        details: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});
