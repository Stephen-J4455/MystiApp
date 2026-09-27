// Throwaway validator (never shipped). The fix is entirely in status SELECTION,
// so assert it against every combination of the two status columns that can
// actually occur in the database.
const isRealStatus = (status) => {
  if (typeof status !== "string") return false;
  const trimmed = status.trim();
  if (!trimmed) return false;
  return !/^(true|false)$/i.test(trimmed);
};

const resolveOrderStatus = (order) => {
  const provider = order?.jehuca_order_status;
  if (isRealStatus(provider)) return provider.trim();
  const internal = order?.status;
  if (isRealStatus(internal)) return internal.trim();
  return null;
};

const formatOrderStatusLabel = (status) => {
  if (!isRealStatus(status)) return "Unknown";
  const n = status.trim();
  return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
};

const oldResolve = (order) => order?.jehuca_order_status || order?.status;

const cases = [
  // The regression: the corrupt boolean wins the old `||` and then fails the
  // real-status test, so the customer saw Unknown for a COMPLETED order.
  {
    name: "corrupt boolean + internal completed",
    order: { jehuca_order_status: "true", status: "completed" },
    expect: "completed",
  },
  {
    name: "corrupt 'False' + internal processing",
    order: { jehuca_order_status: "False", status: "processing" },
    expect: "processing",
  },
  {
    name: "boolean with spaces + internal delivered",
    order: { jehuca_order_status: " true ", status: "delivered" },
    expect: "delivered",
  },

  // The normal case: a genuine provider status wins.
  {
    name: "real provider status wins",
    order: { jehuca_order_status: "COMPLETED", status: "processing" },
    expect: "COMPLETED",
  },
  {
    name: "real provider PROCESSING wins",
    order: { jehuca_order_status: "PROCESSING", status: "pending" },
    expect: "PROCESSING",
  },

  // Provider status absent -> internal status is used.
  {
    name: "null provider + internal cancelled",
    order: { jehuca_order_status: null, status: "cancelled" },
    expect: "cancelled",
  },
  {
    name: "blank provider + internal failed",
    order: { jehuca_order_status: "", status: "failed" },
    expect: "failed",
  },
  {
    name: "whitespace provider + internal refunded",
    order: { jehuca_order_status: "   ", status: "refunded" },
    expect: "refunded",
  },
  {
    name: "undefined provider + internal pending",
    order: { status: "pending" },
    expect: "pending",
  },

  // The app's own lifecycle states, which have no provider mirror.
  {
    name: "held (awaiting reorder)",
    order: { jehuca_order_status: null, status: "held" },
    expect: "held",
  },
  {
    name: "expired (24h sweep)",
    order: { jehuca_order_status: null, status: "expired" },
    expect: "expired",
  },
  {
    name: "success (reorder writes this)",
    order: { jehuca_order_status: null, status: "success" },
    expect: "success",
  },

  // Genuinely nothing known.
  {
    name: "both empty -> null",
    order: { jehuca_order_status: "", status: "" },
    expect: null,
  },
  {
    name: "both null -> null",
    order: { jehuca_order_status: null, status: null },
    expect: null,
  },
  { name: "no order at all", order: null, expect: null },
  {
    name: "both corrupt booleans -> null",
    order: { jehuca_order_status: "true", status: "false" },
    expect: null,
  },

  // Non-string types must not be coerced.
  {
    name: "boolean true in provider",
    order: { jehuca_order_status: true, status: "completed" },
    expect: "completed",
  },
  {
    name: "number in provider",
    order: { jehuca_order_status: 1, status: "processing" },
    expect: "processing",
  },
];

let failures = 0;
for (const c of cases) {
  const got = resolveOrderStatus(c.order);
  const ok = got === c.expect;
  if (!ok) failures++;
  const before = oldResolve(c.order);
  const beforeLabel = isRealStatus(before)
    ? formatOrderStatusLabel(before)
    : "Unknown";
  const afterLabel = got ? formatOrderStatusLabel(got) : "Unknown";
  const changed = beforeLabel !== afterLabel ? "   <-- CHANGED" : "";
  console.log(
    `${ok ? "OK  " : "FAIL"}  ${c.name}\n` +
      `        resolved=${JSON.stringify(got)} label=${JSON.stringify(afterLabel)}` +
      `   (old: ${JSON.stringify(before)} label=${JSON.stringify(beforeLabel)})${changed}`,
  );
}
console.log(
  failures ? `\n${failures} FAILURE(S)` : "\nall status-resolution cases pass",
);
process.exit(failures ? 1 : 0);
