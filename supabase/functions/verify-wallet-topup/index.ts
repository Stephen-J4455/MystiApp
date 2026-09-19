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

    const { reference } = await req.json();

    console.log("Received request with params:", {
      reference,
    });

    if (!reference) {
      console.error("Missing required fields:", { reference });
      return new Response(
        JSON.stringify({
          error: "Missing required field: reference",
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

    // Check if wallet_topup exists for this reference
    const { data: existingTopup, error: topupError } = await supabaseAdmin
      .from("wallet_topups")
      .select("*")
      .eq("reference", reference)
      .single();

    if (topupError || !existingTopup) {
      console.error("Wallet topup not found:", topupError);
      return new Response(JSON.stringify({ error: "Wallet topup not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Ensure the topup belongs to the authenticated user
    if (existingTopup.agent_id !== user.id) {
      console.error("Unauthorized: topup does not belong to user");
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if already verified
    if (existingTopup.status === "success") {
      return new Response(
        JSON.stringify({ error: "Wallet topup already verified" }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Update wallet_topups
    const updateData = {
      status: "success",
      paystack_transaction_id: verifyData.data.id.toString(),
      paystack_transaction_status: verifyData.data.status,
      paid_at: new Date(verifyData.data.paid_at).toISOString(),
      channel: verifyData.data.channel || null,
      bank: verifyData.data.authorization?.bank || null,
    };

    const { error: updateError } = await supabaseAdmin
      .from("wallet_topups")
      .update(updateData)
      .eq("reference", reference);

    if (updateError) {
      console.error("Failed to update wallet_topups:", updateError);
      return new Response(
        JSON.stringify({
          error: "Failed to update wallet topup",
          details: updateError,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Get or create agent_wallet
    let { data: wallet, error: walletError } = await supabaseAdmin
      .from("agent_wallet")
      .select("*")
      .eq("agent_id", user.id)
      .single();

    if (walletError && walletError.code !== "PGRST116") {
      // PGRST116 is not found
      console.error("Error fetching agent_wallet:", walletError);
      return new Response(
        JSON.stringify({
          error: "Failed to fetch agent wallet",
          details: walletError,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (!wallet) {
      // Create new wallet
      const { data: newWallet, error: createError } = await supabaseAdmin
        .from("agent_wallet")
        .insert({
          agent_id: user.id,
          balance: 0,
        })
        .select()
        .single();

      if (createError) {
        console.error("Failed to create agent_wallet:", createError);
        return new Response(
          JSON.stringify({
            error: "Failed to create agent wallet",
            details: createError,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      wallet = newWallet;
    }

    // Update balance
    const newBalance = (wallet.balance || 0) + existingTopup.amount;

    const { error: balanceError } = await supabaseAdmin
      .from("agent_wallet")
      .update({ balance: newBalance })
      .eq("agent_id", user.id);

    if (balanceError) {
      console.error("Failed to update agent_wallet balance:", balanceError);
      return new Response(
        JSON.stringify({
          error: "Failed to update wallet balance",
          details: balanceError,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Send notification to the user
    try {
      console.log("Sending push notification to user...");

      await supabaseAuth.functions.invoke("send-notification", {
        body: {
          userId: user.id,
          title: "Wallet Top-up Successful",
          message: `Your wallet has been credited with GHS ${existingTopup.amount}. New balance: GHS ${newBalance}`,
          type: "wallet_topup",
        },
      });
    } catch (pushError) {
      console.error("Error sending push notification to user:", pushError);
    }

    // Notify admins about the top-up
    try {
      console.log("Notifying admins about wallet top-up...");
      await supabaseAuth.functions.invoke("send-notification", {
        body: {
          sendToAdmins: true,
          title: "Agent Wallet Top-up",
          message: `Agent ${user.email} topped up GHS ${existingTopup.amount}. New balance: GHS ${newBalance}`,
          type: "wallet_topup",
        },
      });
    } catch (adminNotifyError) {
      console.error("Error notifying admins:", adminNotifyError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Wallet topup verified and balance updated successfully",
        new_balance: newBalance,
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
