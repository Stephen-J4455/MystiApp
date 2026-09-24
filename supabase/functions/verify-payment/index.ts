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
      wallet_order,
      package_name,
      package_size,
      provider_type,
      provider_size,
      recipient_phone,
      amount,
      base_price,
      tier_extra,
      transaction_fee,
      network,
      super_agent_id,
      recipient_name,
    } = await req.json();

    console.log("Received request with params:", {
      reference,
      offer_id,
      recipient_phone,
      amount,
      network,
      super_agent_id,
    });

    if (wallet_order) {
      const role = String(
        user.user_metadata?.role || user.app_metadata?.role || "",
      ).toLowerCase();
      const isSuperAgent = role === "superagent" || role === "super_agent";
      const walletAmount = Number(amount);

      if (!isSuperAgent) {
        return new Response(
          JSON.stringify({ error: "Super Agent role required" }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      if (
        !reference ||
        !offer_id ||
        !Number.isFinite(walletAmount) ||
        walletAmount <= 0
      ) {
        return new Response(
          JSON.stringify({ error: "Missing or invalid wallet order fields" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const normalizedSize = String(package_size || "").trim();
      const orderNetwork = String(network || "Unknown").toUpperCase();
      const orderTitle = normalizedSize
        ? `${orderNetwork} - ${normalizedSize} Data Bundle`
        : package_name || `${orderNetwork} Data Bundle`;
      const recipientPhone =
        recipient_phone || user.user_metadata?.phone || null;
      const orderData = {
        user_id: user.id,
        user_name:
          user.user_metadata?.full_name ||
          user.email?.split("@")[0] ||
          "Unknown",
        user_email: user.email,
        phone: recipientPhone,
        offer_title: orderTitle,
        amount: walletAmount,
        network: orderNetwork,
        status: "pending",
        payment_reference: reference,
        is_self: recipientPhone === (user.user_metadata?.phone || ""),
        data_amount: orderTitle,
        offer_id: null,
        device_token: null,
        country_code: "GH",
      };

      const { data: order, error: orderError } = await supabaseAdmin
        .from("orders")
        .insert(orderData)
        .select()
        .single();
      if (orderError) {
        console.error("Wallet order creation failed:", orderError);
        return new Response(
          JSON.stringify({
            error: "Failed to create wallet order",
            details: orderError,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data: debitResult, error: debitError } = await supabaseAdmin.rpc(
        "debit_super_agent_wallet",
        {
          p_super_agent_id: user.id,
          p_amount: walletAmount,
          p_reference: `wallet-order-${reference}`,
          p_order_id: order.id,
          p_reason: "super_agent_package_purchase",
        },
      );
      if (debitError || !debitResult?.success) {
        await supabaseAdmin
          .from("orders")
          .update({ status: "held" })
          .eq("id", order.id);
        return new Response(
          JSON.stringify({
            success: true,
            held: true,
            reason: debitResult?.reason || "wallet_debit_failed",
            balance: debitResult?.balance,
            required: debitResult?.required || walletAmount,
            order,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { error: transactionError } = await supabaseAdmin
        .from("payment_transactions")
        .insert({
          user_id: user.id,
          order_id: order.id,
          order_type: "regular",
          payment_reference: reference,
          gross_amount: walletAmount,
          base_amount: Number(base_price || walletAmount),
          transaction_fee: Number(transaction_fee || 0),
          main_account_amount: walletAmount,
          settlement_status: "settled",
          status: "success",
          network: orderNetwork,
          offer_title: orderTitle,
          recipient_phone: recipientPhone,
        });
      if (transactionError) {
        console.error(
          "Wallet transaction ledger insert failed:",
          transactionError,
        );
        return new Response(
          JSON.stringify({
            error: "Wallet debited but ledger creation failed",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          held: false,
          order,
          wallet: debitResult,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

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
    const normalizedPackageSize = String(package_size || "")
      .trim()
      .replace(/\s+/g, " ");
    const orderTitle =
      offer?.title ||
      (normalizedPackageSize
        ? `${orderNetwork} - ${normalizedPackageSize} Data Bundle`
        : package_name || `${orderNetwork} Data Bundle`);
    const localOfferId = offer?.id ? Number(offer.id) : null;

    console.log("Resolved local offer reference:", {
      requestedOfferId: offer_id,
      localOfferId,
      hasLocalOffer: Boolean(offer),
    });

    const userRole = String(
      user.user_metadata?.role || user.app_metadata?.role || "",
    ).toLowerCase();
    const assignedSuperAgentId =
      user.user_metadata?.super_agent_id ||
      user.user_metadata?.superAgentId ||
      user.app_metadata?.super_agent_id ||
      user.app_metadata?.superAgentId ||
      null;
    const resolvedSuperAgentId = assignedSuperAgentId || null;
    const isSubAgentOrder = Boolean(resolvedSuperAgentId);

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

    if (isSubAgentOrder && !paystackSubaccountCode) {
      return new Response(
        JSON.stringify({
          error: "Super Agent Paystack subaccount is not available",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: chargeSettings } = await supabaseAdmin
      .from("payment_charge_settings")
      .select("super_agent_percent")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const superAgentChargePercent = Number(
      chargeSettings?.super_agent_percent ?? 1.95,
    );

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
        Math.abs(
          requestedTransactionFee -
            requestedBase * (superAgentChargePercent / 100),
        ) <= 0.01;

      if (hasPaymentSplit) {
        return {
          adminShare: Number(requestedTransactionFee.toFixed(2)),
          superAgentShare: Number(
            (requestedBase + requestedTierExtra).toFixed(2),
          ),
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

    const requestedBase = Number(base_price);
    const requestedTierExtra = Number(tier_extra);
    const requestedTransactionFee = Number(transaction_fee);
    const hasConfiguredSubAgentSplit =
      Boolean(resolvedSuperAgentId) &&
      Number.isFinite(requestedBase) &&
      Number.isFinite(requestedTierExtra) &&
      Number.isFinite(requestedTransactionFee) &&
      requestedBase >= 0 &&
      requestedTierExtra >= 0 &&
      requestedTransactionFee >= 0 &&
      Math.abs(
        requestedBase +
          requestedTierExtra +
          requestedTransactionFee -
          orderAmount,
      ) <= 0.01 &&
      Math.abs(
        requestedTransactionFee -
          requestedBase * (superAgentChargePercent / 100),
      ) <= 0.01;

    if (isSubAgentOrder && !hasConfiguredSubAgentSplit) {
      return new Response(
        JSON.stringify({
          error: "Invalid sub-agent settlement breakdown",
          details: {
            base_price,
            tier_extra,
            transaction_fee,
            amount: orderAmount,
            super_agent_charge_percent: superAgentChargePercent,
          },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const isAgentOrder = Boolean(
      resolvedSuperAgentId || user.user_metadata?.role === "Agent",
    );
    const rawProviderType = String(
      provider_type || offer?.type || "",
    ).toUpperCase();
    const normalizedProviderType = rawProviderType.includes("BIG TIME")
      ? "BIG TIME"
      : rawProviderType.includes("ISHARE")
        ? "ISHARE"
        : rawProviderType.split(/[(-]/)[0].trim();
    const normalizedProviderSize = Number(
      provider_size ||
        normalizedPackageSize.match(/(\d+(?:\.\d+)?)\s*GB/i)?.[1] ||
        0,
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
        offer_id: localOfferId,
        provider_package_id: String(offer_id),
        provider_type: normalizedProviderType,
        provider_size: normalizedProviderSize,
        offer_title: orderTitle,
        network: orderNetwork,
        amount: orderAmount,
        recipient_phone: recipient_phone || user.user_metadata?.phone || null,
        recipient_name:
          recipient_name ||
          user.user_metadata?.full_name ||
          user.email?.split("@")[0] ||
          null,
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
        // Normal-user package IDs come from Jehuca, not public.offers.
        // Keep this nullable unless a matching local offer was found so the
        // orders foreign key is not given an unrelated provider package ID.
        offer_id: localOfferId,
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

    let walletDebit: any = null;
    if (isSubAgentOrder) {
      const { data: debitResult, error: debitError } = await supabaseAdmin.rpc(
        "debit_super_agent_wallet",
        {
          p_super_agent_id: resolvedSuperAgentId,
          p_amount: settlement.baseAmount,
          p_reference: `agent-order-${order.id}`,
          p_order_id: order.id,
          p_reason: "sub_agent_order",
        },
      );

      walletDebit = debitResult;
      if (debitError || !debitResult?.success) {
        console.warn("Super Agent wallet debit held the order:", {
          debitError: debitError?.message,
          debitResult,
        });
        await supabaseAdmin
          .from("agent_orders")
          .update({
            status: "held",
            transaction_status: "wallet_insufficient",
            settlement_status: "pending",
          })
          .eq("id", order.id);
      }
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
        status: isSubAgentOrder && !walletDebit?.success ? "held" : "success",
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
        held: isSubAgentOrder && !walletDebit?.success,
        hold_reason:
          isSubAgentOrder && !walletDebit?.success
            ? walletDebit?.reason || "wallet_debit_failed"
            : null,
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
