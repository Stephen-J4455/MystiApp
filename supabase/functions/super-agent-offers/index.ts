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
    const { action, superAgentId, offer, assignment } = body;
    const targetSuperAgentId = superAgentId || user.id;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    if (action === "listOffers") {
      const { data, error } = await supabaseAdmin
        .from("super_agent_offers")
        .select("*")
        .eq("super_agent_id", targetSuperAgentId)
        .order("created_at", { ascending: false });

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(JSON.stringify({ offers: [] }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        throw error;
      }

      return new Response(JSON.stringify({ offers: data || [] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "createOffer") {
      const title = String(offer?.title || "").trim();
      const network = String(offer?.network || "").trim();
      const dataValue = String(
        offer?.data_value || offer?.dataValue || "",
      ).trim();
      const price = Number(offer?.price || 0);
      const tierName = String(
        offer?.tier_name || offer?.default_tier_name || "",
      ).trim();
      const description = String(offer?.description || "").trim();

      if (
        !title ||
        !network ||
        !dataValue ||
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return new Response(
          JSON.stringify({
            error: "Title, network, data value, and valid price are required",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const insertPayload: Record<string, unknown> = {
        super_agent_id: targetSuperAgentId,
        title,
        network,
        data_value: dataValue,
        price,
        description: description || null,
        is_active: true,
      };

      // Only attach tier columns when supplied so the function stays
      // compatible with databases that haven't run the tier migrations yet.
      if (tierName) insertPayload.tier_name = tierName;
      if (tierName) insertPayload.default_tier_name = tierName;

      const { data, error } = await supabaseAdmin
        .from("super_agent_offers")
        .insert(insertPayload)
        .select();

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_offers table is not available yet. Run the staged migration first.",
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

      return new Response(JSON.stringify({ offer: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "updateOffer") {
      const offerId = Number(offer?.id || 0);
      if (!Number.isFinite(offerId) || offerId <= 0) {
        return new Response(
          JSON.stringify({ error: "A valid offer id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const updatePayload: Record<string, unknown> = {};
      if (offer?.title !== undefined) {
        updatePayload.title = String(offer.title).trim();
      }
      if (offer?.network !== undefined) {
        updatePayload.network = String(offer.network).trim();
      }
      if (offer?.data_value !== undefined) {
        updatePayload.data_value = String(offer.data_value).trim();
      }
      if (offer?.price !== undefined) {
        const numericPrice = Number(offer.price);
        if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
          return new Response(
            JSON.stringify({ error: "Price must be greater than 0" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        updatePayload.price = numericPrice;
      }
      if (offer?.description !== undefined) {
        updatePayload.description = String(offer.description).trim() || null;
      }
      if (offer?.tier_name !== undefined) {
        updatePayload.tier_name = String(offer.tier_name).trim() || null;
      }
      if (offer?.default_tier_name !== undefined) {
        updatePayload.default_tier_name = String(offer.default_tier_name).trim() ||
          null;
      }
      if (offer?.is_active !== undefined) {
        updatePayload.is_active = Boolean(offer.is_active);
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
        .from("super_agent_offers")
        .update(updatePayload)
        .eq("id", offerId)
        .eq("super_agent_id", targetSuperAgentId)
        .select();

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_offers table is not available yet. Run the staged migration first.",
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

      return new Response(JSON.stringify({ offer: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "deleteOffer") {
      const offerId = Number(offer?.id || 0);
      if (!Number.isFinite(offerId) || offerId <= 0) {
        return new Response(
          JSON.stringify({ error: "A valid offer id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { error } = await supabaseAdmin
        .from("super_agent_offers")
        .delete()
        .eq("id", offerId)
        .eq("super_agent_id", targetSuperAgentId);

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_offers table is not available yet. Run the staged migration first.",
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

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "listAssignments") {
      const { data, error } = await supabaseAdmin
        .from("super_agent_assignments")
        .select("*")
        .eq("super_agent_id", targetSuperAgentId)
        .order("assigned_at", { ascending: false });

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(JSON.stringify({ assignments: [] }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        throw error;
      }

      return new Response(JSON.stringify({ assignments: data || [] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "createAssignment") {
      const agentId = String(assignment?.agent_id || "").trim();
      const offerId = Number(assignment?.offer_id || 0);
      const tierName = String(assignment?.tier_name || "").trim();
      const agentPrice = Number(assignment?.agent_price || 0);

      if (!agentId || !Number.isFinite(offerId) || offerId <= 0) {
        return new Response(
          JSON.stringify({ error: "Agent and offer are required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data, error } = await supabaseAdmin
        .from("super_agent_assignments")
        .insert({
          super_agent_id: targetSuperAgentId,
          agent_id: agentId,
          offer_id: offerId,
          tier_name: tierName || null,
          agent_price: Number.isFinite(agentPrice) ? agentPrice : null,
          is_active: true,
        })
        .select();

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_assignments table is not available yet. Run the staged migration first.",
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

      return new Response(JSON.stringify({ assignment: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "updateAssignment") {
      const assignmentId = Number(assignment?.id || 0);
      if (!Number.isFinite(assignmentId) || assignmentId <= 0) {
        return new Response(
          JSON.stringify({ error: "A valid assignment id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const updatePayload: Record<string, unknown> = {};
      if (assignment?.tier_name !== undefined) {
        updatePayload.tier_name = String(assignment.tier_name).trim() || null;
      }
      if (assignment?.agent_price !== undefined) {
        const numericPrice = Number(assignment.agent_price);
        if (!Number.isFinite(numericPrice) || numericPrice < 0) {
          return new Response(
            JSON.stringify({ error: "Agent price must be 0 or greater" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        updatePayload.agent_price = numericPrice;
      }
      if (assignment?.is_active !== undefined) {
        updatePayload.is_active = Boolean(assignment.is_active);
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
        .from("super_agent_assignments")
        .update(updatePayload)
        .eq("id", assignmentId)
        .eq("super_agent_id", targetSuperAgentId)
        .select();

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_assignments table is not available yet. Run the staged migration first.",
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

      return new Response(JSON.stringify({ assignment: data?.[0] || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "deleteAssignment") {
      const assignmentId = Number(assignment?.id || 0);
      if (!Number.isFinite(assignmentId) || assignmentId <= 0) {
        return new Response(
          JSON.stringify({ error: "A valid assignment id is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { error } = await supabaseAdmin
        .from("super_agent_assignments")
        .delete()
        .eq("id", assignmentId)
        .eq("super_agent_id", targetSuperAgentId);

      if (error) {
        if (isMissingDatabaseObject(error)) {
          return new Response(
            JSON.stringify({
              error:
                "The super_agent_assignments table is not available yet. Run the staged migration first.",
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
    console.error("super-agent-offers error:", error);
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
