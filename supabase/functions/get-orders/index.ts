const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("JEHUCA_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Jehuca API key not configured on server",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const url = new URL(req.url);
    const baseUrl = "https://backend.jehucale-business.com/api/orders";

    const queryParams = url.searchParams.toString();
    const requestUrl = queryParams ? `${baseUrl}?${queryParams}` : baseUrl;

    console.log("Fetching orders from:", requestUrl);

    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
      },
    });

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to fetch orders",
        details: (error as Error).message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
