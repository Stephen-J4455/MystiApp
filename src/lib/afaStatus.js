// ===========================================================================
// AFA registration status vocabulary
// ===========================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// The `afa_registrations.status` column stores the PAYMENT's state, not the
// REGISTRATION's. `pending_payment` and `active` are what the server writes,
// and both describe money rather than approval:
//
//   pending_payment  - the money has not landed yet
//   active           - the money landed, and the registration is live
//
// A user reading "Pending payment" for a registration they have PAID for
// learns that their money has not gone through - which is wrong, and
// alarming. What they actually want to know is whether the AFA has approved
// them.
//
// So the words the user sees are the registration's real lifecycle:
//
//   Pending processing  - paid for, awaiting the AFA's approval
//   Approved            - approved
//
// THE DATABASE IS NOT REWRITTEN
// -----------------------------
// `active` is the historical value, and rows written before today carry it.
// The mapping lives here, on the READ side, so:
//
//   - every historic row reads correctly without a migration rewriting it, and
//   - the admin app and the customer app cannot disagree about what a value
//     means, because both import the same table.
//
// It also matters that the DATABASE keeps saying `active`: `finalize_afa_
// registration_payment` sets it the moment the PAYMENT clears, which is
// BEFORE the AFA has approved anything. Renaming it to `approved` in the
// database would assert an approval that has not happened.
//
// `pending_processing` and `approved` are also real values - an admin sets
// them from the admin app, which is where a manual approval actually happens.

// The values the server may write, and the two an admin may set directly.
export const AFA_STATUS_VALUES = Object.freeze([
  "pending_payment",
  "pending_processing",
  "paid",
  "active",
  "approved",
  "rejected",
  "refunded",
  "cancelled",
]);

// The words shown to a user, per stored value.
//
// `active` and `approved` both read as "Approved" - `active` is the
// historical name for the same state. `pending_payment` and
// `pending_processing` both read as "Pending processing" - the first means
// "money not in yet", the second "money in, awaiting approval", and neither
// distinction is one the user can act on.
const AFA_STATUS_LABELS = {
  pending_payment: "Pending processing",
  pending_processing: "Pending processing",
  paid: "Pending processing",
  active: "Approved",
  approved: "Approved",
  rejected: "Rejected",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

export const getAfaStatusLabel = (status) => {
  const key = String(status || "")
    .trim()
    .toLowerCase();
  return AFA_STATUS_LABELS[key] || "Pending processing";
};

/**
 * The tone a status renders in.
 *
 * Deliberately keyed on the USER-FACING state, not the stored value, so
 * `active` and `approved` share a colour and `pending_payment` and
 * `pending_processing` share another.
 */
export const getAfaStatusTone = (status) => {
  const key = String(status || "")
    .trim()
    .toLowerCase();
  if (key === "active" || key === "approved") {
    return { background: "#e6f7ed", text: "#16834A" };
  }
  if (key === "rejected") return { background: "#fdecea", text: "#b42318" };
  if (key === "refunded") return { background: "#f3e8ff", text: "#6b21a8" };
  if (key === "cancelled") return { background: "#f2f4f7", text: "#475467" };
  return { background: "#fff3d6", text: "#9a6700" };
};

/**
 * Whether a registration is awaiting the AFA's approval.
 *
 * "Paid for but not approved yet" is the state a user spends the most time
 * in, and the one the copy is written around.
 */
export const isAfaPending = (status) => {
  const key = String(status || "")
    .trim()
    .toLowerCase();
  return !["active", "approved", "rejected", "refunded", "cancelled"].includes(
    key,
  );
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
