const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface OrderStatusResponse {
  status: boolean;
  message: string;
  statusCode: number;
  payload: {
    orderId: string;
    status: string;
    phone: string;
    network: string;
    type: string;
    size: number;
    amount: number;
    createdAt?: string;
    updatedAt?: string;
  };
}

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
    const orderId = url.pathname.split("/").pop();

    if (!orderId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid request",
          details: "orderId is required in the URL path",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const requestUrl = `https://backend.jehucale-business.com/api/orders/${orderId}`;

    console.log("Fetching order status for:", orderId);

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
    console.error("Error fetching order status:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to fetch order status",
        details: (error as Error).message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
