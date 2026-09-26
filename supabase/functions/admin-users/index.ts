import { createClient } from "npm:@supabase/supabase-js@2";

type AuthUser = {
  id: string;
  email?: string;
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

// Audiences that have their own independently configured API cost discounts.
// Keep in sync with the CHECK constraint on public.api_cost_settings.audience.
const API_COST_AUDIENCES = ["super_agent", "normal_user"];

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

    if (action === "updateUserDetails") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);

      const targetUserId = String(body.userId || "").trim();
      if (!targetUserId) return json({ error: "User is required" }, 400);

      const { data: target, error: targetError } =
        await admin.auth.admin.getUserById(targetUserId);
      if (targetError || !target.user) {
        return json({ error: "Account not found" }, 404);
      }

      // Merge onto the existing metadata so fields this screen does not own
      // (role, badge, tier assignments) are left untouched.
      const currentMetadata = { ...(target.user.user_metadata || {}) };
      const nextMetadata: Record<string, unknown> = { ...currentMetadata };

      const has = (key: string) =>
        Object.prototype.hasOwnProperty.call(body, key);

      if (has("fullName")) {
        const fullName = String(body.fullName || "").trim();
        if (fullName) nextMetadata.full_name = fullName;
        else delete nextMetadata.full_name;
      }

      if (has("businessName")) {
        const businessName = String(body.businessName || "").trim();
        if (businessName) nextMetadata.business_name = businessName;
        else delete nextMetadata.business_name;
      }

      if (has("phone")) {
        const phone = String(body.phone || "").trim();
        if (phone) {
          // Mirror the Ghana number check the customer app enforces so an
          // admin cannot save a number the user would be unable to buy with.
          const cleanPhone = phone.replace(/[\s\-()]/g, "");
          if (!/^(\+?233|0)?[2356789]\d{8}$/.test(cleanPhone)) {
            return json(
              {
                error:
                  "Enter a valid Ghana phone number (e.g. 0532973455 or +233532973455).",
              },
              400,
            );
          }
          nextMetadata.phone = phone;
        } else {
          delete nextMetadata.phone;
        }
      }

      // Note which admin made the change, without persisting an account
      // password or taking over the user's own credentials.
      nextMetadata.updated_by_admin = {
        admin_id: user.id,
        admin_email: user.email || null,
        at: new Date().toISOString(),
      };

      const { data: updated, error: updateError } =
        await admin.auth.admin.updateUserById(targetUserId, {
          user_metadata: nextMetadata,
        });
      if (updateError) throw updateError;

      // Keep the denormalized profile row in step where it exists.
      const { error: profileError } = await admin.from("user_profiles").upsert(
        {
          id: targetUserId,
          full_name: String(nextMetadata.full_name || "") || null,
          business_name: String(nextMetadata.business_name || "") || null,
          phone: String(nextMetadata.phone || "") || null,
          email: updated.user.email || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
      if (profileError) {
        console.warn(
          "[updateUserDetails] user_profiles not updated:",
          profileError.message,
        );
      }

      return json({ user: updated.user });
    }

    if (action === "setUserRole") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);

      const targetUserId = String(body.userId || "").trim();
      if (!targetUserId) return json({ error: "User is required" }, 400);
      if (targetUserId === user.id) {
        return json({ error: "You cannot change your own role" }, 400);
      }

      // The four assignable states. "normal_user" is represented by removing
      // the role entirely, which is how the app has always treated a user with
      // no role metadata.
      const requestedRole = String(body.role || "")
        .trim()
        .toLowerCase();
      const allowedRoles = ["normal_user", "sub_agent", "super_agent"];
      if (!allowedRoles.includes(requestedRole)) {
        return json(
          {
            error:
              "Role must be normal_user, sub_agent or super_agent. Administrator accounts cannot be assigned here.",
          },
          400,
        );
      }

      // Pro and Enterprise are Super Agent badges, not separate roles.
      const badge = String(body.badge || "")
        .trim()
        .toLowerCase();
      if (
        requestedRole === "super_agent" &&
        !["pro", "enterprise"].includes(badge)
      ) {
        return json({ error: "Badge must be Pro or Enterprise" }, 400);
      }

      const superAgentId = String(body.superAgentId || "").trim();

      const { data: target, error: targetError } =
        await admin.auth.admin.getUserById(targetUserId);
      if (targetError || !target.user) {
        return json({ error: "Account not found" }, 404);
      }

      const currentRole = String(
        target.user.user_metadata?.role || target.user.app_metadata?.role || "",
      ).toLowerCase();
      if (currentRole === "admin" || requestedRole === "admin") {
        return json(
          { error: "Administrator roles cannot be changed from this screen" },
          403,
        );
      }

      // A sub-agent buys offers from a Super Agent, so it must be attached to
      // one. Resolve and validate the target Super Agent before writing.
      let resolvedSuperAgentId: string | null = null;
      if (requestedRole === "sub_agent") {
        if (!superAgentId) {
          return json(
            { error: "Select a Super Agent to assign this agent to" },
            400,
          );
        }
        const { data: owner, error: ownerError } =
          await admin.auth.admin.getUserById(superAgentId);
        if (ownerError || !owner.user) {
          return json({ error: "Selected Super Agent was not found" }, 404);
        }
        const ownerRole = String(
          owner.user.user_metadata?.role || owner.user.app_metadata?.role || "",
        ).toLowerCase();
        if (ownerRole !== "superagent" && ownerRole !== "super_agent") {
          return json(
            { error: "Agents can only be assigned to a Super Agent" },
            400,
          );
        }
        if (superAgentId === targetUserId) {
          return json(
            { error: "A Super Agent cannot be assigned to itself" },
            400,
          );
        }
        resolvedSuperAgentId = superAgentId;
      }

      // Build the next metadata from the existing user so unrelated metadata
      // (phone, full_name, tier assignments) is preserved.
      const currentMetadata = { ...(target.user.user_metadata || {}) };
      const nextMetadata: Record<string, unknown> = { ...currentMetadata };

      if (requestedRole === "normal_user") {
        // Clearing every role alias leaves a normal user, which the app reads
        // as "no role". Stale badge / assignment keys would keep granting
        // Super Agent behaviour, so remove them too.
        delete nextMetadata.role;
        delete nextMetadata.super_agent_badge;
        delete nextMetadata.super_agent_id;
        delete nextMetadata.superAgentId;
      } else if (requestedRole === "sub_agent") {
        nextMetadata.role = "sub_agent";
        nextMetadata.super_agent_id = resolvedSuperAgentId;
        delete nextMetadata.superAgentId;
        // An Agent is not a Super Agent, so drop any badge.
        delete nextMetadata.super_agent_badge;
      } else {
        nextMetadata.role = "super_agent";
        nextMetadata.super_agent_badge = badge;
        // A Super Agent answers to the platform, not to another one.
        delete nextMetadata.super_agent_id;
        delete nextMetadata.superAgentId;
      }

      const { data: updated, error: updateError } =
        await admin.auth.admin.updateUserById(targetUserId, {
          user_metadata: nextMetadata,
        });
      if (updateError) throw updateError;

      // Mirror the role into user_profiles so reporting queries do not drift
      // away from the auth record. A missing profile row is not fatal.
      const profileRole =
        requestedRole === "normal_user"
          ? "normal_user"
          : requestedRole === "sub_agent"
            ? "sub_agent"
            : "super_agent";
      const { error: profileError } = await admin.from("user_profiles").upsert(
        {
          id: targetUserId,
          role: profileRole,
          super_agent_id: resolvedSuperAgentId,
          email: updated.user.email || null,
          full_name:
            String(nextMetadata.full_name || nextMetadata.name || "") || null,
          business_name: String(nextMetadata.business_name || "") || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
      if (profileError) {
        console.warn(
          "[setUserRole] user_profiles not updated:",
          profileError.message,
        );
      }

      return json({
        user: updated.user,
        role: requestedRole,
        badge: requestedRole === "super_agent" ? badge : null,
        superAgentId: resolvedSuperAgentId,
        previousRole: currentRole || "normal_user",
      });
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

    if (action === "listApiCostSettings") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);
      const audience = String(body.audience || "super_agent").trim();
      if (!API_COST_AUDIENCES.includes(audience)) {
        return json({ error: "Unsupported audience" }, 400);
      }
      const { data, error } = await admin
        .from("api_cost_settings")
        .select("*")
        .eq("audience", audience)
        .order("network", { ascending: true });
      if (error) throw error;
      return json({ settings: data || [] });
    }

    if (action === "saveApiCostSettings") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);
      const audience = String(body.audience || "super_agent").trim();
      if (!API_COST_AUDIENCES.includes(audience)) {
        return json({ error: "Unsupported audience" }, 400);
      }
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (rows.length === 0) {
        return json({ error: "At least one discount row is required" }, 400);
      }
      if (rows.length > 500) {
        return json({ error: "Too many discount rows in one request" }, 400);
      }

      const normalizedRows = rows.map((row) => {
        const network = String(row.network || "")
          .trim()
          .toUpperCase();
        const type = String(row.type || "").trim();
        const discount = Number(row.discount ?? 0);
        if (!network || !type) {
          throw new Error("Network and package type are required");
        }
        if (!Number.isFinite(discount) || discount < 0) {
          throw new Error("API cost discount must be zero or greater");
        }
        return {
          audience,
          package_id: row.package_id ? String(row.package_id) : null,
          network,
          type,
          // A discount of 0 is stored as inactive so it does not show up as a
          // live discount in the admin UI, but is otherwise a normal row.
          discount: Number(discount.toFixed(2)),
          notes: String(row.notes || "").trim() || null,
          is_active: discount > 0 && row.is_active !== false,
          created_by: user.id,
          updated_at: new Date().toISOString(),
        };
      });

      const { data, error } = await admin
        .from("api_cost_settings")
        .upsert(normalizedRows, { onConflict: "audience,network,type" })
        .select();
      if (error) throw error;
      return json({ settings: data || [] });
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

    if (action === "listWalletActivity") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);

      const limit = Math.min(200, Math.max(1, Number(body.limit) || 100));

      // Internal wallet movements (admin top-ups, order debits, refunds) and
      // Paystack-funded top-ups are stored in different tables, so merge them
      // into one chronological feed for the admin wallet screen.
      const [ledgerResult, topupResult, walletResult] = await Promise.all([
        admin
          .from("super_agent_wallet_ledger")
          .select(
            "id, super_agent_id, amount, balance_before, balance_after, entry_type, reason, reference, order_id, metadata, created_at",
          )
          .order("created_at", { ascending: false })
          .limit(limit),
        admin
          .from("wallet_topups")
          .select(
            "id, agent_id, amount, reference, status, channel, bank, paystack_transaction_id, paid_at, created_at",
          )
          .order("created_at", { ascending: false })
          .limit(limit),
        admin
          .from("super_agent_wallets")
          .select("super_agent_id, balance, updated_at"),
      ]);

      if (ledgerResult.error) throw ledgerResult.error;
      if (topupResult.error) throw topupResult.error;
      if (walletResult.error) throw walletResult.error;

      const ledgerRows = (ledgerResult.data || []).map((row) => ({
        id: `ledger-${row.id}`,
        source: "wallet_ledger" as const,
        holderId: row.super_agent_id,
        amount: Number(row.amount || 0),
        balanceBefore: Number(row.balance_before || 0),
        balanceAfter: Number(row.balance_after || 0),
        entryType: row.entry_type,
        reason: row.reason,
        reference: row.reference,
        orderId: row.order_id ?? null,
        metadata: { ...(row.metadata || {}), status: "success" },
        createdAt: row.created_at,
      }));

      // A settled Paystack top-up writes a wallet_topups row *and* a matching
      // super_agent_wallet_ledger credit. The ledger row is authoritative
      // (it carries the running balance), so each top-up is folded into its
      // ledger entry and the raw row is only used when no ledger credit was
      // found - otherwise every top-up would be counted twice.
      const ledgerRowsByTopup = new Map<string, (typeof ledgerRows)[number]>();
      const walletTopupCredits = ledgerRows.filter(
        (row) => row.reason === "wallet_topup",
      );
      for (const topup of walletTopupCredits) {
        const topupId = topup.metadata?.topup_id;
        if (topupId !== undefined && topupId !== null) {
          ledgerRowsByTopup.set(String(topupId), topup);
        }
      }

      const topupEntries = (topupResult.data || [])
        .map((row) => ({
          id: `topup-${row.id}`,
          source: "wallet_topup" as const,
          holderId: row.agent_id,
          amount: Number(row.amount || 0),
          balanceBefore: null,
          balanceAfter: null,
          entryType: "credit" as const,
          reason: "wallet_topup",
          reference: row.reference,
          orderId: null,
          metadata: {
            status: row.status,
            channel: row.channel,
            bank: row.bank,
            paystack_transaction_id: row.paystack_transaction_id,
            paid_at: row.paid_at,
          },
          createdAt: row.paid_at || row.created_at,
        }))
        .map((entry) => {
          const match = ledgerRowsByTopup.get(entry.id.replace("topup-", ""));
          if (!match) return entry;
          // Carry the Paystack detail onto the ledger entry, keeping the
          // ledger's balances, then drop the duplicate.
          match.metadata = { ...match.metadata, ...entry.metadata };
          return null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      const entries = [...ledgerRows, ...topupEntries].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      // Resolve the wallet holder's display name so the ledger can show whose
      // wallet moved. The auth user list is fetched once and indexed rather
      // than calling getUserById per row, which kept the request fast and
      // avoided a partial failure taking the whole feed down. user_profiles
      // is only consulted for holders with no auth name.
      const holderIds = Array.from(
        new Set(entries.map((entry) => entry.holderId).filter(Boolean)),
      );
      const holderDirectory: Record<
        string,
        { name: string; email: string; role: string }
      > = {};

      try {
        const authUsers: AuthUser[] = [];
        let page = 1;
        let hasMore = true;

        while (hasMore && page <= 20) {
          const { data, error: listError } = await admin.auth.admin.listUsers({
            page,
            perPage: 1000,
          });
          if (listError) throw listError;
          const batch = (data?.users || []) as AuthUser[];
          authUsers.push(...batch);
          hasMore = Boolean(data?.lastPage) && page < Number(data?.lastPage);
          page += 1;
        }

        for (const authUser of authUsers) {
          if (!authUser?.id) continue;
          const metadata = authUser.user_metadata || {};
          holderDirectory[authUser.id] = {
            name: String(
              metadata.full_name ||
                metadata.name ||
                metadata.business_name ||
                "",
            ).trim(),
            email: String(authUser.email || "").trim(),
            role: String(metadata.role || authUser.app_metadata?.role || "")
              .trim()
              .toLowerCase(),
          };
        }
      } catch (listError) {
        console.error("Could not list wallet holders:", listError);
      }

      // Fall back to user_profiles for any holder still missing a name.
      const unresolved = holderIds.filter(
        (holderId) => !holderDirectory[holderId]?.name,
      );
      if (unresolved.length > 0) {
        const { data: profiles } = await admin
          .from("user_profiles")
          .select("id, full_name, business_name, email, role")
          .in("id", unresolved);

        for (const profile of profiles || []) {
          const existing = holderDirectory[profile.id] || {
            name: "",
            email: "",
            role: "",
          };
          existing.name = String(
            profile.full_name || profile.business_name || existing.name || "",
          ).trim();
          existing.email = existing.email || String(profile.email || "").trim();
          existing.role =
            existing.role ||
            String(profile.role || "")
              .trim()
              .toLowerCase();
          holderDirectory[profile.id] = existing;
        }
      }

      return json({
        entries: entries.slice(0, limit).map((entry) => {
          const holder = holderDirectory[entry.holderId] || {
            name: "",
            email: "",
            role: "",
          };
          return {
            ...entry,
            holderName: holder.name || holder.email || "Unknown wallet holder",
            holderEmail: holder.email || null,
            holderRole: holder.role || null,
          };
        }),
        balances: walletResult.data || [],
      });
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

    if (action === "debitSuperAgentWallet") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);
      const superAgentId = String(body.superAgentId || "").trim();
      const amount = Number(body.amount);
      const note = String(body.note || "")
        .trim()
        .slice(0, 500);
      if (!superAgentId) return json({ error: "Super Agent is required" }, 400);
      if (!Number.isFinite(amount) || amount <= 0) {
        return json({ error: "Enter a debit amount greater than zero" }, 400);
      }
      const roundedAmount = Number(amount.toFixed(2));
      if (roundedAmount <= 0) {
        return json({ error: "Enter a valid debit amount" }, 400);
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

      // Read the balance up front so the admin gets a precise error instead of
      // the generic "failed to debit" when the wallet cannot cover the amount.
      const { data: wallet, error: walletError } = await admin
        .from("super_agent_wallets")
        .select("balance")
        .eq("super_agent_id", superAgentId)
        .maybeSingle();
      if (walletError) throw walletError;

      if (!wallet) {
        return json(
          {
            error:
              "This Super Agent does not have a wallet yet. Initialize it before debiting.",
          },
          400,
        );
      }

      const currentBalance = Number(wallet.balance || 0);
      if (currentBalance < roundedAmount) {
        return json(
          {
            error: "Insufficient wallet balance for this debit",
            balance: currentBalance,
            required: roundedAmount,
          },
          400,
        );
      }

      const reference = `admin-wallet-debit-${crypto.randomUUID()}`;
      const { data, error } = await admin.rpc(
        "admin_debit_super_agent_wallet",
        {
          p_super_agent_id: superAgentId,
          p_amount: roundedAmount,
          p_reference: reference,
          p_reason: "admin_wallet_debit",
          p_metadata: {
            debited_by: user.id,
            debited_by_email: user.email || null,
            note: note || null,
          },
        },
      );
      if (error) throw error;
      if (data && data.success === false) {
        return json(
          {
            error: "Insufficient wallet balance for this debit",
            balance: Number(data.balance || currentBalance),
            required: Number(data.required || roundedAmount),
          },
          400,
        );
      }
      return json({ result: data, reference, amount: roundedAmount });
    }

    if (action === "listDeferredOrders") {
      if (!isAdmin)
        return json({ error: "Administrator access required" }, 403);
      const limit = Math.min(200, Math.max(1, Number(body.limit) || 100));

      // Orders that were paid for but never handed to the provider because
      // the Jehuca account had insufficient balance.
      const [regularResult, agentResult] = await Promise.all([
        admin
          .from("orders")
          .select(
            "id, user_id, user_name, user_email, phone, offer_title, data_amount, amount, base_amount, network, status, payment_reference, provider_package_id, provider_deferred_at, provider_deferred_reason, provider_dispatch_attempts, created_at",
          )
          .is("jehuca_order_id", null)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(limit),
        admin
          .from("agent_orders")
          .select(
            "id, agent_id, recipient_name, recipient_phone, offer_title, amount, base_amount, network, status, payment_reference, provider_package_id, provider_deferred_at, provider_deferred_reason, provider_dispatch_attempts, created_at",
          )
          .is("jehuca_order_id", null)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(limit),
      ]);

      if (regularResult.error) throw regularResult.error;
      if (agentResult.error) throw agentResult.error;

      const orders = [
        ...(regularResult.data || []).map((row: any) => ({
          ...row,
          orderType: "regular",
        })),
        ...(agentResult.data || []).map((row: any) => ({
          ...row,
          orderType: "agent",
        })),
      ].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );

      return json({ orders: orders.slice(0, limit) });
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
