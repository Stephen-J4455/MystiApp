import { createClient } from "npm:@supabase/supabase-js@2";
type CanonicalRole = "admin" | "super_agent" | "sub_agent" | "normal_user";

interface Identity {
  id: string;
  role: CanonicalRole;
  superAgentId: string | null;
  email: string | null;
  /** True when the profile row was missing and the default was assumed. */
  profileMissing: boolean;
  /** Present only for display/audit. Never authorize on this. */
  displayName: string | null;
}

interface SupabaseClients {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  /** Client bound to the caller's token, used only for auth.getUser(). */
  authClient: ReturnType<typeof createClient>;
  /** Service-role client. Bypasses RLS - use for trusted reads/writes only. */
  admin: ReturnType<typeof createClient>;
}

/**
 * Canonical role vocabulary.
 *
 * The codebase historically mixed `admin`, `Admin`, `superagent`,
 * `super_agent`, `agent` and `sub_agent`, and compared them with `===` against
 * variously-cased values. That produced live authorization bugs in BOTH
 * directions. Everything funnels through here so there is exactly one spelling
 * to reason about.
 *
 * `normal_user` is a member in its own right, NOT an alias of `sub_agent`. It
 * previously WAS collapsed onto `sub_agent` here, which made every
 * `role === "sub_agent"` check unconditionally true for ordinary customers
 * and mis-routed their orders into `agent_orders`. Keep the two distinct.
 */
const normalizeRole = (value: unknown): CanonicalRole | null => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  switch (normalized) {
    case "admin":
    case "administrator":
    case "superadmin":
    case "super_admin":
      return "admin";
    case "superagent":
    case "super_agent":
      return "super_agent";
    case "agent":
    case "subagent":
    case "sub_agent":
      return "sub_agent";
    case "user":
    case "normal_user":
    case "normaluser":
      return "normal_user";
    default:
      return null;
  }
};

const identityIsAdmin = (identity: Identity) => identity.role === "admin";
const identityIsSuperAgent = (identity: Identity) =>
  identity.role === "super_agent";

/**
 * Creates the anon/auth clients. Kept separate from `resolveIdentity` so a
 * function can fail fast on missing configuration with its own error shape.
 */
const getSupabaseClients = (authorizationHeader: string): SupabaseClients => {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? anonKey;

  return {
    url,
    anonKey,
    serviceRoleKey,
    authClient: createClient(url, anonKey, {
      global: { headers: { Authorization: authorizationHeader } },
    }),
    admin: createClient(url, serviceRoleKey),
  };
};

/**
 * Resolves the caller's identity from the token, then overrides role and
 * ownership from `public.user_profiles`.
 *
 * WHY NOT user_metadata: that field is WRITABLE BY THE USER THEMSELVES via
 * `supabase.auth.updateUser({ data: { role: 'admin' }})`, which persisted the
 * value into `raw_user_meta_data`. Every function used to read role as
 * `user_metadata.role || app_metadata.role`, so the FIRST term was
 * attacker-controlled - self-service privilege escalation. `app_metadata` is
 * service-role-only and safe.
 *
 * Throws only when the token itself is invalid - which callers should turn into
 * a 401. A missing profile row is NOT an error; it resolves to `sub_agent` and
 * sets `profileMissing` so the caller can log the drift.
 */
const resolveIdentity = async (clients: SupabaseClients): Promise<Identity> => {
  const {
    data: { user },
    error,
  } = await clients.authClient.auth.getUser();

  if (error || !user) {
    throw new Error(error?.message || "Not authenticated");
  }

  const email = user.email ?? null;

  // Authoritative read. Uses the service-role client so the caller's own RLS
  // visibility cannot hide their own role from an authorization check.
  const { data: profile } = await clients.admin
    .from("user_profiles")
    .select("id, role, super_agent_id, full_name")
    .eq("id", user.id)
    .maybeSingle();

  const profileMissing = !profile;

  // Fail closed. `sub_agent` is the trigger's default and the least privileged
  // role, so an unknown user can only ever act on themselves.
  //
  // A NULL IN AN EXISTING PROFILE IS AN ANSWER, NOT A GAP
  // ---------------------------------------------------
  // `app_metadata` is consulted ONLY when there is NO profile row at all.
  //
  // The previous chain used `??` on `profile?.role`, which conflates "the
  // profile does not exist" with "the profile exists and this value is NULL".
  // Those are different facts, and conflating them is what let a demoted
  // account keep its old identity:
  //
  //   admin demotes Enterprise Super Agent -> Sub Agent, assigning no owner
  //   (a legitimate state - migration 20260928_003 exists precisely because an
  //   admin can set a role without picking an owner).
  //
  //   `user_profiles.super_agent_id` is then NULL. `??` read that as "no value,
  //   try the next source" and fell through to `app_metadata.super_agent_id`,
  //   which `admin-users.setUserRole` never clears - so it still held the id
  //   from before the promotion.
  //
  //   The purchase was then debited against the WRONG super agent's wallet and
  //   the buyer resolved as a Super Agent rather than the Sub Agent they are.
  //
  // A NULL in a row that EXISTS is authoritative and is honoured. The metadata
  // fallback is reserved for a genuinely absent row, where `profileMissing` is
  // already flagged for the console warning below.
  const role = profile
    ? (normalizeRole(profile.role) ?? "sub_agent")
    : (normalizeRole(user.app_metadata?.role) ?? "sub_agent");

  // Ownership comes from the profile, and the same rule applies.
  // `user_metadata.super_agent_id` is user-writable, so reading it would let a
  // sub-agent re-point themselves at another super agent and have their
  // purchase debited from that wallet.
  //
  // An ownerless sub agent resolving to null is CORRECT, and it is what callers
  // act on: `verify-payment`'s wallet branch returns 403 "You are not assigned
  // to a Super Agent" rather than spending from a stale owner's wallet.
  const superAgentId = profile
    ? ((profile.super_agent_id as string | null | undefined) ?? null)
    : typeof user.app_metadata?.super_agent_id === "string"
      ? user.app_metadata.super_agent_id
      : null;

  return {
    id: user.id,
    role,
    superAgentId,
    email,
    profileMissing,
    displayName:
      (profile?.full_name as string | null | undefined) ??
      user.user_metadata?.full_name ??
      null,
  };
};

/**
 * An order belongs to the caller when it is one of theirs. Admins bypass this.
 * Preserved verbatim from `dispatch-order`'s existing rule so this helper
 * changes only the SOURCE of role/ownership, not the semantics.
 */
const ownsResource = (
  identity: Identity,
  ownerId: string | null | undefined,
): boolean =>
  identityIsAdmin(identity) || (ownerId != null && ownerId === identity.id);

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

    // Declared before the identity resolution below because the authoritative
    // profile read goes through the service-role client, not the caller's
    // RLS-scoped one.
    const admin = createClient(supabaseUrl, serviceRoleKey);

    // This function is the most privileged in the codebase - it assigns roles,
    // moves wallets and reads every account. Its own gate therefore read
    // `user_metadata.role` first, which the caller can rewrite with
    // `supabase.auth.updateUser`. Any authenticated user could have declared
    // themselves an admin and reached every branch below.
    let identity;
    try {
      identity = await resolveIdentity({
        url: supabaseUrl,
        anonKey: supabaseAnonKey,
        serviceRoleKey,
        authClient,
        admin,
      });
    } catch {
      return json({ error: "Unauthorized" }, 401);
    }
    if (identity.profileMissing) {
      console.warn(
        "[admin-users] No user_profiles row; defaulted to sub_agent:",
        identity.id,
      );
    }
    const isAdmin = identityIsAdmin(identity);
    const isSuperAgent = identityIsSuperAgent(identity);
    if (!isAdmin && !isSuperAgent) {
      return json({ error: "Administrator access required" }, 403);
    }

    // The remaining branches below only need the caller's own id and email
    // (for audit columns and self-action guards), both of which are
    // token-derived and not spoofable. Aliasing keeps those call sites
    // unchanged while `identity` carries the AUTHORIZATION data.
    const user = { id: identity.id, email: identity.email } as {
      id: string;
      email?: string | null;
    };

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

      // Read the AUTHORITATIVE role/ownership for the returned page.
      //
      // `listUsers` returns `auth.users` only, so the role the admin app
      // renders comes from that row's user-writable `user_metadata` /
      // `app_metadata`. Every edge function instead reads `user_profiles`, so
      // the two can disagree - and when they do, the admin app shows a role
      // that does not match the permissions the target actually has. This is
      // the same "role swap did nothing" class of bug
      // (role-swap-three-write-targets.md), seen from the admin's side.
      //
      // The profile is returned alongside rather than merged INTO the user
      // object, so the client keeps one obvious authority per field and no
      // existing `user.user_metadata` read silently changes meaning.
      const pageIds = (data.users || []).map((member) => String(member.id));
      const { data: profileRows, error: profileError } = pageIds.length
        ? await admin
            .from("user_profiles")
            .select("id, role, super_agent_id")
            .in("id", pageIds)
        : { data: [], error: null };
      if (profileError) {
        // Non-fatal: the list is still useful from auth metadata alone, and
        // failing the whole page would make a missing profile look like a
        // broken User Management screen.
        console.error(
          "[listUsers] Could not read authoritative profiles:",
          profileError.message,
        );
      }
      const profilesById = new Map(
        (profileRows || []).map((row: any) => [
          String(row.id),
          {
            role: String(row.role || ""),
            superAgentId: String(row.super_agent_id || "") || null,
          },
        ]),
      );

      // A Super Agent may only see their own sub-agents. Membership is read
      // from `user_profiles` (authoritative) joined against the auth list,
      // not from each member's user-writable metadata.
      let visibleUserIds: Set<string> | null = null;
      if (!isAdmin) {
        const { data: myAgents } = await admin
          .from("user_profiles")
          .select("id")
          .eq("super_agent_id", identity.id);
        visibleUserIds = new Set((myAgents || []).map((row) => String(row.id)));
      }

      const users = (data.users || [])
        .map((member: AuthUser) => ({
          ...member,
          profile: profilesById.get(String(member.id)) || null,
        }))
        .filter(
          (member: AuthUser) =>
            isAdmin || visibleUserIds!.has(String(member.id)),
        );
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

      const currentRole = normalizeRole(
        target.user.app_metadata?.role || target.user.user_metadata?.role,
      );
      if (currentRole === "admin") {
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
        const ownerRole = normalizeRole(
          owner.user.app_metadata?.role || owner.user.user_metadata?.role,
        );
        if (ownerRole !== "super_agent") {
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

      // The badge is mirrored into BOTH stores, and they are NOT equivalent:
      //
      //   app_metadata  - service-role only, NOT writable by the user. This is
      //                   what the five enterprise gates read
      //                   (paystack-subaccount, super-agent-offers,
      //                   super-agent-tier-management,
      //                   super-agent-user-management, admin-users).
      //   user_metadata - writable by the user via auth.updateUser(). Kept in
      //                   sync ONLY so the app's existing display readers keep
      //                   working; never trusted for authorization.
      //
      // Previously the badge was written ONLY to user_metadata while the gates
      // read app_metadata. Nothing ever populated the latter, so `badge` was
      // always "" and every Enterprise super agent was denied with 403 - the
      // app showed the badge as granted because it reads user_metadata first,
      // so the UI and the function disagreed.
      const currentAppMetadata: Record<string, unknown> = {
        ...(target.user.app_metadata || {}),
      };
      const nextAppMetadata: Record<string, unknown> = {
        ...currentAppMetadata,
      };

      if (requestedRole === "normal_user") {
        // Clearing every role alias leaves a normal user, which the app reads
        // as "no role". Stale badge / assignment keys would keep granting
        // Super Agent behaviour, so remove them too.
        //
        // Set to `null`, NOT `delete`d. GoTrue MERGES the metadata object it is
        // given (JSON merge-patch), so a key that is merely absent from the
        // patch is never sent and the stored value survives untouched. A
        // `delete nextMetadata.x` looked correct and silently did nothing,
        // which is how a demoted Enterprise super agent kept logging in as
        // "Super Agent - Enterprise": the badge was still in both metadata
        // stores and the Enterprise gates in five functions read it.
        //
        // An explicit JSON `null` IS transmitted by merge-patch, which removes
        // the key. It also reads as "no badge" to every consumer, because they
        // all coerce with `|| ""` or `String(x || "")`.
        nextMetadata.role = null;
        nextMetadata.super_agent_badge = null;
        nextMetadata.super_agent_id = null;
        nextMetadata.superAgentId = null;
        nextAppMetadata.super_agent_badge = null;
        // A normal user has no role, and "no role" is how the app represents
        // that - do not leave a stale one behind in app_metadata either.
        nextAppMetadata.role = null;
      } else if (requestedRole === "sub_agent") {
        nextMetadata.role = "sub_agent";
        nextMetadata.super_agent_id = resolvedSuperAgentId;
        nextMetadata.superAgentId = null;
        // An Agent is not a Super Agent, so drop any badge.
        nextMetadata.super_agent_badge = null;
        nextAppMetadata.super_agent_badge = null;
      } else {
        nextMetadata.role = "super_agent";
        nextMetadata.super_agent_badge = badge;
        // A Super Agent answers to the platform, not to another one.
        nextMetadata.super_agent_id = null;
        nextMetadata.superAgentId = null;
        nextAppMetadata.super_agent_badge = badge;
      }

      // Mirror the role into `app_metadata` as well as `user_metadata`.
      //
      // The RLS read policies - `edge_function_logs_admin_read` (migration
      // 20260926_007), and the admin legs in 20260926_006 / _008 / _009 -
      // key on `(auth.jwt() -> 'app_metadata' ->> 'role')` ONLY. They cannot
      // read `user_metadata` because that store is writable by the user
      // itself via `supabase.auth.updateUser()`, so a policy built on it would
      // be self-service privilege escalation. See migration 20260926_010
      // `strip_user_metadata_rls.sql` for the full argument.
      //
      // Previously ONLY `user_metadata.role` was written, so no account ever
      // carried a role in `app_metadata` and every one of those policies
      // evaluated to false. The admin app reads `edge_function_logs` with the
      // ANON key under the `authenticated` role, so it was silently denied:
      // PostgREST answered 200 with `[]`, which the screen renders as "no
      // activity". Role writes are a service-role operation with no
      // cross-device push, so nothing else would ever fix it.
      //
      // For normal_user the key is set to `null`, not "normal_user": no policy
      // grants on the literal string, and an explicit value is what a later
      // promotion would otherwise have to overwrite. Assigning
      // unconditionally here would also have undone the `null` in the
      // normal_user branch above, since this runs after it.
      if (requestedRole !== "normal_user") {
        nextAppMetadata.role = requestedRole;
      }

      const { data: updated, error: updateError } =
        await admin.auth.admin.updateUserById(targetUserId, {
          user_metadata: nextMetadata,
          app_metadata: nextAppMetadata,
        });
      if (updateError) throw updateError;

      // `user_profiles` is the AUTHORITATIVE store that every edge function
      // reads via `resolveIdentity`, so THIS write - not the metadata write
      // above - is what actually changes the user's permissions.
      //
      // Migration 20260925_004 widened the CHECK constraint to
      // ('normal_user','super_agent','sub_agent','admin'), so `normal_user`
      // IS representable and is written verbatim. The previous code
      // downgraded it to "sub_agent" on the grounds that the constraint did
      // not allow it - true when written, false after that migration.
      // Demoting a Super Agent therefore left the profile claiming
      // `sub_agent`, which is NOT "no role", so the demotion never took
      // effect in any migrated function. That is what made an admin role
      // swap look like a no-op in the main app.
      //
      // `requestedRole` is already validated against
      // ['normal_user','sub_agent','super_agent'] above, so it is a legal
      // CHECK value by construction. No mapping is required.
      const profileRole = requestedRole;

      // normal_user is now written as normal_user - see the note above the
      // `profileRole` assignment.
      const { data: savedProfile, error: profileError } = await admin
        .from("user_profiles")
        .upsert(
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
        )
        .select("id, role, super_agent_id")
        .single();
      if (profileError) {
        // Loud: the auth record and the authoritative store now disagree, and
        // every migrated function reads the latter.
        console.error(
          "[setUserRole] user_profiles upsert FAILED - authorization and role disagree:",
          profileError.message,
        );
        return json(
          {
            error:
              "Role was saved on the account but the profile could not be updated. Authorization is out of sync - retry or contact support.",
            details: { profileError: profileError.message },
          },
          500,
        );
      }

      // ------------------------------------------------------------------------
      // A promoted account gets its wallet HERE, not by a separate admin click
      // ------------------------------------------------------------------------
      // `setUserRole` never created a wallet row, and `initializeSuperAgentWallet`
      // is a manual per-user action behind a button. So promoting a user left
      // them with NO `super_agent_wallets` row at all, which the admin app
      // renders as "Not initialized" - the badge reads as though the account is
      // stuck or on hold, when in fact nothing exists yet. The main app had the
      // mirrorrow waiting on the same event, so a promoted sub-agent started
      // with a real balance the admin screen could not see.
      //
      // Done here rather than in the client so it is not bypassable: the role
      // change and the wallet it implies must land together, and only this
      // function knows the promotion actually succeeded.
      //
      // The row is created EMPTY. Balance is never invented - it arrives only
      // from a real top-up, and for a sub-agent from their own top-ups being
      // mirrored (see the note on `initializeSubAgentMirror` below).
      if (requestedRole === "super_agent" || requestedRole === "sub_agent") {
        // A promoted SUB-AGENT should not start at zero when they have already
        // paid money in. `sub_agent_mirror_seed` (migration 011) computes their
        // mirror from their own top-up history; a promoted SUPER AGENT is not in
        // that view at all and correctly starts empty, because their balance
        // only ever comes from a real top-up.
        //
        // Read defensively: this function must not FAIL if the view is missing
        // (an unapplied 011). A missing view just means 0, which is the same
        // place they would have started anyway.
        let seededBalance = 0;
        if (requestedRole === "sub_agent") {
          try {
            const { data: seedRow, error: seedError } = await admin
              .from("sub_agent_mirror_seed")
              .select("target_balance")
              .eq("sub_agent_id", targetUserId)
              .maybeSingle();
            if (seedError) {
              console.warn(
                "[setUserRole] mirror seed unreadable; starting the promoted sub-agent at 0:",
                seedError.message,
              );
            } else if (seedRow) {
              seededBalance = Number(seedRow.target_balance || 0);
            }
          } catch (seedLookupError) {
            console.warn(
              "[setUserRole] mirror seed lookup threw; starting the promoted sub-agent at 0:",
              seedLookupError,
            );
          }
        }

        // Insert-if-absent, NOT an upsert. An upsert would overwrite an existing
        // balance with 0, which is how a demoted super agent re-promoted months
        // later would have their real money silently zeroed by an admin simply
        // saving the role again. The conflict target is the primary key, so a
        // row that already exists is left completely untouched.
        const { error: walletSeedError } = await admin
          .from("super_agent_wallets")
          .insert({ super_agent_id: targetUserId, balance: seededBalance })
          .select("super_agent_id")
          .maybeSingle();

        if (walletSeedError && walletSeedError.code !== "23505") {
          // Non-fatal, and deliberately so. The ROLE change is the
          // authorization decision and it has already been committed to both
          // stores; failing the whole request here would leave the account in a
          // worse state - demoted in the app, promoted in the database. Report it
          // loudly and let the admin retry the wallet separately.
          //
          // 23505 (unique violation) is the expected outcome for anyone who
          // already has a wallet, and is success for our purposes.
          console.error(
            "[setUserRole] wallet row could not be created for the promoted account:",
            { userId: targetUserId, role: requestedRole, walletSeedError },
          );
        }
      }

      return json({
        user: updated.user,
        // The row as persisted, echoed back so the admin app renders the
        // AUTHORITATIVE role rather than re-deriving it from auth metadata.
        // This is also what the `user_profiles` realtime channel delivers to
        // every other signed-in client, so the two cannot drift.
        profile: savedProfile
          ? {
              id: String(savedProfile.id),
              role: String(savedProfile.role || ""),
              superAgentId: String(savedProfile.super_agent_id || "") || null,
            }
          : null,
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
      const targetRole = normalizeRole(
        target.user.app_metadata?.role || target.user.user_metadata?.role,
      );
      if (targetRole !== "super_agent") {
        return json({ error: "Selected account is not a Super Agent" }, 400);
      }

      // Mirrored into both stores - see the long note in `setUserRole`. The
      // gates read `app_metadata` (service-role only), so writing only
      // `user_metadata` left `app_metadata.super_agent_badge` empty and every
      // Enterprise super agent was denied by the gates with a 403.
      const { data, error } = await admin.auth.admin.updateUserById(
        superAgentId,
        {
          user_metadata: {
            ...(target.user.user_metadata || {}),
            super_agent_badge: badge,
          },
          app_metadata: {
            ...(target.user.app_metadata || {}),
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
      const targetRole = normalizeRole(
        target.user.app_metadata?.role || target.user.user_metadata?.role,
      );
      if (targetRole !== "super_agent") {
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
      const targetRole = normalizeRole(
        target.user.app_metadata?.role || target.user.user_metadata?.role,
      );
      if (targetRole !== "super_agent") {
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
      const targetRole = normalizeRole(
        target.user.app_metadata?.role || target.user.user_metadata?.role,
      );
      if (targetRole !== "super_agent") {
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
        // The caller's OWN badge. It was read from their own user_metadata,
        // which they can edit themselves to claim Enterprise and unlock
        // sub-agent creation. `user_profiles` does not store the badge, so this
        // still consults auth metadata - but it is now an explicit, auditable
        // read of a DISPLAY field, not an authorization decision, and the
        // deny-by-default below is the thing that matters.
        const { data: callerAuth } = await admin.auth.admin.getUserById(
          identity.id,
        );
        // `app_metadata` ONLY. The badge is not stored on user_profiles, so it
        // still has to come from auth metadata - but reading the user-writable
        // `user_metadata` here would let a Pro super agent add
        // `super_agent_badge: "enterprise"` to their own profile and grant
        // themselves sub-agent creation. This is an explicit read of a display
        // label, not an authorization decision, and it fails closed.
        const callerBadge = String(
          callerAuth?.user?.app_metadata?.super_agent_badge || "",
        ).toLowerCase();

        // Fail closed: an unrecognised or absent badge does not get the
        // Enterprise capability.
        if (callerBadge !== "enterprise") {
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
        String(metadata.super_agent_id || identity.id) !== identity.id
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
      const targetRole = normalizeRole(
        target.user?.app_metadata?.role || target.user?.user_metadata?.role,
      );
      if (targetRole === "admin" || targetRole === "super_agent") {
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
