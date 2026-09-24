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

    const userRole = String(
      user.user_metadata?.role || user.app_metadata?.role || "",
    ).toLowerCase();
    if (userRole !== "superagent" && userRole !== "super_agent") {
      return new Response(
        JSON.stringify({
          error: "Only Super Agents can fund an operational wallet",
        }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Verify payment with Paystack
    const appEnv = (Deno.env.get("APP_ENV") || "").toLowerCase().trim();
    const paystackSecret =
      appEnv === "production"
        ? Deno.env.get("PAYSTACK_SECRET_KEY")
        : Deno.env.get("TEST_PAYSTACK_SECRET_KEY") ||
          Deno.env.get("PAYSTACK_SECRET_KEY");
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

    console.log(
      "[DEBUG] APP_ENV:",
      appEnv,
      "| secret starts with:",
      paystackSecret ? paystackSecret.substring(0, 7) : "NONE",
    );
    console.log("[DEBUG] Reference:", reference, "| User:", user?.id);

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
    console.log(
      "[DEBUG] Paystack response ok:",
      verifyResponse.ok,
      "| status:",
      verifyData.status,
      "| data.status:",
      verifyData.data?.status,
    );

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

    console.log(
      "[DEBUG] Wallet topup found:",
      existingTopup ? "yes" : "no",
      "| agent_id:",
      existingTopup?.agent_id,
      "| user.id:",
      user.id,
      "| status:",
      existingTopup?.status,
    );

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
    const updateData: Record<string, unknown> = {
      status: "success",
      paystack_transaction_id: verifyData.data.id.toString(),
      paystack_transaction_status: verifyData.data.status,
      paid_at: new Date(verifyData.data.paid_at).toISOString(),
      channel: verifyData.data.channel || null,
      bank: verifyData.data.authorization?.bank || null,
    };

    // Resolve the super agent for the current agent (if any) and capture the
    // Paystack subaccount the topup was charged through so we can reconcile
    // wallet funding against the super-agent's settlement later on.
    let resolvedSuperAgentId: string | null =
      user.user_metadata?.super_agent_id || null;
    let resolvedSubaccountCode: string | null =
      verifyData.data?.subaccount?.subaccount_code ||
      verifyData.data?.subaccount_code ||
      null;

    if (resolvedSuperAgentId && !resolvedSubaccountCode) {
      try {
        const { data: subaccountRow } = await supabaseAdmin
          .from("super_agent_paystack")
          .select("subaccount_code, is_active")
          .eq("super_agent_id", resolvedSuperAgentId)
          .maybeSingle();
        if (subaccountRow?.is_active && subaccountRow.subaccount_code) {
          resolvedSubaccountCode = subaccountRow.subaccount_code;
        }
      } catch (subaccountError) {
        console.warn(
          "Could not resolve super-agent subaccount for wallet topup:",
          subaccountError,
        );
      }
    }

    if (resolvedSubaccountCode) {
      updateData.paystack_subaccount_code = resolvedSubaccountCode;
    }

    const { error: updateError } = await supabaseAdmin
      .from("wallet_topups")
      .update(updateData)
      .eq("reference", reference);

    if (updateError) {
      // Tolerate databases that haven't run migration 004 (no
      // paystack_subaccount_code column) by retrying without that field.
      if (
        updateError.code === "42703" &&
        /paystack_subaccount_code/.test(updateError.message || "")
      ) {
        delete updateData.paystack_subaccount_code;
        const { error: retryError } = await supabaseAdmin
          .from("wallet_topups")
          .update(updateData)
          .eq("reference", reference);
        if (retryError) {
          console.error(
            "Failed to update wallet_topups (without subaccount column):",
            retryError,
          );
          return new Response(
            JSON.stringify({
              error: "Failed to update wallet topup",
              details: retryError,
            }),
            {
              status: 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
      } else {
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
    }

    {
      const { data: creditResult, error: creditError } =
        await supabaseAdmin.rpc("credit_super_agent_wallet", {
          p_super_agent_id: user.id,
          p_amount: existingTopup.amount,
          p_reference: `wallet-topup-${existingTopup.id}`,
          p_reason: "wallet_topup",
          p_metadata: {
            topup_id: existingTopup.id,
            paystack_transaction_id: verifyData.data.id,
          },
        });

      if (creditError || !creditResult?.success) {
        console.error("Failed to credit Super Agent wallet:", {
          creditError,
          creditResult,
        });
        return new Response(
          JSON.stringify({ error: "Failed to credit Super Agent wallet" }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          new_balance: creditResult.balance,
          already_processed: creditResult.already_processed || false,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
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
