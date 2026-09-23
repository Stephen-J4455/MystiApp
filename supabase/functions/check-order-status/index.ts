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
    totalOrders: number;
    totalAmount: number;
    orders: Array<{
      id: string;
      packageId: string;
      phone: string;
      network: string;
      size: number;
      type: string;
      status: string;
      amount: number;
    }>;
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
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    const orderId =
      body?.orderId ||
      url.searchParams.get("orderId") ||
      url.pathname.split("/").pop();

    if (!orderId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid request",
          details: "orderId is required in the URL path",
        }),
        {
          status: 200,
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

    if (!response.ok || data?.success === false || data?.status === false) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            data?.error || data?.message || "Jehucal status request failed",
          providerStatusCode: response.status,
          providerResponse: data,
          orderId,
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    // The provider returns the current status on the first order in payload.orders.
    const providerOrder = data?.payload?.orders?.[0];
    const providerOrderStatus =
      providerOrder?.status ??
      (Array.isArray(data?.payload)
        ? (data.payload[0]?.packages?.[0]?.status ?? null)
        : (data?.payload?.status ?? null));

    return new Response(
      JSON.stringify({
        ...data,
        providerOrderStatus,
        orderStatus: providerOrderStatus,
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
    console.error("Error fetching order status:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to fetch order status",
        details: (error as Error).message,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
