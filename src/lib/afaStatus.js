// ===========================================================================
// AFA registration status vocabulary
// ===========================================================================
//
// The database status records payment progress separately from AFA review:
// `pending` means payment is outstanding and `processing` means it was paid.
// `approved` is set only after AFA approval. Legacy values remain readable
// during the status migration.

// Recognized canonical statuses and legacy values kept readable during migration.
export const AFA_STATUS_VALUES = Object.freeze([
  "pending",
  "processing",
  "approved",
  "rejected",
  "refunded",
  "cancelled",
  // Legacy database values.
  "pending_payment",
  "pending_processing",
  "paid",
  "active",
]);

const AFA_STATUS_LABELS = {
  pending: "Pending",
  pending_payment: "Pending",
  processing: "Processing",
  pending_processing: "Processing",
  paid: "Processing",
  active: "Processing",
  approved: "Approved",
  rejected: "Rejected",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

export const getAfaStatusLabel = (status) => {
  const key = String(status || "")
    .trim()
    .toLowerCase();
  return AFA_STATUS_LABELS[key] || "Pending";
};

/**
 * The tone a status renders in.
 *
 * Pending and processing share a tone; approved has its own tone.
 */
export const getAfaStatusTone = (status) => {
  const key = String(status || "")
    .trim()
    .toLowerCase();
  if (key === "approved") {
    return { background: "#e6f7ed", text: "#16834A" };
  }
  if (key === "rejected") return { background: "#fdecea", text: "#b42318" };
  if (key === "refunded") return { background: "#f3e8ff", text: "#6b21a8" };
  if (key === "cancelled") return { background: "#f2f4f7", text: "#475467" };
  return { background: "#fff3d6", text: "#9a6700" };
};

/**
 * Whether a registration has not reached a final AFA review outcome.
 */
export const isAfaPending = (status) => {
  const key = String(status || "")
    .trim()
    .toLowerCase();
  return !["approved", "rejected", "refunded", "cancelled"].includes(key);
};

/**
 * The text copied to the clipboard when a user shares their registration.
 *
 * It is deliberately PLAIN TEXT and self-contained: the recipient is often
 * someone checking the details for them, or an AFA agent on the phone, and
 * neither has this app. A label/value layout reads well in a chat message
 * and survives being pasted into anything.
 */
export const buildAfaRegistrationText = (registration) => {
  if (!registration) return "";

  const lines = [
    "AFA REGISTRATION",
    `Status: ${getAfaStatusLabel(registration.status)}`,
    `Name: ${registration.full_name || "N/A"}`,
    `Phone: ${registration.phone || "N/A"}`,
    `ID type: ${registration.id_type || "N/A"}`,
    `ID number: ${registration.id_number || "N/A"}`,
    `Town / City: ${registration.town_city || "N/A"}`,
    `Occupation: ${registration.occupation || "N/A"}`,
    `Amount paid: GHS ${Number(registration.fee_amount || 0).toFixed(2)}`,
    `Payment method: ${
      String(registration.payment_method || "").toUpperCase() || "N/A"
    }`,
    `Reference: ${registration.payment_reference || "N/A"}`,
    `Submitted: ${
      registration.created_at
        ? new Date(registration.created_at).toLocaleString("en-GB")
        : "N/A"
    }`,
  ];

  const details = registration.additional_info?.details;
  if (details) {
    lines.push(`Additional information: ${details}`);
  }

  return lines.join("\n");
};
