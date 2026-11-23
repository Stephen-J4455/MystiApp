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
      const apiKey = (Deno.env.get("TELCOGH_API_KEY") ?? "").replace(/\0/g, "").trim() ||
        (Deno.env.get("BISDEL_DB") ?? "").replace(/\0/g, "").trim();
      if (!apiKey) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Configure TELCOGH_API_KEY or BISDEL_DB with the TelcoGH API key",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      baseUrl = "https://telcogh.com/api/v1/balance";
      headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
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

    const data = await response.json().catch(() => null);
    if (data === null) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `${provider === "bisdel" ? "Bisdel" : "Jehuca"} returned an invalid balance response`,
          data_provider: provider,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        ...data,
        balance: data?.data?.wallet_balance ?? data?.balance,
        ...(provider === "bisdel" && data?.status === "error"
          ? { success: false, error: data.message }
          : {}),
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
    console.error("Error checking balance:", error instanceof Error ? error.name : "Unknown error");
    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to check balance",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
