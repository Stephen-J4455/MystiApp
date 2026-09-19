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
    if (userRole !== "SuperAgent") {
      return new Response(JSON.stringify({ error: "User not allowed" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const { action, superAgentId, tier } = body;
    const targetSuperAgentId = superAgentId || user.id;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    if (action === "listTiers") {
      const { data, error } = await supabaseAdmin
        .from("super_agent_tiers")
        .select("*")
        .eq("super_agent_id", targetSuperAgentId)
        .order("created_at", { ascending: false });

      if (error) {
        const message = error?.message || "";
        const isMissingTable =
          error.code === "42P01" ||
          /does not exist|relation .* does not exist|relation/i.test(message);

        if (isMissingTable) {
          return new Response(JSON.stringify({ tiers: [] }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        throw error;
      }

      return new Response(JSON.stringify({ tiers: data || [] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "createTier") {
      const normalizedTierName = String(tier?.name || "").trim();
      const normalizedTierDescription = String(tier?.description || "").trim();

      if (!normalizedTierName) {
        return new Response(
          JSON.stringify({ error: "Tier name is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data, error } = await supabaseAdmin
        .from("super_agent_tiers")
        .insert({
          super_agent_id: targetSuperAgentId,
          name: normalizedTierName,
          description: normalizedTierDescription || null,
        })
        .select();

      if (error) {
        const message = error?.message || "";
        const isMissingTable =
          error.code === "42P01" ||
          /does not exist|relation .* does not exist|relation/i.test(message);

        if (isMissingTable) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_tiers table is not available yet. Run the staged migration first.",
            }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        if (error.code === "23505") {
          return new Response(
            JSON.stringify({ error: "A tier with this name already exists" }),
            {
              status: 409,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        throw error;
      }

      return new Response(JSON.stringify({ tier: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "updateTier") {
      const tierId = Number(tier?.id || 0);
      if (!Number.isFinite(tierId) || tierId <= 0) {
        return new Response(
          JSON.stringify({ error: "A valid tier id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const updatePayload: Record<string, unknown> = {};
      if (tier?.name !== undefined) {
        const newName = String(tier.name).trim();
        if (!newName) {
          return new Response(
            JSON.stringify({ error: "Tier name cannot be empty" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        updatePayload.name = newName;
      }
      if (tier?.description !== undefined) {
        updatePayload.description = String(tier.description).trim() || null;
      }
      if (tier?.is_active !== undefined) {
        updatePayload.is_active = Boolean(tier.is_active);
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

      const { data, error } = await supabaseAdmin
        .from("super_agent_tiers")
        .update(updatePayload)
        .eq("id", tierId)
        .eq("super_agent_id", targetSuperAgentId)
        .select();

      if (error) {
        const message = error?.message || "";
        const isMissingTable =
          error.code === "42P01" ||
          /does not exist|relation .* does not exist|relation/i.test(message);

        if (isMissingTable) {
          return new Response(JSON.stringify({ tiers: [] }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw error;
      }

      return new Response(JSON.stringify({ tier: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "deleteTier") {
      const tierId = Number(tier?.id || 0);
      if (!Number.isFinite(tierId) || tierId <= 0) {
        return new Response(
          JSON.stringify({ error: "A valid tier id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { error } = await supabaseAdmin
        .from("super_agent_tiers")
        .delete()
        .eq("id", tierId)
        .eq("super_agent_id", targetSuperAgentId);

      if (error) {
        const message = error?.message || "";
        const isMissingTable =
          error.code === "42P01" ||
          /does not exist|relation .* does not exist|relation/i.test(message);

        if (isMissingTable) {
          return new Response(JSON.stringify({ tiers: [] }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw error;
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unsupported action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("super-agent-tier-management error:", error);
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
