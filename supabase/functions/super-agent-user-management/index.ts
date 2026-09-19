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
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? supabaseAnonKey;

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
    if (!isAllowedAdmin) {
      return new Response(JSON.stringify({ error: "User not allowed" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const { action, superAgentId, userData } = body;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    if (action === "listUsers") {
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
      const phone = String(userData?.phone || "").trim();
      const initialBalance = Number(userData?.initialBalance || 0);

      if (!email || !password || !fullName) {
        return new Response(
          JSON.stringify({
            error: "Email, password, and full name are required",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data: createdUser, error: createError } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          user_metadata: {
            full_name: fullName,
            phone: phone || null,
            role: "Agent",
            super_agent_id: user.id,
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
