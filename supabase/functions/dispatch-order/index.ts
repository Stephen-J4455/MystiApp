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

// ===========================================================================
// INLINED invocation logger
// ===========================================================================
// Writes one row per call to public.edge_function_logs so the admin app's
// "Edge Logs" screen can show what happened. Inlined rather than imported
// because the Supabase dashboard's "Deploy with upload file" bundles only the
// selected function folder, so a relative import of `../_shared/*` fails to
// resolve on a UI deploy.
//
// WHY THIS EXISTS
// ---------------
// The wallet-order dispatch bug was invisible: this function returned 400, the
// client reported "queued for delivery", and the resulting order row was
// indistinguishable from a legitimate insufficient-balance deferral.
// console.error only reaches Supabase's log drain, which the admin app cannot
// query, so there was nowhere to look that showed the mismatch.
//
// PRIVACY: authorization headers, API keys and tokens are dropped entirely;
// phone numbers, emails and payment references are masked to a length form.
// Numbers are kept verbatim because they are what make a row actionable.
// Never log a raw request body.
// ===========================================================================

const LOG_TABLE = "edge_function_logs";

type ErrorKind =
  | "ok"
  | "unauthorized"
  | "forbidden"
  | "validation"
  | "not_found"
  | "conflict"
  | "provider_deferred"
  | "provider_rejected"
  | "rate_limited"
  | "internal";

interface LogContext {
  requestId: string;
  startedAt: number;
  identity?: { id: string; role: string } | null;
}

const SECRET_KEYS = [
  "authorization",
  "x-api-key",
  "apikey",
  "api_key",
  "key",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "password",
  "private_key",
  "client_secret",
  "service_role",
];

const PII_KEYS = [
  "phone",
  "msisdn",
  "email",
  "full_name",
  "user_name",
  "recipient_name",
  "address",
];

const REFERENCE_KEYS = [
  "reference",
  "payment_reference",
  "paystack_reference",
  "paystack_transaction_id",
  "paystack_subaccount_code",
];

const isSecretKey = (key: string) =>
  SECRET_KEYS.includes(key.trim().toLowerCase());

const isPiiKey = (key: string) =>
  PII_KEYS.some((candidate) => key.trim().toLowerCase().includes(candidate));

const isReferenceKey = (key: string) =>
  REFERENCE_KEYS.some((candidate) =>
    key.trim().toLowerCase().includes(candidate),
  );

/** Masks a value but keeps its shape, so two rows can be told apart. */
const maskValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length === 0) return "";
    return `${value.slice(0, 3)}***(len=${value.length})`;
  }
  // Numbers and booleans are not PII and are the most useful thing to log.
  if (typeof value === "number" || typeof value === "boolean") return value;
  return `[${typeof value}]`;
};

const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return "[max_depth]";
  if (Array.isArray(value)) {
    return {
      __array_len: value.length,
      __items: value.slice(0, 3).map((item) => redact(item, depth + 1)),
    };
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (isSecretKey(key)) output[key] = "[redacted]";
      else if (isPiiKey(key) || isReferenceKey(key))
        output[key] = maskValue(entry);
      else output[key] = redact(entry, depth + 1);
    }
    return output;
  }
  return value;
};

const classifyStatus = (status: number, payload?: unknown): ErrorKind => {
  // 202 here means "queued, not failed". Keep provider_rejected distinct from
  // provider_deferred: the first the provider declined, the second it was
  // unreachable or unfunded. Collapsing them is what let an undeliverable
  // order masquerade as routine.
  if (status === 202) {
    const reason = (payload as { reason?: string } | null)?.reason ?? "";
    if (reason === "provider_rejected") return "provider_rejected";
    return "provider_deferred";
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "validation";
  if (status >= 500) return "internal";
  return "ok";
};

const newRequestId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
};

const MAX_DETAIL_CHARS = 8000;

/** Fire-and-forget: a failed log insert must never change the response. */
const writeLog = async (
  url: string,
  serviceRoleKey: string,
  row: {
    request_id: string;
    user_id: string | null;
    user_role: string | null;
    method: string;
    status_code: number;
    duration_ms: number;
    error_kind: ErrorKind;
    detail: Record<string, unknown>;
  },
) => {
  try {
    if (!url || !serviceRoleKey) return;
    const serialized = JSON.stringify(row.detail ?? {});
    const detail =
      serialized.length > MAX_DETAIL_CHARS
        ? {
            truncated: true,
            original_length: serialized.length,
            preview: serialized.slice(0, MAX_DETAIL_CHARS),
          }
        : (row.detail ?? {});

    const admin = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await admin.from(LOG_TABLE).insert({
      function_name: "dispatch-order",
      ...row,
      detail,
      created_at: new Date().toISOString(),
    });
    if (error) {
      // Usually means migration 20260926_007 has not been applied yet. Loud in
      // the platform logs, silent to the user.
      console.error("[logger] failed to persist log row:", error.message);
    }
  } catch (error) {
    console.error("[logger] unexpected failure:", error);
  }
};

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return { __unparsed_length: text.length };
  }
};

/**
 * Wraps the handler so every invocation is recorded exactly once. Clones the
 * body BEFORE the handler consumes it, and skips OPTIONS so preflight does not
 * double the row count.
 */
const withLogging = async (
  req: Request,
  functionName: string,
  handler: (req: Request, ctx: LogContext) => Promise<Response> | Response,
): Promise<Response> => {
  const url = new URL(req.url);
  const requestId =
    req.headers.get("x-request-id")?.slice(0, 64) || newRequestId();
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  const ctx: LogContext = { requestId, startedAt, identity: null };

  if (req.method === "OPTIONS") return handler(req, ctx);

  let body: unknown;
  try {
    const text = await req.clone().text();
    body = text ? safeJsonParse(text) : undefined;
  } catch {
    body = undefined;
  }

  let response: Response;
  try {
    response = await handler(req, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] unhandled error:`, error);
    void writeLog(supabaseUrl, serviceRoleKey, {
      request_id: requestId,
      user_id: ctx.identity?.id ?? null,
      user_role: ctx.identity?.role ?? null,
      method: req.method,
      status_code: 500,
      duration_ms: Date.now() - startedAt,
      error_kind: "internal",
      detail: { body: redact(body), thrown: message },
    });
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    payload = undefined;
  }

  void writeLog(supabaseUrl, serviceRoleKey, {
    request_id: requestId,
    user_id: ctx.identity?.id ?? null,
    user_role: ctx.identity?.role ?? null,
    method: req.method,
    status_code: response.status,
    duration_ms: Date.now() - startedAt,
    error_kind: classifyStatus(response.status, payload),
    detail: { body: redact(body), response: redact(payload) },
  });

  return response;
};

// Dispatches a paid order to the Jehuca provider API.
//
// Called from the customer app immediately after payment, and again from the
// admin app's "Send to Jehuca" action. In both cases the same rules apply:
//
//   1. The admin's provider (Jehuca) account balance must cover the order's
//      cost. If it does not, the order is left in 'pending' and flagged as
//      deferred rather than failed, so the admin can top up the provider
//      account and retry later without the customer paying again.
//   2. Once the provider accepts, the order moves to 'processing'.
//
// The customer is never charged again on a retry: the payment is already
// settled, only the provider hand-off is retried.

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

const JEHUCA_ORDERS_URL = "https://backend.jehucale-business.com/api/orders";
const JEHUCA_BALANCE_URL = "https://backend.jehucale-business.com/api/balance";

const normalizeProviderType = (value: string) => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (!normalized) return "";
  if (normalized.includes("BIG TIME")) return "BIG TIME";
  if (normalized.includes("ISHARE")) return "ISHARE";
  return normalized.split(/[(-]/)[0].trim();
};

const toMilliGb = (value: number) => Math.round(value * 1000);

// Pulls a usable balance number out of the provider response. The provider has
// used both a scalar and a { data: { balance } } shape, so try the common
// places rather than assuming one.
const extractBalance = (payload: unknown): number => {
  const record = (payload || {}) as Record<string, unknown>;
  const candidates: unknown[] = [
    record.balance,
    record.available_balance,
    record.wallet_balance,
    (record.data as Record<string, unknown> | undefined)?.balance,
    (
      (record.data as Record<string, unknown> | undefined)?.data as
        | Record<string, unknown>
        | undefined
    )?.balance,
    (record.payload as Record<string, unknown> | undefined)?.balance,
  ];

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  return Number.NaN;
};

// `ctx` carries the request id and the resolved identity; see _shared/logger.ts.
Deno.serve((req) =>
  withLogging(req, "dispatch-order", async (req, ctx) => {
    if (req.method === "OPTIONS")
      return new Response("ok", { headers: corsHeaders });

    try {
      const apiKey = Deno.env.get("JEHUCA_API_KEY");
      if (!apiKey)
        return respond({ error: "Provider API is not configured" }, 500);

      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
      const serviceRoleKey =
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? supabaseAnonKey;
      if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
        return respond(
          { error: "Supabase service configuration is missing" },
          500,
        );
      }

      const authHeader = req.headers.get("Authorization");
      if (!authHeader)
        return respond({ error: "Missing authorization token" }, 401);

      // Role and ownership now come from `public.user_profiles` via the shared
      // resolver, not from `user_metadata.role`. The previous check read
      // `user.user_metadata?.role` FIRST, and that field is writable by the user
      // through `supabase.auth.updateUser` - so any caller could have declared
      // themselves an admin and dispatched (or re-dispatched) anybody's order.
      const clients = getSupabaseClients(authHeader);

      let identity: Identity;
      try {
        identity = await resolveIdentity(clients);
      } catch {
        return respond({ error: "Unauthorized" }, 401);
      }

      if (identity.profileMissing) {
        // Fail closed, but leave a trail: this is the signature of an account
        // created before the on_auth_user_created trigger existed.
        console.warn(
          "[Dispatch] No user_profiles row; defaulted to sub_agent:",
          identity.id,
        );
      }
      ctx.identity = { id: identity.id, role: identity.role };

      const admin = clients.admin;
      const body = await req.json().catch(() => ({}));

      const orderId = Number(body.order_id);
      const orderType = String(body.order_type || "regular")
        .trim()
        .toLowerCase();
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return respond({ error: "A valid order_id is required" }, 400);
      }
      if (!["regular", "agent"].includes(orderType)) {
        return respond({ error: "order_type must be regular or agent" }, 400);
      }

      const table = orderType === "agent" ? "agent_orders" : "orders";

      const { data: order, error: orderError } = await admin
        .from(table)
        .select("*")
        .eq("id", orderId)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order) return respond({ error: "Order not found" }, 404);

      // A customer may only dispatch their own order. Admins may dispatch any
      // order, which is what powers the retry button.
      const orderOwnerId =
        orderType === "agent"
          ? (order.agent_id as string | null)
          : (order.user_id as string | null);
      if (!identityIsAdmin(identity) && orderOwnerId !== identity.id) {
        return respond({ error: "This order belongs to another account" }, 403);
      }

      if (order.status === "cancelled") {
        return respond({ error: "This order was cancelled" }, 409);
      }

      // Already handed over: report success without creating a duplicate order
      // at the provider.
      if (order.jehuca_order_id) {
        return respond({
          success: true,
          already_dispatched: true,
          status: order.status,
          jehuca_order_id: order.jehuca_order_id,
          jehuca_order_status: order.jehuca_order_status || null,
        });
      }

      const phone =
        orderType === "agent"
          ? String(order.recipient_phone || "")
          : String(order.phone || order.recipient_phone || "");
      const cleanPhone = phone.replace(/\s+/g, "");

      const network = String(order.network || "")
        .trim()
        .toUpperCase();
      const providerPackageId = String(order.provider_package_id || "").trim();
      let providerSize = Number(order.provider_size || 0);
      if (!providerSize) {
        providerSize = Number(
          String(order.data_amount || order.offer_title || "").match(
            /(\d+(?:\.\d+)?)\s*GB/i,
          )?.[1] || 0,
        );
      }
      let providerType = normalizeProviderType(
        String(order.provider_type || "") ||
          String(order.data_amount || order.offer_title || ""),
      );

      if (!providerPackageId || !providerSize || !providerType || !cleanPhone) {
        return respond(
          {
            error:
              "This order is missing provider package details and cannot be sent to the provider",
            details: {
              provider_package_id: providerPackageId,
              provider_size: providerSize,
              provider_type: providerType,
              phone: cleanPhone,
            },
          },
          400,
        );
      }

      // The cost the provider charges. `api_cost` is the snapshot taken at
      // purchase time (live Jehuca price minus any admin discount) and is the
      // authoritative number.
      //
      // `base_amount` is only a fallback: on a normal-user order it is the price
      // the CUSTOMER paid, not what we owe the provider, so using it would
      // under-check the funds we need. Historical orders predate the snapshot and
      // have api_cost = null, so the old chain still applies for them.
      let cost = Number(order.api_cost);
      if (!Number.isFinite(cost) || cost <= 0) {
        cost = Number(order.base_amount || 0);
      }
      if (!Number.isFinite(cost) || cost <= 0) {
        cost = Number(order.amount || 0);
      }

      const balanceResponse = await fetch(JEHUCA_BALANCE_URL, {
        method: "GET",
        headers: { "X-API-Key": apiKey },
      });
      const balancePayload = await balanceResponse.json().catch(() => null);
      const availableBalance = extractBalance(balancePayload);

      if (!Number.isFinite(availableBalance)) {
        // If the balance cannot be read, do not dispatch blindly. Queue the
        // order instead so the admin can retry once the provider account is
        // confirmed to be funded.
        console.error(
          "[Dispatch] Could not read provider balance:",
          balancePayload,
        );
        await admin
          .from(table)
          .update({
            status: "pending",
            provider_deferred_at: new Date().toISOString(),
            provider_deferred_reason: "balance_check_failed",
            provider_dispatch_attempts:
              Number(order.provider_dispatch_attempts || 0) + 1,
          })
          .eq("id", order.id);

        return respond(
          {
            success: false,
            deferred: true,
            reason: "balance_check_failed",
            error:
              "Could not confirm the provider account balance. The order was queued for retry.",
          },
          202,
        );
      }

      if (availableBalance < cost) {
        await admin
          .from(table)
          .update({
            status: "pending",
            provider_deferred_at: new Date().toISOString(),
            provider_deferred_reason: "insufficient_api_balance",
            provider_dispatch_attempts:
              Number(order.provider_dispatch_attempts || 0) + 1,
          })
          .eq("id", order.id);

        console.warn("[Dispatch] Provider balance too low, order queued:", {
          order_id: order.id,
          available_balance: availableBalance,
          required: cost,
        });

        return respond(
          {
            success: false,
            deferred: true,
            reason: "insufficient_api_balance",
            available_balance: availableBalance,
            required: cost,
            error:
              "The provider account needs a top-up before this order can be sent.",
          },
          202,
        );
      }

      const providerResponse = await fetch(JEHUCA_ORDERS_URL, {
        method: "POST",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          packages: [
            {
              packageId: providerPackageId,
              size: toMilliGb(providerSize),
              network,
              type: providerType,
              phone: cleanPhone,
            },
          ],
        }),
      });
      const providerData = await providerResponse.json().catch(() => null);
      const accepted = providerResponse.ok && providerData?.status === true;

      if (!accepted) {
        await admin
          .from(table)
          .update({
            status: "pending",
            provider_deferred_at: new Date().toISOString(),
            provider_deferred_reason: "provider_rejected",
            jehuca_response: providerData ?? null,
            provider_dispatch_attempts:
              Number(order.provider_dispatch_attempts || 0) + 1,
          })
          .eq("id", order.id);

        console.error("[Dispatch] Provider rejected the order:", {
          order_id: order.id,
          http_status: providerResponse.status,
          provider_data: providerData,
        });

        return respond(
          {
            success: false,
            deferred: true,
            reason: "provider_rejected",
            provider_status: providerResponse.status,
            details: providerData,
            error:
              "The provider did not accept this order. It was queued for retry.",
          },
          202,
        );
      }

      // Provider response shape (verified live 2026-09-27):
      //   { status: true, payload: { id: "<uuid>", orderId: "434529",
      //      totalPrice, packages: [ { status, phone, ... } ] } }
      //
      // BOTH ids are valid for `GET /api/orders/{X}` (each returned HTTP 200),
      // so either is safe to persist - but they must be READ FROM THE REAL
      // SHAPE. `orderId` is the short human-facing number and is the one the
      // provider's own docs and logs use, so prefer it.
      //
      // The old chain was `payload.orderId || orderId || payload.orders[0].id`.
      // `payload.orders` does not exist (it is `packages`), and the top-level
      // `status` is the success BOOLEAN - so on a response shaped like the one
      // above this resolved to `null` and wrote a NULL `jehuca_order_id`.
      // Every later status check then skipped the row entirely, and any order
      // that did get an id was checked against a 404-prone value.
      const providerPayload = providerData?.payload;
      const jehucaOrderId =
        providerPayload?.orderId ??
        providerData?.orderId ??
        providerPayload?.id ??
        (Array.isArray(providerPayload) ? providerPayload[0]?.orderId : null) ??
        (Array.isArray(providerPayload) ? providerPayload[0]?.id : null) ??
        null;

      // The status is at `payload.packages[0].status`, NOT at the top level -
      // the top-level `status` is the boolean. Writing the boolean here is
      // exactly how six rows came to hold the literal string "true" and
      // rendered as "True" in the transaction history.
      const jehucaOrderStatus =
        (Array.isArray(providerPayload)
          ? providerPayload[0]?.packages?.[0]?.status
          : providerPayload?.packages?.[0]?.status) ??
        (Array.isArray(providerPayload)
          ? providerPayload[0]?.status
          : providerPayload?.status) ??
        "accepted";

      if (!jehucaOrderId) {
        // The provider accepted the order (this branch is only reached when
        // `accepted` is true) but no id could be read. Persisting the status
        // without an id leaves the order permanently untrackable, and the
        // customer is already billed. Record it loudly rather than writing a
        // null id that silently disables all future status checks.
        console.error(
          "[Dispatch] Provider accepted the order but no provider order id could be read:",
          { order_id: order.id, provider_data: providerData },
        );
      }

      // The settlement split is only 'settled' once the money has actually been
            // divided up. For a Sub-Agent order `verify-payment` writes
            // settlement_status = 'pending' at insert, because at that point Paystack
            // has charged the customer but the platform has not yet released the
            // agent's share. A confirmed hand-off to the provider IS that release
            // point, so this is where it becomes 'settled'.
            //
            // This write was missing, which is why the admin Transactions screen
            // showed every Sub-Agent order as "Pending" forever: it renders
            // `settlement_status || status`, and 'pending' was a value nothing ever
            // moved. Only `reorder-held-agent-order` transitioned it, so a reordered
            // held order settled while a perfectly normal dispatched one did not.
            //
            // `orders` has no settlement_status column, so this is agent-only. Guarded
            // rather than assumed so the regular path cannot throw on a column it does
            // not have.
            const settlementPatch =
              orderType === "agent"
                ? { settlement_status: "settled" }
                : {};

            const { error: updateError } = await admin
              .from(table)
              .update({
                status: "processing",
                ...settlementPatch,
                jehuca_order_id: jehucaOrderId,
                jehuca_order_status: jehucaOrderStatus,
                jehuca_response: providerData ?? null,
                provider_deferred_at: null,
                provider_deferred_reason: null,
                provider_dispatch_attempts:
                  Number(order.provider_dispatch_attempts || 0) + 1,
              })
              .eq("id", order.id);

      if (updateError) {
        // The provider already has the order, so record what happened loudly
        // rather than retrying blindly and risking a duplicate purchase.
        console.error(
          "[Dispatch] Order dispatched but the status update failed:",
          { order_id: order.id, jehuca_order_id: jehucaOrderId },
          updateError,
        );
        return respond(
          {
            error:
              "The order reached the provider but its status could not be saved. Do not resend it.",
            jehuca_order_id: jehucaOrderId,
          },
          500,
        );
      }

      // Mirror the provider reference onto the payment record so the customer's
      // transaction history shows the same provider order id.
            //
            // This is ALSO the write the admin Transactions screen was missing. That
            // screen lists `payment_transactions` and renders
            // `settlement_status || status`, and `verify-payment` hardcodes
            // settlement_status = 'pending' for every Sub-Agent order. Nothing
            // transitioned it, so the admin saw "Pending" on Sub-Agent orders
            // permanently - and a manual admin status change could not fix it either,
            // because the admin edits `agent_orders.status`, a different column on a
            // different table.
            //
            // So the two writers now agree: the order row and its ledger row are both
            // settled by the same confirmed hand-off.
            const paymentReference = String(order.payment_reference || "").trim();
            if (paymentReference) {
              const { error: txError } = await admin
                .from("payment_transactions")
                .update({
                  jehuca_order_id: jehucaOrderId,
                  jehuca_order_status: jehucaOrderStatus,
                  jehuca_response: providerData ?? null,
                  // Agent-only, for the same reason as above: a normal-user order is
                  // already written as 'settled' by verify-payment and a wallet order
                  // as 'settled' too, so re-writing it would be a no-op. Restricting
                  // the write keeps it a pure bug fix for the broken case.
                  ...(orderType === "agent" ? { settlement_status: "settled" } : {}),
                })
                .eq("payment_reference", paymentReference);
        if (txError) {
          console.warn(
            "[Dispatch] Could not update payment_transactions:",
            txError.message,
          );
        }
      }

      return respond({
        success: true,
        deferred: false,
        status: "processing",
        jehuca_order_id: jehucaOrderId,
        jehuca_order_status: jehucaOrderStatus,
      });
    } catch (error) {
      console.error(
        "[Dispatch] Unexpected error:",
        error instanceof Error ? error.message : error,
      );
      return respond(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Unexpected server error",
        },
        500,
      );
    }
  }),
);
