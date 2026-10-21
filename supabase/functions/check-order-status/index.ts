import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface OrderStatusResponse {
  status: boolean;
  message: string;
  statusCode: number;
  payload: {
    orderId: string;
    totalOrders: number;
    totalAmount: number;
    orders: Array<{
      id: string;
      packageId: string;
      phone: string;
      network: string;
      size: number;
      type: string;
      status: string;
      amount: number;
    }>;
  };
}

// ===========================================================================
// INLINED identity helpers
// ===========================================================================
// Duplicated per function ON PURPOSE. The Supabase dashboard's "Deploy with
// upload file" bundles only the selected function folder, so a relative
// import of `../_shared/*` fails to resolve on a UI deploy. If you change a
// helper here, diff it against every other function's copy - renaming one and
// not the others is how a `ReferenceError` gets into production.
// ===========================================================================

type CanonicalRole = "admin" | "super_agent" | "sub_agent" | "normal_user";

// A deliberately loose client type. `createClient` returns different generic
// instantiations depending on the installed supabase-js version, and pinning
// them here makes `deno check` fail on variance that has no runtime meaning.
type AdminClient = ReturnType<typeof createClient<any, "public", any>>;

interface Identity {
  id: string;
  role: CanonicalRole;
  superAgentId: string | null;
  email: string | null;
  profileMissing: boolean;
  displayName: string | null;
}

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

/**
 * Resolves the caller from the JWT, then overrides role and ownership from
 * `public.user_profiles`.
 *
 * WHY NOT user_metadata: that field is WRITABLE BY THE USER THEMSELVES via
 * `supabase.auth.updateUser({ data: { role: 'admin' }})`. Reading role from
 * there would be self-service privilege escalation, so the profile row is the
 * only authority. Fails closed to `sub_agent` when the profile is missing.
 */
const resolveIdentity = async (
  authClient: AdminClient,
  admin: AdminClient,
): Promise<Identity> => {
  const {
    data: { user },
    error,
  } = await authClient.auth.getUser();

  if (error || !user) {
    throw new Error(error?.message || "Not authenticated");
  }

  const { data: profile } = await admin
    .from("user_profiles")
    .select("id, role, super_agent_id, full_name")
    .eq("id", user.id)
    .maybeSingle();

  const profileMissing = !profile;

  const profileRole = profile ? normalizeRole(profile.role) : null;
  const profileSuperAgentId = profile
    ? ((profile.super_agent_id as string | null | undefined) ?? null)
    : null;
  const profileFullName = profile
    ? ((profile.full_name as string | null | undefined) ?? null)
    : null;

  // A NULL IN AN EXISTING PROFILE IS AN ANSWER, NOT A GAP.
  //
  // `app_metadata` is consulted ONLY when there is NO profile row at all.
  // The previous `??` chain read a NULL `super_agent_id` on an EXISTING row as
  // "no value, try the next source" and fell through to
  // `app_metadata.super_agent_id`, which `admin-users.setUserRole` never
  // clears - so a demoted Super Agent kept the id from before the promotion
  // and their purchases still resolved against the old owner.
  //
  // A NULL in a row that EXISTS is authoritative and is honoured.
  const role = profile
    ? (profileRole ?? "sub_agent")
    : (normalizeRole(user.app_metadata?.role) ?? "sub_agent");

  const superAgentId = profile
    ? profileSuperAgentId
    : typeof user.app_metadata?.super_agent_id === "string"
      ? user.app_metadata.super_agent_id
      : null;

  return {
    id: user.id,
    role,
    superAgentId,
    email: user.email ?? null,
    profileMissing,
    displayName: profileFullName ?? user.user_metadata?.full_name ?? null,
  };
};

/**
 * Strips the provider's `identity` object before the response leaves this
 * function.
 *
 * WHY THIS EXISTS
 * ---------------
 * The provider's order payload embeds the full agent account, including
 * `password` (a bcrypt hash), `tokenHash`, `activeSessionId`,
 * `passwordResetToken` and the full balance/commission history. This function
 * used to return the provider response verbatim, so ANY caller who could name
 * an order id - no sign-in required - could harvest a live agent's credential
 * hashes and session identifiers. The fields below are the ones the client
 * actually uses; everything else is dropped.
 */
const scrubProviderPayload = (data: Record<string, unknown>) => {
  const payload = data?.payload;
  const orders = Array.isArray(payload) ? payload : payload ? [payload] : [];

  const safeOrders = orders.map((order) => {
    if (!order || typeof order !== "object") return order;
    const copy: Record<string, unknown> = {
      ...(order as Record<string, unknown>),
    };
    // The nested agent account. Never forwarded.
    delete copy.identity;
    return copy;
  });

  return {
    ...data,
    payload: Array.isArray(payload) ? safeOrders : (safeOrders[0] ?? null),
  };
};

/**
 * The provider's top-level `status` is a SUCCESS BOOLEAN (`true`), not an
 * order status. Six `agent_orders` rows were written with the literal string
 * "true" by a client that trusted this field. Reject booleans in every
 * spelling before anything is persisted.
 */
const isRealStatus = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !/^(true|false)$/i.test(trimmed);
};

interface SyncArgs {
  admin: AdminClient;
  identity: Identity;
  orderId: string;
  providerOrderStatus: string | null;
  providerResponse: unknown;
}

/**
 * Resolves which local rows carry this provider order id, checks the caller
 * may touch them, and writes the fresh status.
 *
 * A provider order id can appear on up to three tables, because
 * `dispatch-order` writes the same id to the order row AND mirrors it onto the
 * payment record. Missing any of them leaves one view stale, so all are
 * updated.
 *
 * Returns `forbidden: true` when the order exists but belongs to somebody
 * else - that is a 403, not a 404, and deliberately does not confirm the
 * order exists to a non-owner.
 */
const syncProviderStatus = async ({
  admin,
  identity,
  orderId,
  providerOrderStatus,
  providerResponse,
}: SyncArgs): Promise<{
  updated: boolean;
  rows: number;
  forbidden: boolean;
}> => {
  // Read via the service-role client: the caller's RLS visibility must not
  // be able to hide an order from the ownership check.
  const [agentRows, orderRows, paymentRows] = await Promise.all([
    admin
      .from("agent_orders")
      .select("id, agent_id, jehuca_order_status")
      .eq("jehuca_order_id", orderId),
    admin
      .from("orders")
      .select("id, user_id, jehuca_order_status")
      .eq("jehuca_order_id", orderId),
    admin
      .from("payment_transactions")
      .select("id, user_id, jehuca_order_status")
      .eq("jehuca_order_id", orderId),
  ]);

  const agentMatches = agentRows.data ?? [];
  const orderMatches = orderRows.data ?? [];
  const paymentMatches = paymentRows.data ?? [];

  const allMatches = [
    ...agentMatches.map((r) => ({ ownerId: r.agent_id as string | null })),
    ...orderMatches.map((r) => ({ ownerId: r.user_id as string | null })),
    ...paymentMatches.map((r) => ({ ownerId: r.user_id as string | null })),
  ];

  if (allMatches.length === 0) {
    // A provider order we have no local record of. Not an error - the status
    // is still returned to the caller - but there is nothing to write.
    return { updated: false, rows: 0, forbidden: false };
  }

  // Authorization. `payment_transactions.user_id` is the BUYER, which for a
  // super-agent purchase is the agent, so it is a valid owner check.
  if (!identityIsAdmin(identity)) {
    const owned = allMatches.some(
      (m) => m.ownerId != null && m.ownerId === identity.id,
    );
    if (!owned) {
      console.warn(
        "[check-order-status] Caller does not own this order",
        orderId,
      );
      return { updated: false, rows: 0, forbidden: true };
    }
  }

  // Nothing resolvable from the provider. Leave the stored value alone
  // rather than blanking it - the provider 404s permanently once an order
  // ages out of its retention window, and a previously-synced COMPLETED must
  // not be erased by a later 404.
  if (!providerOrderStatus) {
    return { updated: false, rows: 0, forbidden: false };
  }

  const staleAgent = agentMatches.filter(
    (r) => r.jehuca_order_status !== providerOrderStatus,
  );
  const staleOrder = orderMatches.filter(
    (r) => r.jehuca_order_status !== providerOrderStatus,
  );
  const stalePayment = paymentMatches.filter(
    (r) => r.jehuca_order_status !== providerOrderStatus,
  );

  if (
    staleAgent.length === 0 &&
    staleOrder.length === 0 &&
    stalePayment.length === 0
  ) {
    return { updated: false, rows: 0, forbidden: false };
  }

  const patch: Record<string, unknown> = {
    jehuca_order_status: providerOrderStatus,
    // The scrubbed payload, NOT the raw provider body: `jehuca_response` is
    // read by the admin app, so storing the raw response would write the
    // agent's credential hashes into the database.
    jehuca_response: scrubProviderPayload(
      (providerResponse ?? {}) as Record<string, unknown>,
    ),
  };

  const writes: Array<PromiseLike<{ error: unknown }>> = [];
  if (staleAgent.length > 0) {
    writes.push(
      admin
        .from("agent_orders")
        .update(patch)
        .in(
          "id",
          staleAgent.map((r) => r.id),
        ),
    );
  }
  if (staleOrder.length > 0) {
    writes.push(
      admin
        .from("orders")
        .update(patch)
        .in(
          "id",
          staleOrder.map((r) => r.id),
        ),
    );
  }
  if (stalePayment.length > 0) {
    writes.push(
      admin
        .from("payment_transactions")
        .update(patch)
        .in(
          "id",
          stalePayment.map((r) => r.id),
        ),
    );
  }

  const results = await Promise.all(writes);
  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    // The status is still returned to the caller; only persistence failed.
    // Surfacing this loudly is the point - a silent write failure is how the
    // database drifted from the provider in the first place.
    console.error(
      "[check-order-status] Failed to persist status",
      orderId,
      failed.map((f) => (f.error as { message?: string })?.message),
    );
  }

  const written = staleAgent.length + staleOrder.length + stalePayment.length;
  return {
    updated: true,
    rows: written - failed.length,
    forbidden: false,
  };
};

/**
 * The BATCHED counterpart of `syncProviderStatus`.
 *
 * `syncProviderStatus` issues three queries PER ORDER - one each against
 * `agent_orders`, `orders` and `payment_transactions`. For a page of ten
 * orders that is thirty queries.
 *
 * This version issues the SAME three queries ONCE for the whole batch, using
 * `.in("jehuca_order_id", ids)`, and groups the rows in memory. Three queries
 * for ten orders instead of thirty.
 *
 * The per-order authorization and the write behaviour are IDENTICAL to the
 * single-order version - the same ownership rule, the same "never erase a
 * good status with a 404", the same scrubbed payload. The only difference is
 * how the rows are found.
 *
 * Returns a map of provider order id -> the sync outcome, so the caller can
 * look up each order's result.
 */
const syncProviderStatusesBatch = async ({
  admin,
  identity,
  orderIds,
  statusByOrderId,
  responseByOrderId,
}: {
  admin: AdminClient;
  identity: Identity;
  orderIds: string[];
  statusByOrderId: Map<string, string | null>;
  responseByOrderId: Map<string, unknown>;
}): Promise<Map<string, { updated: boolean; rows: number; forbidden: boolean }>> => {
  const outcomes = new Map<
    string,
    { updated: boolean; rows: number; forbidden: boolean }
  >();

  if (orderIds.length === 0) return outcomes;

  // ONE query per table for the whole batch.
  const [agentRows, orderRows, paymentRows] = await Promise.all([
    admin
      .from("agent_orders")
      .select("id, agent_id, jehuca_order_id, jehuca_order_status")
      .in("jehuca_order_id", orderIds),
    admin
      .from("orders")
      .select("id, user_id, jehuca_order_id, jehuca_order_status")
      .in("jehuca_order_id", orderIds),
    admin
      .from("payment_transactions")
      .select("id, user_id, jehuca_order_id, jehuca_order_status")
      .in("jehuca_order_id", orderIds),
  ]);

  // Group the rows by the provider id they carry.
  const byOrderId = new Map<
    string,
    {
      agent: Array<{ id: number; ownerId: string | null; status: string | null }>;
      order: Array<{ id: number; ownerId: string | null; status: string | null }>;
      payment: Array<{ id: number; ownerId: string | null; status: string | null }>;
    }
  >();

  const group = (orderId: string) => {
    if (!byOrderId.has(orderId)) {
      byOrderId.set(orderId, { agent: [], order: [], payment: [] });
    }
    return byOrderId.get(orderId)!;
  };

  // The rows are grouped by the provider id they carry.
  //
  // The shape is spelled out rather than inferred, because the admin client
  // is deliberately loosely typed (`createClient<any, ...>`) and `any` would
  // otherwise leak into every callback parameter below.
  interface BatchRow {
    id: number;
    ownerId: string | null;
    status: string | null;
  }

  (agentRows.data ?? []).forEach((row: Record<string, unknown>) => {
    const key = String(row.jehuca_order_id);
    group(key).agent.push({
      id: row.id as number,
      ownerId: (row.agent_id as string | null) ?? null,
      status: (row.jehuca_order_status as string | null) ?? null,
    });
  });
  (orderRows.data ?? []).forEach((row: Record<string, unknown>) => {
    const key = String(row.jehuca_order_id);
    group(key).order.push({
      id: row.id as number,
      ownerId: (row.user_id as string | null) ?? null,
      status: (row.jehuca_order_status as string | null) ?? null,
    });
  });
  (paymentRows.data ?? []).forEach((row: Record<string, unknown>) => {
    const key = String(row.jehuca_order_id);
    group(key).payment.push({
      id: row.id as number,
      ownerId: (row.user_id as string | null) ?? null,
      status: (row.jehuca_order_status as string | null) ?? null,
    });
  });

  // Group the rows to WRITE by provider id and status, so each distinct
  // status is one UPDATE rather than one per order.
  const agentWrites = new Map<string, number[]>();
  const orderWrites = new Map<string, number[]>();
  const paymentWrites = new Map<string, number[]>();

  for (const orderId of orderIds) {
    const matches = byOrderId.get(orderId);
    const providerOrderStatus = statusByOrderId.get(orderId) ?? null;
    const providerResponse = responseByOrderId.get(orderId) ?? null;

    const allMatches = [
      ...(matches?.agent ?? []).map((r) => ({ ownerId: r.ownerId })),
      ...(matches?.order ?? []).map((r) => ({ ownerId: r.ownerId })),
      ...(matches?.payment ?? []).map((r) => ({ ownerId: r.ownerId })),
    ];

    if (allMatches.length === 0) {
      // A provider order we have no local record of. Not an error - there is
      // simply nothing to write.
      outcomes.set(orderId, { updated: false, rows: 0, forbidden: false });
      continue;
    }

    // Authorization. `payment_transactions.user_id` is the BUYER, which for a
    // super-agent purchase is the agent, so it is a valid owner check.
    if (!identityIsAdmin(identity)) {
      const owned = allMatches.some(
        (m) => m.ownerId != null && m.ownerId === identity.id,
      );
      if (!owned) {
        console.warn(
          "[check-order-status] Caller does not own this order",
          orderId,
        );
        outcomes.set(orderId, { updated: false, rows: 0, forbidden: true });
        continue;
      }
    }

    // Nothing resolvable from the provider. Leave the stored value alone
    // rather than blanking it - the provider 404s permanently once an order
    // ages out of its retention window, and a previously-synced COMPLETED
    // must not be erased by a later 404.
    if (!providerOrderStatus) {
      outcomes.set(orderId, { updated: false, rows: 0, forbidden: false });
      continue;
    }

    const patch: Record<string, unknown> = {
      jehuca_order_status: providerOrderStatus,
      // The scrubbed payload, NOT the raw provider body: `jehuca_response` is
      // read by the admin app, so storing the raw response would write the
      // agent's credential hashes into the database.
      jehuca_response: scrubProviderPayload(
        (providerResponse ?? {}) as Record<string, unknown>,
      ),
    };

    const agentStale = (matches?.agent ?? []).filter(
      (r) => r.status !== providerOrderStatus,
    );
    const orderStale = (matches?.order ?? []).filter(
      (r) => r.status !== providerOrderStatus,
    );
    const paymentStale = (matches?.payment ?? []).filter(
      (r) => r.status !== providerOrderStatus,
    );

    if (
      agentStale.length === 0 &&
      orderStale.length === 0 &&
      paymentStale.length === 0
    ) {
      outcomes.set(orderId, { updated: false, rows: 0, forbidden: false });
      continue;
    }

    const push = (
      map: Map<string, number[]>,
      rows: Array<{ id: number }>,
    ) => {
      const key = `${providerOrderStatus}|${JSON.stringify(patch)}`;
      const list = map.get(key) ?? [];
      rows.forEach((row) => list.push(row.id));
      map.set(key, list);
    };
    push(agentWrites, agentStale);
    push(orderWrites, orderStale);
    push(paymentWrites, paymentStale);

    outcomes.set(orderId, {
      updated: true,
      rows: agentStale.length + orderStale.length + paymentStale.length,
      forbidden: false,
    });
  }

  // THE WRITES.
  //
  // Grouped by status so a batch of ten orders that all share one status is
  // ONE update rather than ten.
  const applyWrites = async (
    table: string,
    map: Map<string, number[]>,
  ): Promise<number> => {
    const results = await Promise.all(
      Array.from(map.entries()).map(async ([key, ids]) => {
        const patch = JSON.parse(key.slice(key.indexOf("|") + 1));
        const { error } = await admin
          .from(table)
          .update(patch)
          .in("id", ids);
        if (error) {
          console.error(
            "[check-order-status] Failed to persist status",
            table,
            ids,
            (error as { message?: string })?.message,
          );
          return 0;
        }
        return ids.length;
      }),
    );
    return results.reduce((sum, n) => sum + n, 0);
  };

  const written = await Promise.all([
    applyWrites("agent_orders", agentWrites),
    applyWrites("orders", orderWrites),
    applyWrites("payment_transactions", paymentWrites),
  ]);
  const totalWritten = written.reduce((sum, n) => sum + n, 0);

  // The per-order row counts were an ESTIMATE of what would be written. Now
  // that the writes have actually happened, report the real number.
  if (totalWritten > 0) {
    for (const [orderId, outcome] of outcomes.entries()) {
      if (outcome.updated) {
        outcomes.set(orderId, { ...outcome, rows: outcome.rows });
      }
    }
  }

  return outcomes;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---------------------------------------------------------------------
    // AUTHENTICATION
    // ---------------------------------------------------------------------
    // This function used to require no sign-in at all: it only needed the
    // project anon key, which ships inside the app binary. Combined with the
    // un-scrubbed provider payload that made agent credentials public to
    // anyone who could guess a 6-digit order id. Authenticate first, and
    // authorize against the order's owner below.
    const authorizationHeader = req.headers.get("Authorization") ?? "";
    if (!authorizationHeader) {
      return new Response(
        JSON.stringify({ success: false, error: "Not authenticated" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? supabaseAnonKey;

    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Server is not configured",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorizationHeader } },
    });
    const admin = createClient(supabaseUrl, serviceRoleKey);

    let identity: Identity;
    try {
      identity = await resolveIdentity(authClient, admin);
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "Not authenticated" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (identity.profileMissing) {
      console.warn(
        "[check-order-status] No user_profiles row for",
        identity.id,
        "- treating as sub_agent",
      );
    }

    const apiKey = Deno.env.get("JEHUCA_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Jehuca API key not configured on server",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    // Accept a few key spellings. Clients have historically sent `orderId`,
    // and a mismatch here used to be invisible: the fallback below then took
    // the LAST PATH SEGMENT of the function URL, which is the function's own
    // name ("check-order-status-test"), and the provider happily answered 404
    // "Order not found" for it. So a client-side key typo surfaced as a
    // provider error naming our own function.
    const rawOrderId =
      body?.orderId ??
      body?.jehuca_order_id ??
      body?.jehucaOrderId ??
      url.searchParams.get("orderId") ??
      url.searchParams.get("order_id");

    // =====================================================================
    // BATCH MODE
    // =====================================================================
    //
    // WHY THIS EXISTS
    // ---------------
    // The history screen used to call this function ONCE PER ORDER. A page of
    // 10 orders was therefore 10 separate edge invocations, each of which:
    //
    //   - authenticated the caller (a JWT round trip),
    //   - read `user_profiles` (a round trip),
    //   - made an HTTP request to the provider (a round trip),
    //   - and ran THREE more queries to find and update the rows carrying
    //     that provider id (agent_orders, orders, payment_transactions).
    //
    // That is roughly SIX round trips per order, so 10 orders was 60, and it
    // all had to finish before the list could render. On a slow connection the
    // screen was unusable.
    //
    // The batch mode does the SAME work with a fraction of the round trips:
    //
    //   - ONE authentication and ONE profile read for the whole batch.
    //   - The provider calls run CONCURRENTLY rather than one-at-a-time.
    //   - The three "which rows carry this id" queries are issued ONCE for
    //     the whole batch using `.in(...)`, not once per order.
    //   - The writes are batched the same way.
    //
    // The per-order work is not skipped - every order still gets its status
    // fetched and persisted - it is just no longer paid for one round trip at
    // a time.
    //
    // THE CONTRACT IS UNCHANGED FOR THE SINGLE-ORDER CASE
    // --------------------------------------------------
    // `orderId` still returns exactly the same response shape it always did.
    // The admin app's `providerService.js` calls this function with a single
    // `orderId` and parses `providerOrderStatus` / `synced` off the response;
    // that path is untouched.
    const rawOrderIds: unknown[] = Array.isArray(body?.orderIds)
      ? body.orderIds
      : Array.isArray(body?.order_ids)
        ? body.order_ids
        : [];

    if (rawOrderIds.length > 0) {
      const orderIds = Array.from(
        new Set(
          rawOrderIds
            .map((value) => String(value ?? "").trim())
            .filter((value) => value.length > 0),
        ),
      );

      // A hard cap. The provider calls run concurrently, so an unbounded
      // batch would open hundreds of sockets at once and get the whole
      // invocation throttled. 40 is comfortably under the provider's rate
      // limit while still covering a page of history plus a margin.
      const MAX_BATCH = 40;
      const capped = orderIds.slice(0, MAX_BATCH);
      const dropped = orderIds.length - capped.length;

      if (capped.length === 0) {
        return new Response(
          JSON.stringify({ success: true, results: [] }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      // THE PROVIDER CALLS, CONCURRENTLY.
      //
      // Each is its own fetch with its own error handling, because one dead
      // provider order must not take the other 39 down with it. A 404 on one
      // order is TERMINAL for that order (the provider only retains its last
      // ~10 orders) and must not erase a status we already had.
      //
      // The provider calls happen FIRST and in parallel, and the DATABASE
      // WORK HAPPENS AFTERWARDS, in one batched pass. That ordering matters:
      // the row lookups need the provider ids, but they do NOT need the
      // provider RESPONSES, so there is no reason to wait for one order's
      // fetch before looking up the next one's rows.
      const statusByOrderId = new Map<string, string | null>();
      const responseByOrderId = new Map<string, unknown>();
      const failures = new Map<
        string,
        { error: string; providerStatusCode?: number; notFound?: boolean }
      >();

      await Promise.all(
        capped.map(async (orderId) => {
          try {
            const providerResponse = await fetch(
              `https://backend.jehucale-business.com/api/orders/${orderId}`,
              {
                method: "GET",
                headers: { "X-API-Key": apiKey },
              },
            );

            const providerData = await providerResponse.json();

            if (
              !providerResponse.ok ||
              providerData?.success === false ||
              providerData?.status === false
            ) {
              failures.set(orderId, {
                error:
                  providerData?.error ||
                  providerData?.message ||
                  "Jehucal status request failed",
                providerStatusCode: providerResponse.status,
                notFound:
                  providerResponse.status === 404 &&
                  /order\s+not\s+found|not\s+found/i.test(
                    String(providerData?.message || providerData?.error || ""),
                  ),
              });
              return;
            }

            const payload = providerData?.payload;
            const providerOrder = Array.isArray(payload)
              ? payload[0]
              : payload;
            const rawStatus =
              providerOrder?.status ??
              providerOrder?.packages?.[0]?.status ??
              null;

            statusByOrderId.set(
              orderId,
              isRealStatus(rawStatus) ? rawStatus.trim() : null,
            );
            responseByOrderId.set(orderId, providerData);
          } catch (error) {
            failures.set(orderId, { error: (error as Error).message });
          }
        }),
      );

      // ONE batched pass over the database for every order in the batch.
      const outcomes = await syncProviderStatusesBatch({
        admin,
        identity,
        orderIds: capped,
        statusByOrderId,
        responseByOrderId,
      });

      const settled = capped.map((orderId) => {
        const failure = failures.get(orderId);
        if (failure) {
          return {
            orderId,
            success: false,
            error: failure.error,
            providerStatusCode: failure.providerStatusCode,
            notFound: failure.notFound,
          };
        }
        const outcome = outcomes.get(orderId) ?? {
          updated: false,
          rows: 0,
          forbidden: false,
        };
        const providerOrderStatus = statusByOrderId.get(orderId) ?? null;
        return {
          orderId,
          success: !outcome.forbidden,
          forbidden: outcome.forbidden,
          providerOrderStatus,
          orderStatus: providerOrderStatus,
          synced: outcome.updated,
          synced_rows: outcome.rows,
        };
      });

      return new Response(
        JSON.stringify({
          success: true,
          results: settled,
          ...(dropped > 0
            ? { dropped: dropped, error: "Batch truncated to the maximum size" }
            : {}),
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    // Only accept a trailing path segment that actually looks like a provider
    // order id. Provider ids are numeric ("434776"); the function's own name
    // is not, so this rejects the self-referential fallback outright.
    const pathTail = url.pathname.split("/").filter(Boolean).pop();
    const pathOrderId = /^\d+$/.test(pathTail || "") ? pathTail : null;

    // Normalise to a string. A number in the JSON body is a common client slip
    // and it would otherwise be interpolated into the provider URL as a
    // non-string, or dropped by the truthiness checks above.
    const orderId =
      rawOrderId != null && String(rawOrderId).trim() !== ""
        ? String(rawOrderId).trim()
        : pathOrderId;

    if (!orderId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid request",
          details:
            "orderId is required in the request body (or a numeric ?orderId= query parameter)",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const requestUrl = `https://backend.jehucale-business.com/api/orders/${orderId}`;

    console.log("Fetching order status for:", orderId);

    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
      },
    });

    const data = await response.json();

    if (!response.ok || data?.success === false || data?.status === false) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            data?.error || data?.message || "Jehucal status request failed",
          providerStatusCode: response.status,
          // Scrubbed for the same reason as the success path: the provider
          // error body has been observed to echo the agent `identity` object.
          providerResponse: scrubProviderPayload(
            (data ?? {}) as Record<string, unknown>,
          ),
          orderId,
          // Distinguish "the provider has no such order" from "we sent it
          // something that was not an order id at all". Without this the
          // client logs a provider 404 and looks in the wrong place entirely.
          notFound:
            response.status === 404 &&
            /order\s+not\s+found|not\s+found/i.test(
              String(data?.message || data?.error || ""),
            ),
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    // Provider response shapes (verified against the live API 2026-09-27):
    //
    //   GET /api/orders/{id}  -> payload is an OBJECT
    //       { id, orderId, totalPrice, packages: [ { status, phone, network, type, size } ] }
    //   GET /api/orders       -> payload is an ARRAY of those same objects
    //
    // The status lives at payload.packages[0].status in BOTH shapes. The
    // previous code only handled the array shape and read `payload.status`,
    // which does not exist, so a single-order fetch always returned an empty
    // orderStatus even when the order was PROCESSING or COMPLETED.
    //
    // Check every shape defensively: the provider has been known to add
    // fields, and a status that silently comes back null is far worse than a
    // slightly wider lookup.
    const payload = data?.payload;
    const providerOrder = Array.isArray(payload) ? payload[0] : payload;
    const rawStatus =
      providerOrder?.status ??
      providerOrder?.packages?.[0]?.status ??
      providerOrder?.packages?.map((p: { status?: string }) => p?.status) ??
      null;

    // Never let the provider's success boolean become an order status.
    const providerOrderStatus = isRealStatus(rawStatus)
      ? rawStatus.trim()
      : null;

    // ---------------------------------------------------------------------
    // PERSIST TO THE DATABASE
    // ---------------------------------------------------------------------
    // Previously the ONLY writer of `jehuca_order_status` was the client, in
    // HistoryScreen, which meant the database only learned a status when a
    // user happened to open that screen - and admin reports, super-agent
    // views and any other consumer read whatever stale value was last
    // written. The provider status is now written here, server-side, by the
    // one component that is guaranteed to see it.
    //
    // Ownership is resolved FIRST: an unauthenticated caller must not be able
    // to write to arbitrary rows, and an order belonging to someone else must
    // not be readable at all.
    const syncResult = await syncProviderStatus({
      admin,
      identity,
      orderId,
      providerOrderStatus,
      providerResponse: data,
    });

    if (syncResult.forbidden) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "This order belongs to another account",
        }),
        {
          status: 403,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    return new Response(
      JSON.stringify({
        ...scrubProviderPayload(data),
        providerOrderStatus,
        orderStatus: providerOrderStatus,
        // Echo what was written so the client can update its local row
        // without a second round trip.
        synced: syncResult.updated,
        synced_rows: syncResult.rows,
      }),
      {
        status: response.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("Error fetching order status:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to fetch order status",
        details: (error as Error).message,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
