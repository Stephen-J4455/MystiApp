// ===========================================================================
// Receipt number
// ===========================================================================
// There is no `receipt_number` column on `orders` or `agent_orders`, and no
// sequence reserved for one. Rather than add a migration for a cosmetic
// label, the receipt number is DERIVED from the row's own primary key.
//
// Why derived and not a stored column:
//   - `orders.id` and `agent_orders.id` are already unique, monotonic and
//     permanent, so `MYS-12345` is as collision-free as a generated reference
//     would be
//   - a stored column would drift: rows created before it existed would have a
//     NULL, and every read path would need a fallback anyway
//   - it stays readable over the phone. A customer reading `MYS-12345` to
//     support gets a number support can look up in one query, which a 26-char
//     Paystack reference or a UUID is not
//
// The prefix differs by source so support can tell a customer purchase from a
// sub-agent one at a glance, and so a customer cannot quote a number that
// collides with the other table's sequence (both start at 1).
//
// If a real stored sequence is ever wanted, change ONLY `getReceiptNumber` -
// every screen calls this, so nothing else moves.

const PREFIX = {
  // Sub-agent / agent order rows.
  agent: "MYS-AG",
  // Customer `orders` rows.
  order: "MYS",
};

/**
 * @param {object} order  an `orders` or `agent_orders` row
 * @returns {string|null} e.g. "MYS-12345", or null when there is no id
 */
export const getReceiptNumber = (order) => {
  if (!order) return null;
  const id = order.id;
  if (id === null || id === undefined || id === "") return null;
  const prefix =
    order.orderType === "agent" || order.agent_id ? PREFIX.agent : PREFIX.order;
  return `${prefix}-${id}`;
};

/**
 * Same number, split for display: the prefix as a dimmed label and the digits
 * as the value, so a card can emphasise the number without colouring the whole
 * string.
 *
 * Splits on the LAST hyphen, not the first. The agent prefix itself contains
 * one (`MYS-AG-579`), so splitting on the first would yield the nonsense
 * prefix `MYS-` and the value `AG-579`.
 *
 * @returns {{ prefix: string, number: string }|null}
 */
export const splitReceiptNumber = (order) => {
  const full = getReceiptNumber(order);
  if (!full) return null;
  const separator = full.lastIndexOf("-");
  return {
    prefix: full.slice(0, separator + 1),
    number: full.slice(separator + 1),
  };
};
