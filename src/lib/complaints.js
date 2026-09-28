import { SUPPORT_WHATSAPP, buildWhatsAppLink, openWhatsApp } from "./whatsapp";

export const COMPLAINT_REASONS = [
  { id: "not_delivered", label: "Data not delivered" },
  { id: "wrong_bundle", label: "Wrong bundle or size received" },
  { id: "pending_too_long", label: "Order still pending" },
  { id: "held_order", label: "Order stuck in held" },
  { id: "payment_issue", label: "Payment or wallet issue" },
  { id: "refund", label: "Request a refund" },
  { id: "other", label: "Something else" },
];

const REASON_LABEL = (id) =>
  COMPLAINT_REASONS.find((r) => r.id === id)?.label || "Other issue";

const money = (value) => `Ghc ${Number(value || 0).toFixed(2)}`;

const formatWhen = (value) => {
  if (!value) return "unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * Builds the complaint text for one order.
 *
 * Everything the admin would otherwise have to ask for is included up front:
 * the order id (which is what they will look up), what it cost, who it was for,
 * and the status both as WE recorded it and as the PROVIDER reports it. The
 * two differ in practice - `resolveOrderStatus` exists precisely because a row
 * can carry a provider status that contradicts our internal one - so sending
 * only one of them can send the admin looking in the wrong place.
 *
 * `extra` is appended verbatim as the user's own words. A typed complaint is
 * usually the most valuable line in the message, so it goes last, clearly
 * separated, and is labelled rather than blended into the facts.
 *
 * @param {object} order    an `orders` / `agent_orders` / ledger row
 * @param {string} reasonId one of COMPLAINT_REASONS[].id
 * @param {string} [extra]  free text typed by the super agent
 * @returns {string} the message body
 */
export const buildComplaintMessage = (order, reasonId, extra) => {
  const lines = [];

  lines.push("COMPLAINT FROM A SUPER AGENT");
  lines.push("");

  if (order?.id != null) {
    lines.push(`Order ID: ${order.id}`);
  }

  // Which table the row lives in, because the admin looks them up in different
  // places. Derived from the same marker the rest of the app uses; a bare row
  // with no marker is assumed to be an agent order, which is the case the
  // complaint flow is actually for.
  const source =
    order?.orderType === "regular"
      ? "Customer order"
      : order?.source === "wallet_topup"
        ? "Wallet top-up"
        : "Agent order";
  lines.push(`Source: ${source}`);

  if (order?.offer_title) lines.push(`Package: ${order.offer_title}`);
  if (order?.network)
    lines.push(`Network: ${String(order.network).toUpperCase()}`);

  const amount = order?.amount ?? order?.gross_amount ?? order?.base_amount;
  if (amount != null) lines.push(`Amount: ${money(amount)}`);

  if (order?.recipient_phone) lines.push(`Recipient: ${order.recipient_phone}`);
  if (order?.phone && !order?.recipient_phone)
    lines.push(`Phone: ${order.phone}`);

  lines.push(`Placed: ${formatWhen(order?.created_at)}`);

  if (order?.status) lines.push(`Our status: ${order.status}`);
  if (order?.jehuca_order_status) {
    lines.push(`Provider status: ${order.jehuca_order_status}`);
  }
  if (order?.jehuca_order_id)
    lines.push(`Provider order: ${order.jehuca_order_id}`);

  if (order?.payment_reference) {
    lines.push(`Payment reference: ${order.payment_reference}`);
  }

  lines.push("");
  lines.push(`Reason: ${REASON_LABEL(reasonId)}`);

  const detail = String(extra || "").trim();
  if (detail) {
    lines.push("");
    lines.push("Details from the super agent:");
    lines.push(detail);
  }

  lines.push("");
  lines.push("Sent from the Mystiwan E-Business app.");

  return lines.join("\n");
};

/**
 * Full click-to-chat URL, including the encoded message. Exported for tests and
 * for any surface that needs the raw URL (e.g. a copy-to-clipboard fallback).
 */
export const buildComplaintLink = (order, reasonId, extra) =>
  buildWhatsAppLink(
    SUPPORT_WHATSAPP,
    buildComplaintMessage(order, reasonId, extra),
  );

/**
 * Opens the complaint chat.
 *
 * Delegates to `openWhatsApp`, which reports a failure rather than throwing -
 * WhatsApp is frequently absent on Android emulators, on desktop and on web,
 * and the caller needs to tell the user that instead of the tap doing nothing.
 *
 * @returns {Promise<{ok: true} | {ok: false, message: string}>}
 */
export const openComplaintChat = async (order, reasonId, extra) =>
  openWhatsApp(SUPPORT_WHATSAPP, buildComplaintMessage(order, reasonId, extra));
