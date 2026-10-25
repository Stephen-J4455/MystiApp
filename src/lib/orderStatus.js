// ===========================================================================
// Order status resolution
// ===========================================================================
// One order carries TWO status columns, and they are not the same thing:
//
//   `status`              - OUR internal state. Always written, always one of
//                           ORDER_STATUS_OPTIONS (pending, processing,
//                           completed, delivered, refunded, failed, expired,
//                           cancelled) plus the two lifecycle states the app
//                           owns itself: "held" and "expired".
//   `<provider>_order_status` - the PROVIDER's state, mirrored separately for
//                               Jehuca and Bisdel. It can be blank, and older
//                               rows may contain the provider's success
//                               BOOLEAN instead of an order status.
//
// The bug this module exists to prevent
// --------------------------------------
// Both screens used to resolve the displayed status with a plain `||`:
//
//     provider_order_status || status
//
// `||` only skips a FALSY value, and the string "true" is truthy. So a row
// carrying the corrupt boolean would select "true", fail the real-status test,
// and render "Unknown" - while the perfectly good internal `status` sitting
// in the very next field was never even looked at. The customer saw Unknown
// for an order we knew was completed.
//
// The fix is to select the first status that is actually REAL, not the first
// one that is merely non-empty. `resolveOrderStatus` does that in one place so
// the history card, the receipt, and any future screen cannot drift apart
// again.
//
// Why "Unknown" is still the right last resort: an order whose provider status
// has aged out of the ~10-order retention window, and whose internal status is
// also blank, genuinely has no recoverable status. "Unknown" is honest; a
// boolean is not.

/**
 * True when `value` can be trusted as a status string.
 *
 * Rejects booleans, blank strings, and non-strings. Six `agent_orders` rows
 * were written with the literal string "true" (the provider's success
 * boolean), and this guard is what stops that being persisted or displayed
 * ever again.
 */
export const isRealStatus = (status) => {
  if (typeof status !== "string") return false;
  const trimmed = status.trim();
  if (!trimmed) return false;
  return !/^(true|false)$/i.test(trimmed);
};

export const getProviderOrderStatusColumn = (providerName) =>
  String(providerName || "jehuca").trim().toLowerCase() === "bisdel"
    ? "bisdel_order_status"
    : "jehuca_order_status";

export const getProviderOrderStatus = (order) =>
  order?.[getProviderOrderStatusColumn(order?.provider_name)];

/**
 * Picks the status to show for an order row.
 *
 * The internal status wins when it is real. It represents Mysti's order
 * lifecycle (for example, processing once a provider accepts an order), while
 * the provider status is kept separately as the provider's fulfillment state.
 * The provider value is only a fallback when the internal status is absent.
 *
 * @param {object|null} order an `orders` or `agent_orders` row
 * @returns {string|null} a status string, or null when neither field is real
 */
export const resolveOrderStatus = (order) => {
  const internal = order?.status;
  if (isRealStatus(internal)) return internal.trim();

  const provider = getProviderOrderStatus(order);
  if (isRealStatus(provider)) return provider.trim();

  return null;
};

/**
 * Human-readable label for a status.
 *
 * Mirrors the admin app's `getOrderStatusLabel` so a customer and an admin
 * looking at the same order read the same word.
 */
export const formatOrderStatusLabel = (status) => {
  if (!isRealStatus(status)) return "Unknown";
  const normalized = status.trim();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
};
