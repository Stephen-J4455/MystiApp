// Verifies the complaint message and the wa.me link it produces. Run with:
//   node supabase/scripts/check-complaint-message.cjs
//
// Loads the real source files by TRANSFORMING their module syntax, not by
// importing them: the app's own imports are extensionless (Metro resolves
// those) and plain Node ESM will not, and `Module._resolveFilename` does not
// apply to ESM at all. Rewriting `import`/`export` to CommonJS means the body
// actually under test is the shipped body, not a copy of it.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

function toCommonJs(code) {
  // Each `export const X =` becomes `const X =` PLUS a line appending X to a
  // collector, so the named exports survive the round trip into CommonJS.
  const collected = [];
  const out = code
    .replace(
      /^import \{([^}]+)\} from "([^"]+)";$/gm,
      'const {$1} = require("$2");',
    )
    .replace(/^export const (\w+) =/gm, (_, name) => {
      collected.push(name);
      return `const ${name} =`;
    })
    .replace(/^export function (\w+)\(/gm, (_, name) => {
      collected.push(name);
      return `function ${name}(`;
    })
    .replace(/^export default /gm, "module.exports.default = ");

  if (collected.length) {
    return `${out}\nmodule.exports = { ${collected.join(", ")} };\n`;
  }
  return out;
}

const reactNativeStub = {
  Linking: {
    openURL: async () => {},
    canOpenURL: async () => true,
  },
};

/** Evaluates a transformed module, returning the named exports it declared. */
function load(file, deps = {}) {
  const code = toCommonJs(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const module = { exports: {} };
  const requireShim = (id) => {
    if (id === "react-native") return reactNativeStub;
    if (deps[id]) return deps[id];
    throw new Error(`Unexpected require: ${id}`);
  };
  // eslint-disable-next-line no-new-func
  new Function("require", "module", code)(requireShim, module);
  return module.exports;
}

const whatsapp = load("src/lib/whatsapp.js");
const complaints = load("src/lib/complaints.js", { "./whatsapp": whatsapp });

const { buildComplaintMessage, buildComplaintLink } = complaints;

const heldSubAgentOrder = {
  id: 4211,
  status: "held",
  jehuca_order_status: "PROCESSING",
  jehuca_order_id: "JEH-99231",
  offer_title: "MTN - 5GB Data Bundle",
  network: "mtn",
  amount: 120,
  recipient_phone: "0532973455",
  created_at: "2026-09-27T10:30:00Z",
  payment_reference: "ps_ref_abc123",
  orderType: "agent",
  isSubAgentTransaction: true,
};

const message = buildComplaintMessage(
  heldSubAgentOrder,
  "not_delivered",
  "Customer says nothing arrived after 3 hours.",
);

console.log("=== MESSAGE ===");
console.log(message);
console.log("\n=== LINK (truncated) ===");
const link = buildComplaintLink(heldSubAgentOrder, "not_delivered", "x");
console.log(`${link.slice(0, 130)}...`);

// The facts an admin would otherwise have to ask for must all be present.
for (const expected of [
  "Order ID: 4211",
  "MTN - 5GB Data Bundle",
  "Ghc 120.00",
  "0532973455",
  "Our status: held",
  "Provider status: PROCESSING",
  "ps_ref_abc123",
  "Reason: Data not delivered",
  "Customer says nothing arrived after 3 hours.",
]) {
  assert.ok(message.includes(expected), `message is missing: ${expected}`);
}

// Both statuses are sent deliberately - they disagree in practice, and
// sending only one sends the admin looking in the wrong place.
assert.ok(message.includes("Our status: held"));
assert.ok(message.includes("Provider status: PROCESSING"));

// The link must be a real click-to-chat URL: wa.me host, bare digits, and a
// percent-encoded body (a raw newline in a query string truncates it).
assert.ok(
  link.startsWith("https://wa.me/233532973455?text="),
  `bad link base: ${link.slice(0, 60)}`,
);
assert.ok(!link.includes("\n"), "link body must not contain raw newlines");
assert.ok(link.includes("%0A"), "newlines must be percent-encoded");
assert.ok(
  !link.includes("45GU7PROOYDFE1"),
  "the Paystack subaccount code must never be used as a WhatsApp number",
);

// Typed detail is optional.
const noDetail = buildComplaintMessage(heldSubAgentOrder, "refund", "");
assert.ok(!noDetail.includes("Details from the super agent"));
assert.ok(noDetail.includes("Reason: Request a refund"));

// A row with almost no fields must not throw or emit "undefined".
const sparse = buildComplaintMessage({ id: 7 }, "other", "");
assert.ok(sparse.includes("Order ID: 7"));
assert.ok(!sparse.includes("undefined"), "sparse row leaked an undefined");

// An unknown reason id must degrade to a readable label, not "undefined".
const unknownReason = buildComplaintMessage(heldSubAgentOrder, "nope", "");
assert.ok(
  !unknownReason.includes("undefined"),
  "unknown reason leaked undefined",
);

// --- Regression: the message actually reaches the chat -----------------------
// Three separate defects shipped together, each of which alone emptied the
// report. Any one of them reopening is a silent data loss, so pin all three.

// 1. `wa.me/message/<businessId>` DROPS ?text= in its redirect. Only the
//    phone-number form carries the body.
assert.ok(
  !link.includes("/message/"),
  "the wa.me/message/<id> form silently discards ?text=; use a phone number",
);

// 2. The destination number must be the one the caller passed. The wrappers
//    used to call buildWhatsAppLink/openWhatsApp with only the MESSAGE, so the
//    complaint body was passed off as the number and vanished.
assert.ok(
  buildComplaintLink(heldSubAgentOrder, "other", "").startsWith(
    `https://wa.me/${whatsapp.SUPPORT_WHATSAPP}?text=`,
  ),
  "the complaint link must address the support number",
);

// 3. A local Ghanaian number must be normalised to international digits.
//    wa.me passes "0501703777" through verbatim as phone=0501703777, which
//    matches no account, so the chat never opens.
const { toInternationalNumber, ADMIN_WHATSAPP, buildWhatsAppLink } = whatsapp;
const cases = [
  ["0501703777", "233501703777"],
  ["+233 50 170 3777", "233501703777"],
  ["00233532973455", "233532973455"],
  ["233532973455", "233532973455"],
];
for (const [input, expected] of cases) {
  assert.strictEqual(
    toInternationalNumber(input),
    expected,
    `${input} should normalise to ${expected}`,
  );
}
assert.ok(
  buildWhatsAppLink(ADMIN_WHATSAPP, "Hi").startsWith(
    "https://wa.me/233501703777?text=",
  ),
  "the admin number must resolve to an international wa.me link",
);

// A missing number must fail loudly rather than deep-linking to wa.me/,
// which WhatsApp answers with a generic page instead of a chat.
assert.throws(
  () => buildWhatsAppLink("", "Hi"),
  /destination number/,
  "an empty number must not produce a chatless link",
);

console.log("\nAll checks passed.");
