import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const normalizeRole = (user: any) => {
  const role = String(
    user?.user_metadata?.role || user?.app_metadata?.role || "",
  )
    .trim()
    .toLowerCase();
  if (role === "admin") return "Admin";
  if (role === "superagent" || role === "super_agent") return "SuperAgent";
  if (role === "agent" || role === "sub_agent") return "Agent";
  return null;
};

const clean = (value: unknown, maxLength = 200) =>
  String(value ?? "")
    .trim()
    .slice(0, maxLength);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization token" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceKey)
      return json({ error: "Server is not configured" }, 500);

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceKey);
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const role = normalizeRole(user);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "getStatus");

    if (action === "getStatus" || action === "create") {
      const { data: settings, error: settingsError } = await admin
        .from("afa_registration_settings")
        .select("registration_fee, currency, is_enabled")
        .eq("id", true)
        .maybeSingle();
      if (settingsError) throw settingsError;

      let registrationsQuery = admin
        .from("afa_registrations")
        .select("*")
        .eq("registered_user_id", user.id)
        .order("created_at", { ascending: false });
      const { data: registrations, error: registrationsError } =
        await registrationsQuery;
      if (registrationsError) throw registrationsError;
      return json({ settings, registrations: registrations || [] });
    }

    if (action === "createRegistration") {
      const { data: settings, error: settingsError } = await admin
        .from("afa_registration_settings")
        .select("*")
        .eq("id", true)
        .maybeSingle();
      if (settingsError) throw settingsError;
      if (!settings?.is_enabled || Number(settings.registration_fee) <= 0) {
        return json(
          { error: "AFA registration is not currently available" },
          400,
        );
      }

      const { data: pendingRegistration, error: pendingLookupError } =
        await admin
          .from("afa_registrations")
          .select("id")
          .eq("registered_user_id", user.id)
          .eq("status", "pending_payment")
          .maybeSingle();
      if (pendingLookupError) throw pendingLookupError;
      if (pendingRegistration) {
        return json(
          {
            error: "Complete or cancel the existing pending AFA request first",
          },
          409,
        );
      }

      const fullName = clean(body.fullName, 120);
      const phone = clean(body.phone, 30);
      const idType = clean(body.idType, 30);
      const idNumber = clean(body.idNumber, 80).toUpperCase();
      const townCity = clean(body.townCity, 120);
      const occupation = clean(body.occupation, 120);
      if (!fullName || !phone || !idNumber || !townCity || !occupation) {
        return json({ error: "All registration details are required" }, 400);
      }
      if (!["National ID", "Voters ID"].includes(idType)) {
        return json({ error: "Select a valid ID type" }, 400);
      }

      const isSuperAgent = role === "SuperAgent";
      const paymentMethod = isSuperAgent ? "wallet" : "paystack";
      const reference = `afa_${Date.now()}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const superAgentId = isSuperAgent
        ? user.id
        : clean(
            user.user_metadata?.super_agent_id ||
              user.user_metadata?.superAgentId ||
              user.app_metadata?.super_agent_id ||
              user.app_metadata?.superAgentId,
          ) || null;

      const { data: registration, error: createError } = await admin
        .from("afa_registrations")
        .insert({
          registered_user_id: user.id,
          payer_user_id: user.id,
          assigned_super_agent_id: superAgentId,
          full_name: fullName,
          phone,
          id_type: idType,
          id_number: idNumber,
          town_city: townCity,
          occupation,
          additional_info: clean(body.additionalInfo, 1000)
            ? { details: clean(body.additionalInfo, 1000) }
            : {},
          fee_amount: Number(settings.registration_fee),
          currency: settings.currency || "GHS",
          payment_method: paymentMethod,
          payment_reference: reference,
          status: "pending_payment",
        })
        .select()
        .single();
      if (createError) throw createError;

      if (isSuperAgent) {
        const { data: result, error: walletError } = await admin.rpc(
          "pay_afa_registration_from_wallet",
          {
            p_registration_id: registration.id,
            p_super_agent_id: user.id,
            p_reference: reference,
          },
        );
        if (walletError) throw walletError;
        if (!result?.success) {
          await admin
            .from("afa_registrations")
            .delete()
            .eq("id", registration.id);
          return json(
            {
              error:
                result?.reason === "insufficient_balance"
                  ? "Insufficient wallet balance for AFA registration"
                  : "Unable to pay from wallet",
              balance: result?.debit?.balance,
              required: result?.debit?.required,
            },
            400,
          );
        }
        return json({
          success: true,
          registration: result.registration,
          balance: result.debit?.balance,
        });
      }

      return json({ success: true, registration, paymentMethod });
    }

    if (action === "verifyPaystack") {
      const reference = clean(body.reference, 100);
      const registrationId = clean(body.registrationId, 100);
      if (!reference || !registrationId)
        return json({ error: "Registration and reference are required" }, 400);

      const { data: registration, error: lookupError } = await admin
        .from("afa_registrations")
        .select("*")
        .eq("id", registrationId)
        .eq("registered_user_id", user.id)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (!registration) return json({ error: "Registration not found" }, 404);

      const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY");
      if (!paystackSecret)
        return json({ error: "Paystack is not configured" }, 500);

      const paystackResponse = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${paystackSecret}` } },
      );
      const paystack = await paystackResponse.json();
      if (
        !paystackResponse.ok ||
        !paystack?.status ||
        paystack?.data?.status !== "success"
      ) {
        return json(
          { error: paystack?.message || "Paystack payment was not successful" },
          400,
        );
      }
      if (paystack.data.reference !== registration.payment_reference) {
        return json(
          { error: "Payment reference does not match registration" },
          400,
        );
      }
      if (
        Number(paystack.data.amount) / 100 !==
        Number(registration.fee_amount)
      ) {
        return json(
          { error: "Paid amount does not match the registration fee" },
          400,
        );
      }
      if (String(paystack.data.currency || "").toUpperCase() !== "GHS") {
        return json({ error: "Payment currency is invalid" }, 400);
      }

      const { data: result, error: finalizeError } = await admin.rpc(
        "finalize_afa_registration_payment",
        {
          p_registration_id: registrationId,
          p_reference: reference,
          p_paystack_transaction_id: String(paystack.data.id),
          p_paystack_status: paystack.data.status,
          p_paid_at: paystack.data.paid_at || null,
        },
      );
      if (finalizeError) throw finalizeError;
      return json({
        success: true,
        registration: result.registration,
        alreadyProcessed: result.already_processed,
      });
    }

    if (action === "list") {
      if (role !== "Admin" && role !== "SuperAgent")
        return json({ error: "Admin access required" }, 403);
      let query = admin
        .from("afa_registrations")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (role === "SuperAgent") query = query.eq("payer_user_id", user.id);
      const { data, error } = await query;
      if (error) throw error;
      let ledgerQuery = admin
        .from("afa_payment_ledger")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (role === "SuperAgent")
        ledgerQuery = ledgerQuery.eq("payer_user_id", user.id);
      const { data: ledger, error: ledgerError } = await ledgerQuery;
      if (ledgerError) throw ledgerError;
      return json({ registrations: data || [], ledger: ledger || [] });
    }

    if (action === "updateSettings") {
      if (role !== "Admin")
        return json({ error: "Admin access required" }, 403);
      const fee = Number(body.registrationFee);
      if (!Number.isFinite(fee) || fee < 0)
        return json({ error: "Invalid registration fee" }, 400);
      const { data, error } = await admin
        .from("afa_registration_settings")
        .update({
          registration_fee: fee,
          is_enabled: Boolean(body.isEnabled),
          updated_by: user.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", true)
        .select()
        .single();
      if (error) throw error;
      return json({ success: true, settings: data });
    }

    return json({ error: "Unsupported action" }, 400);
  } catch (error: any) {
    console.error("AFA registration error:", error);
    return json({ error: error?.message || "Internal server error" }, 500);
  }
});
