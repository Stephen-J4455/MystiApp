import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const normalizeRole = (user: any) => {
  const role = (user?.user_metadata?.role || user?.app_metadata?.role || "")
    .toString()
    .trim();

  if (!role) return null;

  const normalized = role.toLowerCase();
  if (normalized === "admin") return "Admin";
  if (normalized === "superagent" || normalized === "super_agent")
    return "SuperAgent";
  if (normalized === "agent") return "Agent";

  return role;
};

const isMissingDatabaseObject = (error: any) => {
  const code = String(error?.code || "");
  const message = String(error?.message || "");

  return (
    code === "42P01" ||
    code === "42703" ||
    /does not exist|relation .* does not exist|column .* does not exist|missing column|missing table|relation/i.test(
      message,
    )
  );
};

// A sub-agent's tier decides which packages they can see and buy. An empty tier
// means "General only", and the name must exist for this super agent.
const resolveTierName = async (
  supabaseAdmin: any,
  superAgentId: string,
  rawTier: unknown,
): Promise<{ tierName: string | null } | { error: string }> => {
  const tierName = String(rawTier ?? "").trim();
  if (!tierName) return { tierName: null };

  const { data, error } = await supabaseAdmin
    .from("super_agent_tiers")
    .select("name")
    .eq("super_agent_id", superAgentId)
    .eq("name", tierName)
    .maybeSingle();

  if (error) {
    // Tiers table not migrated yet — keep the name without validation.
    if (isMissingDatabaseObject(error)) return { tierName };
    throw error;
  }

  if (!data) return { error: `Unknown tier: ${tierName}` };

  return { tierName };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization token" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({
          error:
            "Missing config: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for this edge function.",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser();

    if (authError || !user) {
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

    const userRole = normalizeRole(user);
    const isAllowedAdmin = userRole === "Admin" || userRole === "SuperAgent";

    const body = await req.json().catch(() => ({}));
    const { action, superAgentId, userData } = body;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // --- listUsers: only Admin or SuperAgent may list users ---
    if (action === "listUsers") {
      if (!isAllowedAdmin) {
        return new Response(
          JSON.stringify({ error: "Only admins and super-agents can list users" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { data: usersData, error: listError } =
        await supabaseAdmin.auth.admin.listUsers();

      if (listError) {
        throw listError;
      }

      const users = usersData?.users || [];
      const filteredUsers = superAgentId
        ? users.filter((member: any) => {
            const role = normalizeRole(member);
            const assignedSuperAgentId =
              member.user_metadata?.super_agent_id ||
              member.user_metadata?.superAgentId ||
              null;
            return role === "Agent" && assignedSuperAgentId === superAgentId;
          })
        : users;

      return new Response(JSON.stringify({ users: filteredUsers }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "createSubAgent") {
      if (userRole !== "SuperAgent") {
        return new Response(
          JSON.stringify({ error: "Only super agents can create sub agents" }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const email = String(userData?.email || "").trim();
      const password = String(userData?.password || "").trim();
      const fullName = String(userData?.full_name || "").trim();
      const businessName = String(userData?.business_name || "").trim();
      const phone = String(userData?.phone || "").trim();
      const initialBalance = Number(userData?.initialBalance || 0);

      if (!email || !password || !fullName || !businessName) {
        return new Response(
          JSON.stringify({
            error: "Email, password, full name, and business name are required",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // The tier decides which of this super agent's packages the sub-agent sees.
      const tierResult = await resolveTierName(
        supabaseAdmin,
        user.id,
        userData?.tier_name,
      );

      if ("error" in tierResult) {
        return new Response(JSON.stringify({ error: tierResult.error }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: createdUser, error: createError } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          user_metadata: {
            full_name: fullName,
            business_name: businessName,
            phone: phone || null,
            role: "Agent",
            super_agent_id: user.id,
            tier_name: tierResult.tierName,
          },
          email_confirm: true,
        });

      if (createError) {
        throw createError;
      }

      const { error: walletError } = await supabaseAdmin
        .from("agent_wallet")
        .insert({
          agent_id: createdUser.user.id,
          balance: Number.isFinite(initialBalance) ? initialBalance : 0,
        });

      if (walletError) {
        throw walletError;
      }

      return new Response(
        JSON.stringify({
          user: createdUser.user,
          wallet: { agent_id: createdUser.user.id },
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (action === "updateSubAgent") {
      if (userRole !== "SuperAgent") {
        return new Response(
          JSON.stringify({ error: "Only super agents can update sub agents" }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const targetAgentId = String(userData?.agent_id || "").trim();
      if (!targetAgentId) {
        return new Response(
          JSON.stringify({ error: "agent_id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const updatePayload: Record<string, unknown> = {};
      if (userData?.full_name !== undefined) {
        updatePayload.full_name = String(userData.full_name).trim();
      }
      if (userData?.business_name !== undefined) {
        updatePayload.business_name = String(userData.business_name).trim() ||
          null;
      }
      if (userData?.phone !== undefined) {
        updatePayload.phone = String(userData.phone).trim() || null;
      }
      if (userData?.tier_name !== undefined) {
        const tierResult = await resolveTierName(
          supabaseAdmin,
          user.id,
          userData.tier_name,
        );

        if ("error" in tierResult) {
          return new Response(JSON.stringify({ error: tierResult.error }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        updatePayload.tier_name = tierResult.tierName;
      }

      if (Object.keys(updatePayload).length === 0) {
        return new Response(
          JSON.stringify({ error: "No editable fields supplied" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data: existingUser, error: fetchError } =
        await supabaseAdmin.auth.admin.getUserById(targetAgentId);

      if (fetchError || !existingUser?.user) {
        return new Response(
          JSON.stringify({ error: "Sub agent not found" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const existingMeta = existingUser.user.user_metadata || {};
      if (
        String(existingMeta.super_agent_id || "") !== String(user.id)
      ) {
        return new Response(
          JSON.stringify({
            error: "Sub agent does not belong to this super agent",
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const mergedMeta = { ...existingMeta, ...updatePayload };

      const { data: updatedUser, error: updateError } =
        await supabaseAdmin.auth.admin.updateUserById(targetAgentId, {
          user_metadata: mergedMeta,
        });

      if (updateError) {
        throw updateError;
      }

      return new Response(
        JSON.stringify({ user: updatedUser?.user || null }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (action === "deactivateSubAgent") {
      if (userRole !== "SuperAgent") {
        return new Response(
          JSON.stringify({ error: "Only super agents can deactivate sub agents" }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const targetAgentId = String(userData?.agent_id || "").trim();
      if (!targetAgentId) {
        return new Response(
          JSON.stringify({ error: "agent_id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data: existingUser, error: fetchError } =
        await supabaseAdmin.auth.admin.getUserById(targetAgentId);

      if (fetchError || !existingUser?.user) {
        return new Response(
          JSON.stringify({ error: "Sub agent not found" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const existingMeta = existingUser.user.user_metadata || {};
      if (
        String(existingMeta.super_agent_id || "") !== String(user.id)
      ) {
        return new Response(
          JSON.stringify({
            error: "Sub agent does not belong to this super agent",
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const mergedMeta = {
        ...existingMeta,
        is_active: false,
        deactivated_at: new Date().toISOString(),
      };

      const { error: deactivateError } =
        await supabaseAdmin.auth.admin.updateUserById(targetAgentId, {
          user_metadata: mergedMeta,
          ban_duration: "876000h",
        });

      if (deactivateError) {
        throw deactivateError;
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "linkPaystackSubaccount") {
      if (userRole !== "SuperAgent") {
        return new Response(
          JSON.stringify({
            error: "Only super agents can link a Paystack subaccount",
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const subaccountCode = String(userData?.subaccount_code || "").trim();
      const businessName = String(userData?.business_name || "").trim();
      const settlementBank = String(userData?.settlement_bank || "").trim() ||
        null;
      const settlementBankCode = String(
        userData?.settlement_bank_code || "",
      ).trim() || null;
      const accountNumber = String(userData?.account_number || "").trim() ||
        null;
      const paystackRawResponse = userData?.paystack_raw_response || null;
      const isActive = userData?.is_active === undefined
        ? true
        : Boolean(userData.is_active);
      const percentageCharge = userData?.percentage_charge !== undefined &&
        userData?.percentage_charge !== null
        ? Number(userData.percentage_charge)
        : null;

      if (!subaccountCode) {
        return new Response(
          JSON.stringify({ error: "subaccount_code is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const upsertPayload: Record<string, unknown> = {
        super_agent_id: user.id,
        subaccount_code: subaccountCode,
        business_name: businessName || null,
        settlement_bank: settlementBank,
        settlement_bank_code: settlementBankCode,
        account_number: accountNumber,
        is_active: isActive,
        paystack_raw_response: paystackRawResponse,
        updated_at: new Date().toISOString(),
      };

      if (
        percentageCharge !== null &&
        Number.isFinite(percentageCharge) &&
        percentageCharge >= 0
      ) {
        upsertPayload.percentage_charge = percentageCharge;
      }

      const { data, error } = await supabaseAdmin
        .from("super_agent_paystack")
        .upsert(upsertPayload, { onConflict: "super_agent_id" })
        .select();

      if (error) {
        if (
          error.code === "42P01" ||
          /does not exist|relation .* does not exist/i.test(error.message || "")
        ) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_paystack table is not available yet. Run the latest migration first.",
              migration_required: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        throw error;
      }

      return new Response(JSON.stringify({ subaccount: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "getPaystackSubaccount") {
      // Allow SuperAgents to get their own sub-account, OR
      // Allow Sub-Agents to get their assigned SuperAgent's sub-account.
      const targetSuperAgentId = user.user_metadata?.super_agent_id || null;
      const effectiveAgentId = userRole === "SuperAgent" ? user.id : targetSuperAgentId;

      if (!effectiveAgentId) {
        return new Response(
          JSON.stringify({ error: "No super_agent_id found in user metadata" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (userRole !== "SuperAgent") {
        const isMember = superAgentId
          ? String(superAgentId) === String(user.id)
          : true;
        if (!isMember && !targetSuperAgentId) {
          return new Response(
            JSON.stringify({ error: "Must be a super-agent or have a super_agent_id assigned" }),
            {
              status: 403,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
      }

      const { data, error } = await supabaseAdmin
        .from("super_agent_paystack")
        .select("*")
        .eq("super_agent_id", effectiveAgentId)
        .maybeSingle();

      if (error) {
        if (
          error.code === "42P01" ||
          /does not exist|relation .* does not exist/i.test(error.message || "")
        ) {
          return new Response(JSON.stringify({ subaccount: null }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw error;
      }

      return new Response(JSON.stringify({ subaccount: data || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unsupported action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("super-agent-user-management error:", error);
    return new Response(
      JSON.stringify({
        error: error?.message || "Internal server error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
