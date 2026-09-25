import { createClient } from "npm:@supabase/supabase-js@2";

type AuthUser = {
  id: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
};

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization token" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return json({ error: "Supabase service configuration is missing" }, 500);
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const role = String(
      user.user_metadata?.role || user.app_metadata?.role || "",
    ).toLowerCase();
    const isAdmin = role === "admin";
    const isSuperAgent = role === "superagent" || role === "super_agent";
    if (!isAdmin && !isSuperAgent) {
      return json({ error: "Administrator access required" }, 403);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = String(body.action || "listUsers");

    if (action === "listUsers") {
      const page = Math.max(1, Number(body.page) || 1);
      const perPage = Math.min(1000, Math.max(1, Number(body.perPage) || 1000));
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const users = isAdmin
        ? data.users
        : data.users.filter((member: AuthUser) => {
            const memberRole = String(
              member.user_metadata?.role || member.app_metadata?.role || "",
            ).toLowerCase();
            const assignedId =
              member.user_metadata?.super_agent_id ||
              member.user_metadata?.superAgentId ||
              member.app_metadata?.super_agent_id ||
              member.app_metadata?.superAgentId;
            return memberRole === "agent" || memberRole === "sub_agent"
              ? String(assignedId) === user.id
              : false;
          });
      return json({ ...data, users });
    }

    if (action === "createUser") {
      const userData = body.userData || {};
      const metadata = userData.user_metadata || {};
      const targetRole = String(metadata.role || "").toLowerCase();
      const allowedTarget = isAdmin
        ? ["admin", "superagent", "super_agent", "agent", "sub_agent"].includes(
            targetRole,
          )
        : ["agent", "sub_agent"].includes(targetRole);
      if (!allowedTarget) {
        return json({ error: "You cannot create an account with that role" }, 403);
      }
      if (
        isSuperAgent &&
        String(metadata.super_agent_id || user.id) !== user.id
      ) {
        return json({ error: "Agents must belong to the signed-in super agent" }, 403);
      }
      const { data, error } = await admin.auth.admin.createUser({
        email: String(userData.email || "").trim(),
        password: String(userData.password || ""),
        user_metadata: metadata,
        email_confirm: userData.email_confirm !== false,
      });
      if (error) throw error;
      return json(data);
    }

    if (action === "deleteUser") {
      const userId = String(body.userId || "").trim();
      if (!userId || userId === user.id) {
        return json({ error: "A different account must be selected" }, 400);
      }
      if (!isAdmin) return json({ error: "Administrator access required" }, 403);
      const { data: target, error: targetError } =
        await admin.auth.admin.getUserById(userId);
      if (targetError) throw targetError;
      const targetRole = String(
        target.user?.user_metadata?.role || target.user?.app_metadata?.role || "",
      ).toLowerCase();
      if (["admin", "superagent", "super_agent"].includes(targetRole)) {
        return json({ error: "This account cannot be deleted from the current screen" }, 403);
      }
      const { data, error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
      return json(data);
    }

    return json({ error: "Unsupported action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    return json({ error: message }, 500);
  }
});

