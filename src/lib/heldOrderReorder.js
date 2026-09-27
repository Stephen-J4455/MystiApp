// ===========================================================================
// Held order reorder - one implementation, shared by every surface
// ===========================================================================
// WHY THIS IS SHARED
// -------------------
// A held order can be retried from the Home activity list, the Receipt, the
// Transaction History card, and the dedicated Held Orders screen. Each of those
// screens carried its own inline copy of the invoke block, so the elapsed-window
// check, the expiry message, the success copy and the per-row in-flight guard
// were re-implemented per screen and had already begun to drift: the History
// card had no window check at all, so it happily offered "Reorder" on an order
// the server was going to reject.
//
// WHAT A HELD ORDER IS
// --------------------
// NOT an unpaid order. In `verify-payment` the customer's Paystack payment is
// verified and CAPTURED first, and only THEN is the super agent's wallet
// debited for the internal settlement split. `held` therefore means:
//
//     "the customer already paid; our internal wallet debit failed, so the
//      order is parked until the wallet is funded."
//
// Those rows are the ONLY record of real customer cash, and they expire (never
// hard-delete) 24h after the HOLD. See held-orders-are-paid-orders.md.
//
// THE 24 HOUR WINDOW
// ------------------
// A retry is only valid until `held_expires_at`. The database sweep is the
// authority, but it runs hourly, so the client needs its own check: offering
// Reorder on an order that expired two hours ago produces a confusing server
// rejection instead of an honest "window closed".

// Below this the order is treated as expired client-side. Zero grace - expiring
// a few seconds before the server would is confusing, and a few seconds after is
// harmless because the retry would be rejected anyway.
const EXPIRY_GRACE_MS = 0;
const HELD_WINDOW_MS = 24 * 60 * 60 * 1000;

import { supabase } from "./supabase";
import { getEdgeFunctionName } from "./env";
import { getEdgeFunctionErrorMessage } from "./edgeFunctions";

/**
 * The absolute deadline for an order's reorder window, in epoch ms, or null
 * when it cannot be determined.
 *
 * Falls back to `held_at` (else `created_at`) + 24h for rows written before the
 * deadline columns existed, mirroring the database sweep rather than hiding
 * them.
 */
export const getHeldDeadline = (order) => {
  if (order?.held_expires_at) {
    return new Date(order.held_expires_at).getTime();
  }
  const heldSince = order?.held_at || order?.created_at;
  const since = heldSince ? new Date(heldSince).getTime() : NaN;
  return Number.isNaN(since) ? null : since + HELD_WINDOW_MS;
};

/**
 * Milliseconds left in the reorder window, or null when unknown.
 */
export const getHeldRemainingMs = (order, now) => {
  const deadline = getHeldDeadline(order);
  if (deadline == null) return null;
  return Math.max(0, deadline - now);
};

/**
 * True when the reorder window has elapsed.
 *
 * A null deadline returns false, so a row with no usable timestamp is still
 * offered the button rather than being permanently unreachable.
 */
export const isHeldWindowElapsed = (order, now) => {
  const remaining = getHeldRemainingMs(order, now);
  return remaining != null && remaining <= EXPIRY_GRACE_MS;
};

/**
 * True when a row is a held order.
 *
 * A plain status check, used where the caller has already established the row
 * came from `agent_orders`. Prefer `isReorderableHeldOrder`.
 */
export const isHeldOrder = (order) =>
  String(order?.status || "")
    .trim()
    .toLowerCase() === "held";

/**
 * True when this specific row can actually be retried.
 *
 * Two conditions, and the second is easy to get wrong:
 *
 *   1. `status === 'held'`, and
 *   2. the row came from `agent_orders`, NOT `orders`.
 *
 * `status = 'held'` exists on BOTH tables. A super agent's own wallet purchase
 * that failed to debit is written to `orders` as held (see verify-payment's
 * wallet_order branch). But `reorder-held-agent-order` only ever selects from
 * `agent_orders`, so offering Reorder on an `orders` row produces a permanent
 * "Held order not found" 404 - the button would look broken forever with no
 * path to fix it.
 *
 * `orderType` is the marker the screens already set ("agent" for agent_orders,
 * "regular" for orders). It is absent on rows built by SuperAgentHeldOrdersScreen
 * and on raw `.select("*")` results, and absence means "agent_orders" here
 * because that is the only table this function can act on. So the test rejects
 * exactly the `regular` case and nothing else.
 */
export const isReorderableHeldOrder = (order) =>
  isHeldOrder(order) && order?.orderType !== "regular";

/**
 * "23h 59m left" / "4m 12s left" / "Expiring…". Null when unknown.
 */
export const formatHeldRemaining = (ms) => {
  if (ms == null) return null;
  if (ms <= 0) return "Expiring…";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m ${seconds}s left`;
  return `${seconds}s left`;
};

/**
 * True when the signed-in user may retry held orders.
 *
 * `reorder-held-agent-order` returns 403 for anyone who is not a super agent,
 * so a normal customer or sub-agent must never see the button even if a held
 * row somehow reached their history.
 */
export const canReorderHeldOrders = (isSuperAgentUser) =>
  Boolean(isSuperAgentUser);

/**
 * Invokes `reorder-held-agent-order` for one held order.
 *
 * Returns `{ ok: true }` or `{ ok: false, message }` on EVERY failure path, so
 * callers never have to read a thrown error. `message` is already
 * user-facing and is meant to be surfaced verbatim.
 *
 * The window is re-checked here, not only at render time, because the button
 * can sit on screen for the whole countdown and the deadline can pass between
 * the tap and the network round trip. Catching it early turns a server
 * rejection into a clear message.
 */
export const reorderHeldOrder = async (order) => {
  if (!order?.id) {
    return { ok: false, message: "This order could not be found." };
  }

  if (isHeldWindowElapsed(order, Date.now())) {
    return {
      ok: false,
      message:
        "This order passed its 24 hour window and can no longer be reordered.",
    };
  }

  try {
    const functionName = getEdgeFunctionName("reorder-held-agent-order");
    const { data, error } = await supabase.functions.invoke(functionName, {
      body: { order_id: order.id },
    });

    if (error || !data?.success) {
      const message = await getEdgeFunctionErrorMessage(
        error,
        data?.error || "Could not reorder this held order.",
      );
      return { ok: false, message };
    }

    return { ok: true };
  } catch (error) {
    console.error("Held order reorder failed:", error);
    return {
      ok: false,
      message: error?.message || "Could not reorder this order.",
    };
  }
};
