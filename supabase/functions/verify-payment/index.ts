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
      base_price,
      tier_extra,
      transaction_fee,
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
    const orderAmount = Number(
      amount || offer?.price || verifyData.data.amount / 100,
    );
    const chargedAmount = Number(verifyData.data.amount || 0) / 100;
    if (Math.abs(chargedAmount - orderAmount) > 0.01) {
      return new Response(
        JSON.stringify({
          error: "Payment amount does not match the order",
          expected: orderAmount,
          received: chargedAmount,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const orderNetwork = offer?.network || network || "Unknown";
    const orderTitle = offer?.title || `${orderNetwork} Data Bundle`;

    const resolvedSuperAgentId =
      super_agent_id ||
      user.user_metadata?.super_agent_id ||
      offer?.super_agent_id ||
      null;

    // Resolve the Paystack subaccount linked to the super agent (if any)
    // so the order and settlement can be traced back to where the funds were routed.
    let resolvedSubaccountCode: string | null = null;
    if (resolvedSuperAgentId) {
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
          "Could not resolve super-agent subaccount, continuing without it:",
          subaccountError,
        );
      }
    }

    // Paystack returns the subaccount it charged through on the transaction
    // object. Prefer that as the source of truth, then fall back to our DB record.
    const paystackSubaccountCode =
      verifyData.data?.subaccount?.subaccount_code ||
      verifyData.data?.subaccount_code ||
      resolvedSubaccountCode ||
      null;

    const settlement = (() => {
      const gross = Number(orderAmount || 0);
      const requestedBase = Number(base_price);
      const requestedTierExtra = Number(tier_extra);
      const requestedTransactionFee = Number(transaction_fee);
      const hasPaymentSplit =
        Boolean(resolvedSuperAgentId) &&
        Number.isFinite(requestedBase) &&
        Number.isFinite(requestedTierExtra) &&
        requestedBase >= 0 &&
        requestedTierExtra >= 0 &&
        requestedTransactionFee >= 0 &&
        Math.abs(
          requestedBase + requestedTierExtra + requestedTransactionFee - gross,
        ) <= 0.01 &&
        Math.abs(requestedTransactionFee - requestedBase * 0.02) <= 0.01;

      if (hasPaymentSplit) {
        return {
          adminShare: Number(
            (requestedBase + requestedTransactionFee).toFixed(2),
          ),
          superAgentShare: Number(requestedTierExtra.toFixed(2)),
          agentNet: 0,
          baseAmount: Number(requestedBase.toFixed(2)),
          agentMarkup: Number(requestedTierExtra.toFixed(2)),
          transactionFee: Number(requestedTransactionFee.toFixed(2)),
        };
      }

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
        baseAmount: Number(gross.toFixed(2)),
        agentMarkup: 0,
        transactionFee: 0,
      };
    })();

    const isAgentOrder = Boolean(
      resolvedSuperAgentId || user.user_metadata?.role === "Agent",
    );

    const sharedOrderFields = {
      amount: orderAmount,
      network: orderNetwork,
      status: "pending",
      payment_reference: reference,
      paystack_transaction_id: verifyData.data.id.toString(),
      paystack_transaction_status: verifyData.data.status,
      paid_at: new Date(verifyData.data.paid_at).toISOString(),
      channel: verifyData.data.channel || null,
      bank: verifyData.data.authorization?.bank || null,
    };

    let order: any = null;
    let orderError: any = null;

    if (isAgentOrder) {
      // Sub-agent / super-agent path — use agent_orders so the settlement split
      // and super-agent chain survive the order lifecycle.
      const agentOrderData = {
        agent_id: user.id,
        offer_id: parseInt(offer_id),
        offer_title: orderTitle,
        network: orderNetwork,
        amount: orderAmount,
        recipient_phone: recipient_phone || user.user_metadata?.phone || null,
        recipient_name:
          user.user_metadata?.full_name || user.email?.split("@")[0] || null,
        status: "pending",
        transaction_status: verifyData.data.status,
        channel: sharedOrderFields.channel,
        device_token: null,
        super_agent_id: resolvedSuperAgentId,
        admin_share: settlement.adminShare,
        super_agent_share: settlement.superAgentShare,
        agent_net: settlement.agentNet,
        base_amount: settlement.baseAmount,
        agent_markup: settlement.agentMarkup,
        transaction_fee: settlement.transactionFee,
        main_account_amount: settlement.adminShare,
        settlement_status: "pending",
        paystack_subaccount_code: paystackSubaccountCode,
        paystack_transaction_id: sharedOrderFields.paystack_transaction_id,
        paystack_transaction_status:
          sharedOrderFields.paystack_transaction_status,
        paid_at: sharedOrderFields.paid_at,
        bank: sharedOrderFields.bank,
      };

      console.log("Creating agent_order with data:", agentOrderData);

      const { data, error } = await supabaseAdmin
        .from("agent_orders")
        .insert(agentOrderData)
        .select()
        .single();

      order = data;
      orderError = error;
    } else {
      const orderData = {
        user_id: user.id,
        user_name:
          user.user_metadata?.full_name ||
          user.email?.split("@")[0] ||
          "Unknown",
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
        paystack_transaction_id: sharedOrderFields.paystack_transaction_id,
        paystack_transaction_status:
          sharedOrderFields.paystack_transaction_status,
        paid_at: sharedOrderFields.paid_at,
        device_token: null,
        country_code: "GH", // Ghana
        channel: sharedOrderFields.channel,
        bank: sharedOrderFields.bank,
      };

      console.log("Creating order with data:", orderData);

      const { data, error } = await supabaseAdmin
        .from("orders")
        .insert(orderData)
        .select()
        .single();

      order = data;
      orderError = error;
    }

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
    // Only meaningful when the order is in agent_orders (i.e. when isAgentOrder is true).
    try {
      if (isAgentOrder && resolvedSuperAgentId) {
        const settlementInsert: Record<string, unknown> = {
          agent_order_id: order.id,
          agent_id: user.id,
          super_agent_id: resolvedSuperAgentId,
          admin_id: null,
          gross_amount: orderAmount,
          super_agent_share: settlement.superAgentShare,
          admin_share: settlement.adminShare,
          agent_net: settlement.agentNet,
          status: "pending",
        };

        if (paystackSubaccountCode) {
          // If the schema has been extended to record subaccount on the
          // settlement row it will be persisted; otherwise the column simply
          // doesn't exist and the insert succeeds without it.
          settlementInsert.paystack_subaccount_code = paystackSubaccountCode;
        }

        const { error: settlementError } = await supabaseAdmin
          .from("agent_payment_settlements")
          .insert(settlementInsert);

        if (settlementError) {
          // If the only issue is an unknown paystack_subaccount_code column,
          // retry without it so a fresh database without migration 004 still works.
          if (
            settlementError.code === "42703" &&
            /paystack_subaccount_code/.test(settlementError.message || "")
          ) {
            delete settlementInsert.paystack_subaccount_code;
            const { error: retryError } = await supabaseAdmin
              .from("agent_payment_settlements")
              .insert(settlementInsert);
            if (retryError) {
              console.warn(
                "Super-agent settlement insert (without subaccount) failed:",
                retryError.message,
              );
            } else {
              console.log("Settlement row created (without subaccount column)");
            }
          } else {
            console.warn(
              "Super-agent settlement table is unavailable or not migrated yet:",
              settlementError.message,
            );
          }
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

    const { error: transactionError } = await supabaseAdmin
      .from("payment_transactions")
      .insert({
        user_id: user.id,
        order_id: order.id,
        order_type: isAgentOrder ? "agent" : "regular",
        payment_reference: reference,
        paystack_transaction_id: sharedOrderFields.paystack_transaction_id,
        paystack_transaction_status:
          sharedOrderFields.paystack_transaction_status,
        gross_amount: orderAmount,
        base_amount: isAgentOrder ? settlement.baseAmount : orderAmount,
        agent_markup: settlement.agentMarkup,
        transaction_fee: settlement.transactionFee,
        main_account_amount: isAgentOrder ? settlement.adminShare : orderAmount,
        super_agent_amount: settlement.superAgentShare,
        agent_net: settlement.agentNet,
        super_agent_id: isAgentOrder ? resolvedSuperAgentId : null,
        settlement_status: isAgentOrder ? "pending" : "settled",
        network: orderNetwork,
        offer_title: orderTitle,
        recipient_phone: recipient_phone || user.user_metadata?.phone || null,
        channel: sharedOrderFields.channel,
        bank: sharedOrderFields.bank,
        paystack_subaccount_code: paystackSubaccountCode,
      });

    if (transactionError) {
      console.error(
        "Payment transaction ledger insert failed:",
        transactionError,
      );
      return new Response(
        JSON.stringify({
          error: "Payment recorded but transaction ledger failed",
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
        is_agent_order: isAgentOrder,
        super_agent_id: resolvedSuperAgentId,
        paystack_subaccount_code: paystackSubaccountCode,
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
