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
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

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
    const body =
      req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = String(body.action || "listUsers");

    if (action === "listUsers") {
      const page = Math.max(1, Number(body.page) || 1);
      const perPage = Math.min(1000, Math.max(1, Number(body.perPage) || 1000));
      const { data, error } = await admin.auth.admin.listUsers({
        page,
        perPage,
      });
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

    if (action === "listPackagePricing") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);
      const table = String(body.table || "package_pricing");
      if (!["package_pricing", "normal_user_package_pricing"].includes(table)) {
        return json({ error: "Unsupported pricing table" }, 400);
      }
      const { data, error } = await admin
        .from(table)
        .select("*")
        .order("network", { ascending: true });
      if (error) throw error;
      return json({ pricing: data || [] });
    }

    if (action === "savePackagePricing") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);
      const table = String(body.table || "package_pricing");
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!["package_pricing", "normal_user_package_pricing"].includes(table)) {
        return json({ error: "Unsupported pricing table" }, 400);
      }
      if (rows.length === 0) {
        return json({ error: "At least one pricing row is required" }, 400);
      }
      if (rows.length > 500) {
        return json({ error: "Too many pricing rows in one request" }, 400);
      }

      const normalizedRows = rows.map((row) => {
        const network = String(row.network || "")
          .trim()
          .toUpperCase();
        const type = String(row.type || "").trim();
        const basePrice = Number(row.base_price);
        if (!network || !type) {
          throw new Error("Network and package type are required");
        }
        if (!Number.isFinite(basePrice) || basePrice < 0) {
          throw new Error("Package base price must be zero or greater");
        }
        return {
          package_id: row.package_id ? String(row.package_id) : null,
          network,
          type,
          size: row.size ?? null,
          base_price: Number(basePrice.toFixed(2)),
          is_active: row.is_active !== false,
          created_by: row.created_by || user.id,
          updated_at: new Date().toISOString(),
        };
      });

      const { data, error } = await admin
        .from(table)
        .upsert(normalizedRows, { onConflict: "network, type" })
        .select();
      if (error) throw error;
      return json({ pricing: data || [] });
    }

    if (action === "updateSuperAgentBadge") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);
      const superAgentId = String(body.superAgentId || "").trim();
      const badge = String(body.badge || "")
        .trim()
        .toLowerCase();
      if (!["pro", "enterprise"].includes(badge)) {
        return json({ error: "Badge must be Pro or Enterprise" }, 400);
      }

      const { data: target, error: targetError } =
        await admin.auth.admin.getUserById(superAgentId);
      if (targetError || !target.user) {
        return json({ error: "Super Agent account not found" }, 404);
      }
      const targetRole = String(
        target.user.user_metadata?.role || target.user.app_metadata?.role || "",
      ).toLowerCase();
      if (!["superagent", "super_agent"].includes(targetRole)) {
        return json({ error: "Selected account is not a Super Agent" }, 400);
      }

      const { data, error } = await admin.auth.admin.updateUserById(
        superAgentId,
        {
          user_metadata: {
            ...(target.user.user_metadata || {}),
            super_agent_badge: badge,
          },
        },
      );
      if (error) throw error;
      return json({ user: data.user, badge });
    }

    if (action === "listSuperAgentWallets") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);
      const { data, error } = await admin
        .from("super_agent_wallets")
        .select("super_agent_id, balance, created_at, updated_at");
      if (error) throw error;
      return json({ wallets: data || [] });
    }

    if (action === "initializeSuperAgentWallet") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);
      const superAgentId = String(body.superAgentId || "").trim();
      if (!superAgentId) return json({ error: "Super Agent is required" }, 400);

      const { data: target, error: targetError } =
        await admin.auth.admin.getUserById(superAgentId);
      if (targetError || !target.user) {
        return json({ error: "Super Agent account not found" }, 404);
      }
      const targetRole = String(
        target.user.user_metadata?.role || target.user.app_metadata?.role || "",
      ).toLowerCase();
      if (!["superagent", "super_agent"].includes(targetRole)) {
        return json({ error: "Selected account is not a Super Agent" }, 400);
      }

      const { data: existing, error: lookupError } = await admin
        .from("super_agent_wallets")
        .select("super_agent_id, balance, created_at, updated_at")
        .eq("super_agent_id", superAgentId)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (existing) {
        return json({ wallet: existing, alreadyInitialized: true });
      }

      const { data, error } = await admin
        .from("super_agent_wallets")
        .insert({ super_agent_id: superAgentId })
        .select("super_agent_id, balance, created_at, updated_at")
        .single();
      if (error) {
        if (error.code === "23505") {
          const { data: wallet, error: raceError } = await admin
            .from("super_agent_wallets")
            .select("super_agent_id, balance, created_at, updated_at")
            .eq("super_agent_id", superAgentId)
            .single();
          if (raceError) throw raceError;
          return json({ wallet, alreadyInitialized: true });
        }
        throw error;
      }
      return json({ wallet: data, alreadyInitialized: false });
    }

    if (action === "topUpSuperAgentWallet") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);
      const superAgentId = String(body.superAgentId || "").trim();
      const amount = Number(body.amount);
      const note = String(body.note || "")
        .trim()
        .slice(0, 500);
      if (!superAgentId) return json({ error: "Super Agent is required" }, 400);
      if (!Number.isFinite(amount) || amount <= 0) {
        return json({ error: "Enter a top-up amount greater than zero" }, 400);
      }
      const roundedAmount = Number(amount.toFixed(2));
      if (roundedAmount <= 0) {
        return json({ error: "Enter a valid top-up amount" }, 400);
      }

      const { data: target, error: targetError } =
        await admin.auth.admin.getUserById(superAgentId);
      if (targetError || !target.user) {
        return json({ error: "Super Agent account not found" }, 404);
      }
      const targetRole = String(
        target.user.user_metadata?.role || target.user.app_metadata?.role || "",
      ).toLowerCase();
      if (!["superagent", "super_agent"].includes(targetRole)) {
        return json({ error: "Selected account is not a Super Agent" }, 400);
      }

      const reference = `admin-wallet-topup-${crypto.randomUUID()}`;
      const { data, error } = await admin.rpc("credit_super_agent_wallet", {
        p_super_agent_id: superAgentId,
        p_amount: roundedAmount,
        p_reference: reference,
        p_reason: "admin_wallet_topup",
        p_metadata: {
          credited_by: user.id,
          credited_by_email: user.email || null,
          note: note || null,
        },
      });
      if (error) throw error;
      return json({ result: data, reference, amount: roundedAmount });
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
        return json(
          { error: "You cannot create an account with that role" },
          403,
        );
      }
      if (isSuperAgent && ["agent", "sub_agent"].includes(targetRole)) {
        const badge = String(
          user.user_metadata?.super_agent_badge ||
            user.app_metadata?.super_agent_badge ||
            "enterprise",
        ).toLowerCase();
        if (badge !== "enterprise") {
          return json(
            {
              error: "The Pro badge does not include sub-agent creation access",
            },
            403,
          );
        }
      }
      if (
        isSuperAgent &&
        String(metadata.super_agent_id || user.id) !== user.id
      ) {
        return json(
          { error: "Agents must belong to the signed-in super agent" },
          403,
        );
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
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);
      const { data: target, error: targetError } =
        await admin.auth.admin.getUserById(userId);
      if (targetError) throw targetError;
      const targetRole = String(
        target.user?.user_metadata?.role ||
          target.user?.app_metadata?.role ||
          "",
      ).toLowerCase();
      if (["admin", "superagent", "super_agent"].includes(targetRole)) {
        return json(
          { error: "This account cannot be deleted from the current screen" },
          403,
        );
      }
      const { data, error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
      return json(data);
    }

    return json({ error: "Unsupported action" }, 400);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error";
    return json({ error: message }, 500);
  }
});
