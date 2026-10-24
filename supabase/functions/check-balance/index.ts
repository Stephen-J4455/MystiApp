import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-data-provider",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Supabase service configuration is missing",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: setting, error: settingError } = await admin
      .from("data_provider_settings")
      .select("provider")
      .eq("id", true)
      .single();
    if (settingError) throw settingError;
    const url = new URL(req.url);
    const requestedProvider = String(
      req.headers.get("x-data-provider") ||
        url.searchParams.get("provider") ||
        "",
    )
      .trim()
      .toLowerCase();
    if (
      requestedProvider &&
      requestedProvider !== "bisdel" &&
      requestedProvider !== "jehuca"
    ) {
      throw new Error("Unsupported balance provider");
    }
    const provider = requestedProvider || String(setting.provider || "").toLowerCase();

    let baseUrl: string;
    let headers: Record<string, string>;
    if (provider === "bisdel") {
      const apiKey = (Deno.env.get("BISDEL_DB") ?? "").replace(/\0/g, "").trim();
      const apiSecret = (Deno.env.get("BISDEL_SECRET_KEY") ?? "")
        .replace(/\0/g, "")
        .trim();
      if (!apiKey || !apiSecret) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Bisdel API credentials are not configured",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      baseUrl = "https://bisdelgh.com/api/xx1/balance.php";
      headers = { "X-API-Key": apiKey, "X-API-Secret": apiSecret };
    } else if (provider === "jehuca") {
      const apiKey = Deno.env.get("JEHUCA_API_KEY");
      if (!apiKey) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Jehuca API key is not configured",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      baseUrl = "https://backend.jehucale-business.com/api/balance";
      headers = { "X-API-Key": apiKey };
    } else {
      throw new Error("Configured data provider is invalid");
    }

    const queryParams = new URLSearchParams(url.searchParams);
    queryParams.delete("provider");
    const requestUrl = queryParams.toString()
      ? `${baseUrl}?${queryParams.toString()}`
      : baseUrl;

    console.log("Checking balance from:", requestUrl);

    const response = await fetch(requestUrl, {
      method: "GET",
      headers,
    });

    const data = await response.json();

    return new Response(
      JSON.stringify({
        ...data,
        balance: data?.data?.wallet_balance ?? data?.balance,
        data_provider: provider,
      }),
      {
        status: response.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("Error checking balance:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to check balance",
        details: (error as Error).message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
