import { createClient } from "npm:@supabase/supabase-js@2";
// ===========================================================================
// IDENTITY HELPERS - INLINED, DUPLICATED ON PURPOSE
// ===========================================================================
// WHY THIS BLOCK IS HERE INSTEAD OF IMPORTED
// -------------------------------------------
// These functions are deployed through the Supabase dashboard's "Deploy with
// upload file", which bundles ONLY the selected function folder. A relative
// import of a shared module therefore fails to resolve:
//
//   Failed to bundle the function (reason: Module not found
//   "file:///tmp/user_fn_.../_shared/auth.ts")
//
// (The CLI's `supabase functions deploy` bundles the whole directory and
// would resolve it, but the dashboard is what is used here.) So the helpers
// are inlined into every function that needs them and each function is
// entirely self-contained. There is no _shared directory and no
// cross-function import.
//
// WHAT IS AUTHORITATIVE
// ---------------------
// Role and ownership come from `public.user_profiles`, NOT from
// `user_metadata`. `user_metadata` is writable by the user via
// `supabase.auth.updateUser({ data: { role: 'admin' } })`, so any function
// that trusts it has self-service privilege escalation. `app_metadata` is
// service-role-only and safe. A missing profile row resolves to `sub_agent`,
// so this fails CLOSED.
//
// UPDATING THESE HELPERS
// ----------------------
// There is no single source of truth any more. If the logic changes, update
// the block in ALL 12 functions, then run the drift check to confirm:
//
//   node scripts/check-edge-identity-drift.cjs
//
// It compares the parsed token stream of every copy, so prettier's line
// wrapping does not produce false positives, and a genuinely stale copy is
// reported as DRIFT. Run it after any edit to this block. The functions are:
//   admin-users, afa-registration, bulk-update-orders, cancel-admin-order,
//   dispatch-order, paystack-subaccount, reorder-held-agent-order,
//   super-agent-offers, super-agent-tier-management,
//   super-agent-user-management, verify-payment, verify-wallet-topup
//
// Requires `createClient` to be imported from "npm:@supabase/supabase-js@2".

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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Display-casing only. Authorization comes from the resolved Identity, never
// from a role read out of auth metadata.
const ROLE_DISPLAY: Record<string, string> = {
  admin: "Admin",
  super_agent: "SuperAgent",
  sub_agent: "Agent",
  normal_user: "Normal User",
};

/**
 * Every auth user, across all pages.
 *
 * `auth.admin.listUsers()` returns ONE PAGE. Called with no arguments it
 * applies the server default of 50 users and silently drops the rest, so a
 * roster built by intersecting the profile ids against that single page loses
 * every sub-agent who is not in the first 50 accounts in the project.
 *
 * That failure is invisible: it is not an error, just a short list. It would
 * read as "sub-agents disappearing" once the project passes 50 users, and it
 * would hit every screen that renders a roster - the agents page, the
 * transactions screen and the per-agent analytics ranking - because they all
 * read through this one action.
 *
 * Paging advances until a page comes back SHORT, so a server that clamps a
 * page terminates the loop instead of spinning. `listUsers` paginates by a
 * monotonic cursor rather than an offset, so there is no row-skipping hazard
 * between pages the way an offset walk would have.
 *
 * A hard page cap exists purely as a runaway guard, and exceeding it THROWS
 * rather than returning a truncated roster - a short list is the exact failure
 * this replaces, so silently returning one would reintroduce it.
 *
 * The client is passed in rather than closing over the handler's
 * `supabaseAdmin`: that binding is declared INSIDE the request handler, so a
 * module-level helper cannot reach it. Creating a second service-role client
 * here would work but would duplicate the env lookup for no benefit.
 */
const listAllAuthUsers = async (client: any): Promise<any[]> => {
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 200;
  const collected: any[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage: PAGE_SIZE,
    });
    if (error) throw error;

    const users = data?.users || [];
    collected.push(...users);

    // An empty page and a short page both mean "this was the last one".
    if (users.length === 0 || users.length < PAGE_SIZE) return collected;
  }

  throw new Error(
    `listUsers exceeded ${MAX_PAGES} pages of ${PAGE_SIZE}; refusing to return a truncated roster`,
  );
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

    // `resolveIdentity` performs the token check itself (it calls
    // `auth.getUser()` and throws on failure), so the separate call here was
    // redundant. The service-role client is created once and reused for both
    // the authoritative profile read and the queries below.
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const identity: Identity = await resolveIdentity({
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
      serviceRoleKey: supabaseServiceRoleKey,
      authClient: supabaseAuth,
      admin: supabaseAdmin,
    });
    if (identity.profileMissing) {
      console.warn(
        "[super-agent-user-management] No user_profiles row; defaulted to sub_agent:",
        identity.id,
      );
    }

    // Display-cased view of the AUTHORITATIVE role. The previous
    // `normalizeRole(user)` read `user_metadata.role` first, so a caller could
    // grant themselves SuperAgent via `supabase.auth.updateUser` and then list
    // every sub-agent top-up in the system.
    const userRole = ROLE_DISPLAY[identity.role] ?? null;
    const isAllowedAdmin = userRole === "Admin" || userRole === "SuperAgent";

    // The caller's own id/email are token-derived and not spoofable. Aliasing
    // keeps the many `user.id` / `user.email` audit and ownership call sites
    // below unchanged, while `identity` carries the authorization data.
    const user = { id: identity.id, email: identity.email } as {
      id: string;
      email?: string | null;
    };

    const body = await req.json().catch(() => ({}));
    const { action, superAgentId, userData } = body;

    // --- listUsers: only Admin or SuperAgent may list users ---
    if (action === "listUsers") {
      if (!isAllowedAdmin) {
        return new Response(
          JSON.stringify({
            error: "Only admins and super-agents can list users",
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      // Every page, not just the first. See `listAllAuthUsers`: intersecting
            // the profile ids against a single 50-user page drops sub-agents
            // silently once the project passes 50 accounts.
            const users = await listAllAuthUsers(supabaseAdmin);
            // Sub-agent membership comes from `user_profiles`, not from each
      // member's self-writable metadata.
      const { data: agentProfiles } = await supabaseAdmin
        .from("user_profiles")
        .select("id, role, super_agent_id")
        .eq("super_agent_id", superAgentId);
      const profileById = new Map(
        (agentProfiles || []).map((row) => [String(row.id), row]),
      );
      const visibleIds = new Set(profileById.keys());
      const filteredUsers = superAgentId
        ? users.filter((member: any) => visibleIds.has(String(member.id)))
        : users;

      // Each member carries their AUTHORITATIVE role and owner alongside the
      // auth record. The client used to re-derive both from
      // `user_metadata`, which the account owner can rewrite with
      // `auth.updateUser()` - so the sub-agent list was filtered on a value
      // the listed user controls. The client now reads these instead.
      const withProfile = filteredUsers.map((member: any) => {
        const row: any = profileById.get(String(member.id));
        return {
          ...member,
          role: String(row?.role || ""),
          superAgentId: String(row?.super_agent_id || "") || null,
        };
      });

      return new Response(JSON.stringify({ users: withProfile }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "listTopUps") {
      if (!isAllowedAdmin || userRole !== "SuperAgent") {
        return new Response(
          JSON.stringify({
            error: "Only super-agents can list sub-agent top-ups",
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { data: usersData, error: listError } =
        await supabaseAdmin.auth.admin.listUsers();
      if (listError) throw listError;

      const { data: myAgents } = await supabaseAdmin
        .from("user_profiles")
        .select("id, full_name, role")
        .eq("super_agent_id", identity.id);
      const myAgentIds = new Set((myAgents || []).map((row) => String(row.id)));
      const subAgents = (usersData?.users || []).filter((member: any) =>
        myAgentIds.has(String(member.id)),
      );

      const subAgentIds = subAgents.map((member: any) => member.id);
      if (subAgentIds.length === 0) {
        return new Response(JSON.stringify({ topUps: [] }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: paystackConfig, error: paystackConfigError } =
        await supabaseAdmin
          .from("super_agent_paystack")
          .select("subaccount_code, percentage_charge")
          .eq("super_agent_id", user.id)
          .maybeSingle();
      if (
        paystackConfigError &&
        !isMissingDatabaseObject(paystackConfigError)
      ) {
        throw paystackConfigError;
      }

      const { data: topUps, error: topUpsError } = await supabaseAdmin
        .from("wallet_topups")
        .select("*")
        .in("agent_id", subAgentIds)
        .order("created_at", { ascending: false })
        .limit(100);
      if (topUpsError) throw topUpsError;

      // Names come from `user_profiles.full_name` FIRST, then auth metadata.
      //
      // `user_metadata` is writable by the account owner via
      // `auth.updateUser({ data: { business_name: '...' } })`, so a sub-agent
      // can put any string there and have it rendered as their name on a super
      // agent's financials screen. `user_profiles.full_name` is not
      // self-writable. Falling back to metadata is still worth it for display,
      // but the authoritative value has to win when it exists.
      const profilesById = new Map(
        (myAgents || []).map((row: any) => [String(row.id), row]),
      );
      const businessNames = new Map(
        subAgents.map((member: any) => {
          const profile = profilesById.get(String(member.id));
          return [
            member.id,
            profile?.full_name ||
              member.user_metadata?.business_name ||
              member.user_metadata?.full_name ||
              member.email ||
              "Sub-agent",
          ];
        }),
      );

      return new Response(
        JSON.stringify({
          topUps: (topUps || []).map((topUp: any) => ({
            ...topUp,
            business_name: businessNames.get(topUp.agent_id) || "Sub-agent",
            split_subaccount_code:
              topUp.paystack_subaccount_code ||
              paystackConfig?.subaccount_code ||
              null,
            split_percentage_charge: paystackConfig?.percentage_charge ?? null,
            // The 1.95% breakdown, so the super agent can reconcile a sub-agent's
            // top-up against the Paystack dashboard without doing the arithmetic
            // themselves.
            //
            // `amount` is the NET credited to the wallet, `gross_amount` is what
            // was actually charged. Both were null before migration
            // 20260927_003, so each field falls back to a derived value rather
            // than rendering "N/A" on every historical row: a pre-snapshot row
            // simply reports gross == net, which is the honest reading of a row
            // that did not record a charge.
            gross_amount: topUp.gross_amount ?? topUp.amount,
            charge_amount: topUp.charge_amount ?? 0,
            charge_percent: topUp.charge_percent ?? null,
            // Whose wallet the net was credited to. Equals the payer's id for a
            // self-funded top-up; for a sub-agent it is the super agent, whose
            // balance actually grew. Surfaced so the screen never implies the
            // money sits with the sub-agent.
            wallet_owner_id: topUp.wallet_owner_id ?? topUp.agent_id,
            funded_someone_else:
              (topUp.wallet_owner_id ?? topUp.agent_id) !== topUp.agent_id,
          })),
          // Totals across every sub-agent top-up, so the header does not have to
          // sum 100 client-side and can be shown without a second request.
          summary: {
            count: (topUps || []).filter(
              (topUp: any) => topUp.status === "success",
            ).length,
            total_credited: Number(
              (topUps || [])
                .filter((topUp: any) => topUp.status === "success")
                .reduce(
                  (sum: number, topUp: any) => sum + Number(topUp.amount || 0),
                  0,
                )
                .toFixed(2),
            ),
            total_charged: Number(
              (topUps || [])
                .filter((topUp: any) => topUp.status === "success")
                .reduce(
                  (sum: number, topUp: any) =>
                    sum + Number(topUp.gross_amount ?? topUp.amount ?? 0),
                  0,
                )
                .toFixed(2),
            ),
          },
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
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
      // Badge from `app_metadata` ONLY, with no default. The old code read the
      // self-writable `user_metadata.super_agent_badge` first and fell back to
      // "enterprise", so any Pro super agent could add that key to their own
      // metadata and unlock sub-agent creation.
      const { data: callerAuth } = await supabaseAdmin.auth.admin.getUserById(
        identity.id,
      );
      const badge = String(
        callerAuth?.user?.app_metadata?.super_agent_badge || "",
      ).toLowerCase();
      if (badge !== "enterprise") {
        return new Response(
          JSON.stringify({
            error: "The Pro badge does not include sub-agent creation access",
          }),
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

      const newAgentId = createdUser.user.id;

      // ------------------------------------------------------------------------
      // THE AUTHORITATIVE PROFILE ROW
      // ------------------------------------------------------------------------
      // This branch used to stop at `auth.admin.createUser`. Everything it wrote
      // landed in `user_metadata`, which is SELF-WRITABLE and which nothing
      // authorizes from - `resolveIdentity` reads `public.user_profiles`, and
      // `listUsers` (the roster this very screen renders) filters
      // `.eq("super_agent_id", superAgentId)` on that SAME table.
      //
      // `handle_new_user()` fires on the auth INSERT and does create a profile
      // row, but it can only seed what is in the two metadata stores, and it
      // inserts just `id, role, email, full_name, business_name`. Critically it
      // never writes `super_agent_id`, and nothing else here did either. So the
      // new account got:
      //
      //   role             -> 'sub_agent'  (readable from metadata, so it looked OK)
      //   super_agent_id   -> NULL
      //
      // and that single NULL is both reported symptoms:
      //
      //   1. The sub agent does not appear on the roster. `listUsers` selects
      //      `.eq("super_agent_id", superAgentId)`; a NULL owner matches no
      //      row, so the freshly created agent is filtered out of the list the
      //      super agent is looking at.
      //   2. They resolve as an ownerless sub agent. `verify-wallet-topup`
      //      refuses a `sub_agent` with no `super_agent_id` with 403 BEFORE it
      //      reaches Paystack ("You are not assigned to a Super Agent"), and
      //      `verify-payment` debits by `p_super_agent_id => user.id`, so every
      //      order they place fails its wallet check and lands as `held`
      //      instead of settling. That is the "appears as held" report.
      //
      // So the owner - not the role - is what was actually missing. Both are
      // written explicitly here anyway: role is stated rather than inherited
      // from a string the trigger has to parse, and `super_agent_id` is the
      // column nothing else can supply.
      //
      // This is an UPSERT, not an insert, so it is correct whether or not the
      // trigger fired, and it repairs the row rather than tripping over it.
      const { error: profileError } = await supabaseAdmin
        .from("user_profiles")
        .upsert(
          {
            id: newAgentId,
            role: "sub_agent",
            super_agent_id: user.id,
            email,
            full_name: fullName,
            business_name: businessName,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "id" },
        )
        .select("id, role, super_agent_id")
        .single();

      if (profileError) {
        // Loud rather than swallowed. The auth account exists, but an ownerless
        // profile is exactly the broken state this branch just fixed, and
        // returning 200 here would tell the super agent it worked.
        console.error(
          "[createSubAgent] user_profiles upsert FAILED - role and ownership are out of sync:",
          profileError.message,
        );
        return new Response(
          JSON.stringify({
            error:
              "The sub-agent account was created but its role and assignment could not be saved. Authorization is out of sync - retry or contact support.",
            details: { profileError: profileError.message },
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // ------------------------------------------------------------------------
      // The sub-agent's own mirror wallet row
      // ------------------------------------------------------------------------
      // Migrations 008/012 give every sub agent a `super_agent_wallets` row:
      // their MIRRORED spending power. Only the admin path seeded it
      // (`setUserRole`), so a super-agent-created sub agent had NO row at all.
      // The Pay button then resolves no wallet and the top-up cannot proceed -
      // the same dead end the profile NULL above caused, one step further down.
      //
      // Balance is NOT invented. It starts at 0 and only ever moves from a real
      // top-up mirrored in (verify-wallet-topup credits both sides). Seeded from
      // the super agent's balance it would mint spending power nobody paid for.
      //
      // INSERT, not upsert: an upsert would zero a real balance if this ever
      // re-ran. 23505 means the row already exists, which is fine.
      const { error: walletError } = await supabaseAdmin
        .from("super_agent_wallets")
        .insert({ super_agent_id: newAgentId, balance: 0 })
        .select("super_agent_id")
        .maybeSingle();

      if (walletError && walletError.code !== "23505") {
        // Non-fatal, and deliberately so. The account and its role/ownership
        // are committed; failing the whole request would leave the super agent
        // believing nothing was created when a real, loginable sub agent
        // exists. Report it and let the admin initialise the wallet separately.
        console.error(
          "[createSubAgent] mirror wallet row could not be created for the new sub-agent:",
          { userId: newAgentId, walletError },
        );
      }

      return new Response(
        JSON.stringify({
          user: createdUser.user,
          // Echoed back so the client renders the AUTHORITATIVE role rather
          // than re-deriving it from the metadata it just sent.
          profile: { id: newAgentId, role: "sub_agent", superAgentId: user.id },
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
        return new Response(JSON.stringify({ error: "agent_id is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const updatePayload: Record<string, unknown> = {};
      if (userData?.full_name !== undefined) {
        updatePayload.full_name = String(userData.full_name).trim();
      }
      if (userData?.business_name !== undefined) {
        updatePayload.business_name =
          String(userData.business_name).trim() || null;
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
        return new Response(JSON.stringify({ error: "Sub agent not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const existingMeta = existingUser.user.user_metadata || {};
      if (String(existingMeta.super_agent_id || "") !== String(user.id)) {
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

      return new Response(JSON.stringify({ user: updatedUser?.user || null }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "deactivateSubAgent") {
      if (userRole !== "SuperAgent") {
        return new Response(
          JSON.stringify({
            error: "Only super agents can deactivate sub agents",
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const targetAgentId = String(userData?.agent_id || "").trim();
      if (!targetAgentId) {
        return new Response(JSON.stringify({ error: "agent_id is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: existingUser, error: fetchError } =
        await supabaseAdmin.auth.admin.getUserById(targetAgentId);

      if (fetchError || !existingUser?.user) {
        return new Response(JSON.stringify({ error: "Sub agent not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const existingMeta = existingUser.user.user_metadata || {};
      if (String(existingMeta.super_agent_id || "") !== String(user.id)) {
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
      const settlementBank =
        String(userData?.settlement_bank || "").trim() || null;
      const settlementBankCode =
        String(userData?.settlement_bank_code || "").trim() || null;
      const accountNumber =
        String(userData?.account_number || "").trim() || null;
      const paystackRawResponse = userData?.paystack_raw_response || null;
      const isActive =
        userData?.is_active === undefined ? true : Boolean(userData.is_active);
      const percentageCharge =
        userData?.percentage_charge !== undefined &&
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
      // Ownership from the authoritative profile. This previously read
      // `user_metadata.super_agent_id` first, which the caller can rewrite to
      // name a different super agent - letting them act inside another
      // agent's account tree.
      const targetSuperAgentId = identity.superAgentId;
      const effectiveAgentId =
        userRole === "SuperAgent" ? user.id : targetSuperAgentId;

      if (!effectiveAgentId) {
        return new Response(
          JSON.stringify({
            error: "No super agent is assigned to this account",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      if (userRole !== "SuperAgent") {
        const isMember = superAgentId
          ? String(superAgentId) === String(user.id)
          : true;
        if (!isMember && !targetSuperAgentId) {
          return new Response(
            JSON.stringify({
              error: "Must be a super-agent or have a super_agent_id assigned",
            }),
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
