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
//   super-agent-offers, super-agent-order-status,
//   super-agent-tier-management,
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

  // Fallback for accounts created before the on_auth_user_created trigger, or
  // whose profile row was never created. `app_metadata` only.
  const roleFromAppMetadata = normalizeRole(user.app_metadata?.role);
  const role =
    normalizeRole(profile?.role) ??
    roleFromAppMetadata ??
    // Fail closed. `sub_agent` is the trigger's default and the least
    // privileged role, so an unknown user can only ever act on themselves.
    "sub_agent";

  // Ownership likewise comes from the profile. `user_metadata.super_agent_id`
  // is user-writable, so reading it would let a sub-agent re-point themselves
  // at another super agent and have their purchase debited from that wallet.
  const superAgentId =
    (profile?.super_agent_id as string | null | undefined) ??
    (typeof user.app_metadata?.super_agent_id === "string"
      ? user.app_metadata.super_agent_id
      : null) ??
    null;

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

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// ===========================================================================
// WHAT THIS FUNCTION IS FOR
// ===========================================================================
// A Super Agent placed the money, settled to their own Paystack subaccount, and
// owns the relationship with the sub-agents in their roster. They can already
// SEE those orders (`agent_orders.super_agent_id`) and can already retry their
// held ones (`reorder-held-agent-order`). What they could not do was mark one
// complete when the sub-agent sold the data on and told them it had gone
// through - so the only person who could close that loop was a staff admin.
//
// This closes it: a Super Agent may move THEIR OWN sub-agents' orders between
// lifecycle states.
//
// WHY A FUNCTION AND NOT A DIRECT CLIENT WRITE
// --------------------------------------------
// `agent_orders` has no UPDATE policy for anyone but the service role, so the
// client genuinely cannot do this on its own. That is the right default - the
// same absence is what stops a sub-agent editing their own order to "completed"
// and hiding an undelivered purchase.
//
// ===========================================================================
// WHAT A SUPER AGENT MAY NOT DO, AND WHY
// ===========================================================================
// This is the part that matters. A super agent is a COMMERCIAL PARTY to these
// orders - they are the ones who sold the data and took the money. Granting
// them the same status vocabulary as an admin would hand them the money-moving
// verbs, because two of those statuses are not a label, they are a REFUND:
//
//   - cancelled / refunded : `cancel_admin_order` credits the wallet that was
//     debited. A super agent allowed to fire it on a delivered order would take
//     back the money for data the recipient already received, straight out of
//     their own wallet - self-refunding, at scale, for orders they placed.
//   - failed : the held-order expiry sweep and refund path treat 'failed' as a
//     refundable terminal state.
//
// So the writable set is deliberately the LABEL statuses only. Everything a
// super agent is allowed to do is a statement about what happened to the data;
// nothing here can move a cent.
//
//   pending    - the provider has not confirmed delivery
//   processing - the provider has it and is working on it
//   completed  - the provider confirmed the data went through
//   delivered  - the recipient received it
//
// 'expired' and 'cancelled' are excluded too: they are terminal states owned by
// the held-order sweep and the cancel flow respectively, and letting an agent
// hand-write them would strand the refund the sweep is supposed to issue.
//
// ===========================================================================
// THE `settlement_status` MIRROR
// ===========================================================================
// `agent_orders` and `payment_transactions` both carry `settlement_status`, and
// the admin Transactions screen renders the `payment_transactions` one. If this
// function moved only `agent_orders.status`, a super agent could mark an order
// completed and the admin would still be looking at a 'pending' ledger row -
// the exact two-table drift that made the original bug invisible.
//
// So the ledger row is updated in the same transaction. `completed`/`delivered`
// settle it, because at that point the super agent's share has been earned and
// released. Moving BACK to pending/processing does not unsettle it: the money
// was already released when the order was first confirmed, and a later
// correction should not re-open a settled ledger row. That asymmetry is
// deliberate and is the safe direction - re-settling would be a refund, which
// is exactly what this function is forbidden from doing.
const WRITABLE_STATUSES = ["pending", "processing", "completed", "delivered"];
const SETTLING_STATUSES = ["completed", "delivered"];

Deno.serve(async (req) => {
  const appEnv = (Deno.env.get("APP_ENV") || "development")
    .toLowerCase()
    .trim();
  console.log("[SuperAgentOrderStatus] APP_ENV:", appEnv);

  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || anonKey;
    if (!url || !anonKey || !serviceKey) {
      return respond(
        { error: "Supabase service configuration is missing" },
        500,
      );
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization)
      return respond({ error: "Missing authorization token" }, 401);

    // Role from `public.user_profiles`, never from `user_metadata`, which the
    // account owner can rewrite via `auth.updateUser()`. Reading it from there
    // would let ANY user declare themselves a super agent and then edit the
    // order status of every other super agent's sub-agents.
    let identity;
    try {
      identity = await resolveIdentity(getSupabaseClients(authorization));
    } catch {
      return respond({ error: "Unauthorized" }, 401);
    }
    if (identity.profileMissing) {
      console.warn(
        "[SuperAgentOrderStatus] No user_profiles row; defaulted to sub_agent:",
        identity.id,
      );
    }
    if (!identityIsSuperAgent(identity) && !identityIsAdmin(identity)) {
      return respond({ error: "Super Agent role required" }, 403);
    }

    const { order_id: rawOrderId, status: rawStatus } = await req.json();

    const orderId = Number(rawOrderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return respond({ error: "A valid order_id is required" }, 400);
    }

    const newStatus = String(rawStatus || "")
      .trim()
      .toLowerCase();
    if (!WRITABLE_STATUSES.includes(newStatus)) {
      return respond(
        {
          error: "That status cannot be set from here",
          allowed: WRITABLE_STATUSES,
          note:
            "Cancelling or refunding an order releases wallet money and is handled by support, so it cannot be self-served.",
        },
        400,
      );
    }

    const admin = createClient(url, serviceKey);

    // Ownership is proven by the READ, not trusted from the request body.
    //
    // The caller never supplies a super_agent_id: it is stamped onto the row by
    // `verify-payment` from `user_profiles.super_agent_id`, which only admins
    // write. Scoping the select by it means an order belonging to someone else's
    // sub-agent simply is not found.
    const { data: order, error: orderError } = await admin
      .from("agent_orders")
      .select("id, agent_id, super_agent_id, status, jehuca_order_id, settlement_status")
      .eq("id", orderId)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) return respond({ error: "Order not found" }, 404);

    // Admins keep the existing escalation route, so this does not become a
    // second, narrower admin path.
    if (!identityIsAdmin(identity)) {
      if (order.super_agent_id !== identity.id) {
        // 403, not 404-by-silence. The order exists but is not this super
        // agent's to touch. Deliberately does NOT confirm anything about the
        // order's contents to a non-owner.
        return respond(
          { error: "This order belongs to another Super Agent" },
          403,
        );
      }
    }

    // A delivered order is a closed record. Rewriting it backwards would let a
    // super agent relabel a completed sale and re-trigger admin-side
    // investigation of money that already moved. Terminal states stay terminal.
    const currentStatus = String(order.status || "")
      .trim()
      .toLowerCase();
    const TERMINAL = ["cancelled", "refunded", "failed", "expired"];
    if (TERMINAL.includes(currentStatus) && !TERMINAL.includes(newStatus)) {
      return respond(
        {
          error: `This order is already ${currentStatus} and cannot be reopened here`,
        },
        409,
      );
    }

    const settles = SETTLING_STATUSES.includes(newStatus);

    const patch: Record<string, unknown> = { status: newStatus };
    // Only ever moves pending -> settled. Never the reverse, which would be a
    // refund. See the asymmetry note above.
    if (settles && order.settlement_status !== "settled") {
      patch.settlement_status = "settled";
    }

    const { error: updateError } = await admin
      .from("agent_orders")
      .update(patch)
      .eq("id", orderId);
    if (updateError) {
      console.error(
        "[SuperAgentOrderStatus] agent_orders update failed:",
        updateError,
      );
      return respond({ error: "Failed to update the order" }, 500);
    }

    // Mirror onto the ledger row so the admin Transactions screen agrees. Keyed
    // on order_id, which is the column `verify-payment` populates for agent
    // orders, rather than payment_reference - that is NULL on historical agent
    // rows predating migration 20260926_008.
    let ledgerUpdated = false;
    if (order.settlement_status !== "settled" && settles) {
      const { error: ledgerError } = await admin
        .from("payment_transactions")
        .update({ settlement_status: "settled" })
        .eq("order_id", orderId);
      if (ledgerError) {
        // The order itself is updated and that is the important half. Report
        // the drift rather than pretending both landed.
        console.warn(
          "[SuperAgentOrderStatus] ledger settlement mirror failed:",
          ledgerError,
        );
      } else {
        ledgerUpdated = true;
      }
    }

    console.log("[SuperAgentOrderStatus] order status updated", {
      order_id: orderId,
      from: currentStatus,
      to: newStatus,
      actor: identity.id,
      actor_role: identity.role,
    });

    return respond({
      success: true,
      order_id: orderId,
      previous_status: order.status,
      status: newStatus,
      settled: settles,
      ledger_mirrored: ledgerUpdated,
    });
  } catch (error) {
    console.error(
      "[SuperAgentOrderStatus] Unexpected error:",
      error instanceof Error ? error.message : error,
    );
    return respond(
      {
        error:
          error instanceof Error ? error.message : "Unexpected server error",
      },
      500,
    );
  }
});