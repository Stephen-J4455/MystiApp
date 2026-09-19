import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Initialize Supabase clients
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? supabaseAnonKey;

    // Get and validate Authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.error("Missing Authorization header");
      return new Response(
        JSON.stringify({ error: "Missing authorization token" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Client for user authentication
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    // Client for admin operations (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Get the current user
    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser();

    console.log("User authentication result:", {
      userId: user?.id,
      userEmail: user?.email,
      authError: authError?.message,
    });

    if (authError || !user) {
      console.error("User authentication failed:", authError);
      return new Response(
        JSON.stringify({
          error: "Unauthorized",
          details: authError?.message || "User not authenticated",
        }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const {
      reference,
      offer_id,
      recipient_phone,
      amount,
      network,
      super_agent_id,
    } = await req.json();

    console.log("Received request with params:", {
      reference,
      offer_id,
      recipient_phone,
      amount,
      network,
      super_agent_id,
    });

    if (!reference || !offer_id) {
      console.error("Missing required fields:", { reference, offer_id });
      return new Response(
        JSON.stringify({
          error: "Missing required fields: reference and offer_id",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Verify payment with Paystack
    const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackSecret) {
      console.error("PAYSTACK_SECRET_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Payment service not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Verify the payment with Paystack
    console.log("Verifying payment with Paystack for reference:", reference);
    const verifyResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${paystackSecret}`,
          "Content-Type": "application/json",
        },
      },
    );

    const verifyData = await verifyResponse.json();
    console.log("Paystack verification response:", verifyData);
    console.log("Payment channel:", verifyData.data?.channel);
    console.log("Payment bank:", verifyData.data?.authorization?.bank);

    if (
      !verifyResponse.ok ||
      verifyData.status !== true ||
      verifyData.data.status !== "success"
    ) {
      console.error("Payment verification failed:", verifyData);
      return new Response(
        JSON.stringify({
          error: "Payment verification failed",
          details: verifyData,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Get offer details from the database.
    // Prefer the normal offers table for the current production schema,
    // but support a super-agent offer table if it has been added.
    console.log("Fetching offer with ID:", offer_id);
    let offer = null;
    let offerError = null;

    const offerQueries = [
      { table: "offers", select: "*" },
      { table: "super_agent_offers", select: "*, super_agent_id" },
    ];

    for (const query of offerQueries) {
      try {
        const { data, error } = await supabaseAdmin
          .from(query.table)
          .select(query.select)
          .eq("id", offer_id)
          .single();

        if (!error && data) {
          offer = data;
          offerError = null;
          break;
        }

        if (error && error.code !== "PGRST116") {
          offerError = error;
        }
      } catch (queryError) {
        console.log(`Query for ${query.table} failed:`, queryError);
      }
    }

    console.log("Offer query result:", { offer, offerError });

    if (!offer) {
      console.error("Offer not found:", offerError);
      console.log("Proceeding with frontend-provided data");
    }

    // Check if order already exists for this reference
    const { data: existingOrders } = await supabaseAdmin
      .from("orders")
      .select("id")
      .eq("payment_reference", reference);

    if (existingOrders && existingOrders.length > 0) {
      return new Response(
        JSON.stringify({ error: "Order already exists for this payment" }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Create the order with data from both the payment verification and the offer
    const isSelfPurchase =
      !recipient_phone || recipient_phone === (user.user_metadata?.phone || "");

    // Use offer data if available, otherwise use the provided amount and network
    const orderAmount = offer?.price || amount || verifyData.data.amount / 100;
    const orderNetwork = offer?.network || network || "Unknown";
    const orderTitle = offer?.title || `${orderNetwork} Data Bundle`;

    const resolvedSuperAgentId =
      super_agent_id ||
      user.user_metadata?.super_agent_id ||
      offer?.super_agent_id ||
      null;

    const settlement = (() => {
      const gross = Number(orderAmount || 0);
      const adminShareRate = 0.3;
      const superAgentShareRate = 0.2;
      const adminShare = Number((gross * adminShareRate).toFixed(2));
      const superAgentShare = Number((gross * superAgentShareRate).toFixed(2));
      const agentNet = Number(
        (gross - adminShare - superAgentShare).toFixed(2),
      );

      return {
        adminShare,
        superAgentShare,
        agentNet,
      };
    })();

    const orderData = {
      user_id: user.id,
      user_name:
        user.user_metadata?.full_name || user.email?.split("@")[0] || "Unknown",
      user_email: user.email,
      phone: recipient_phone || user.user_metadata?.phone || null,
      offer_title: orderTitle,
      amount: orderAmount,
      network: orderNetwork,
      status: "pending",
      payment_reference: reference,
      is_self: isSelfPurchase,
      data_amount: orderTitle,
      offer_id: parseInt(offer_id),
      paystack_transaction_id: verifyData.data.id.toString(),
      paystack_transaction_status: verifyData.data.status,
      paid_at: new Date(verifyData.data.paid_at).toISOString(),
      device_token: null,
      country_code: "GH", // Ghana
      channel: verifyData.data.channel || null,
      bank: verifyData.data.authorization?.bank || null,
    };

    console.log("Creating order with data:", orderData);

    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .insert(orderData)
      .select()
      .single();

    if (orderError) {
      console.error("Order creation failed:", orderError);
      return new Response(
        JSON.stringify({
          error: "Failed to create order",
          details: orderError,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Optional: record settlement against the super-agent chain if the extended tables exist.
    try {
      if (resolvedSuperAgentId) {
        const { error: settlementError } = await supabaseAdmin
          .from("agent_payment_settlements")
          .insert({
            agent_order_id: order.id,
            agent_id: user.id,
            super_agent_id: resolvedSuperAgentId,
            admin_id: null,
            gross_amount: orderAmount,
            super_agent_share: settlement.superAgentShare,
            admin_share: settlement.adminShare,
            agent_net: settlement.agentNet,
            status: "pending",
          });

        if (settlementError) {
          console.warn(
            "Super-agent settlement table is unavailable or not migrated yet:",
            settlementError.message,
          );
        } else {
          console.log(
            "Settlement row created successfully for super-agent split",
          );
        }
      }
    } catch (settlementCatchError) {
      console.warn(
        "Settlement creation skipped because extended tables are not available yet:",
        settlementCatchError,
      );
    }

    // Send notification to the user
    try {
      console.log("Sending push notification to user...");

      await supabaseAuth.functions.invoke("send-notification", {
        body: {
          userId: user.id,
          title: "Data Purchase Successful",
          message: `Your ${orderTitle} data bundle purchase has been confirmed and is being processed.`,
          type: "order",
        },
      });
    } catch (pushError) {
      console.error("Error sending push notification:", pushError);
    }

    // Send push notification to all admins about the new order
    try {
      console.log("Sending new order notification to admins...");

      // Use same method as user notifications (works with proper auth)
      const { data: notifyAdminsResult, error: notifyAdminsError } =
        await supabaseAuth.functions.invoke("send-notification", {
          body: {
            sendToAdmins: true,
            title: "New Order Received",
            message: `Order #${order.id} - ${orderTitle} for GHC ${orderAmount} from ${user.email}`,
            type: "order",
          },
        });

      if (notifyAdminsError) {
        console.error("Failed to notify admins:", notifyAdminsError);
      } else {
        console.log(
          "Admin notification sent successfully:",
          notifyAdminsResult,
        );
      }
    } catch (adminPushError) {
      console.error("Error sending admin notifications:", adminPushError);
      // Don't fail the request if admin notification fails
    }

    return new Response(
      JSON.stringify({
        success: true,
        order: order,
        message: "Payment verified and order created successfully",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
