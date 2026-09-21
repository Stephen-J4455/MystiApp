const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface OrderPackage {
  packageId: string;
  size: number;
  network: string;
  type: string;
  phone: string;
  callback?: string;
}

interface MakeOrdersRequest {
  packages: OrderPackage[];
}

interface OrderItem {
  id: string;
  packageId: string;
  phone: string;
  network: string;
  size: number;
  type: string;
  status: string;
  amount: number;
}

interface MakeOrdersResponse {
  status: boolean;
  message: string;
  statusCode: number;
  payload: {
    orderId: string;
    totalOrders: number;
    totalAmount: number;
    orders: OrderItem[];
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

    const body = (await req.json()) as MakeOrdersRequest;

    if (!body.packages || !Array.isArray(body.packages) || body.packages.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid request format",
          details: "packages is required and must be a non-empty array",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const url = "https://backend.jehucale-business.com/api/orders";

    console.log("Making orders via Jehuca API, packages count:", body.packages.length);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data: MakeOrdersResponse = await response.json();

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Error making orders:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to create orders",
        details: (error as Error).message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
