// Mutation harness. Patches each bug BACK IN, in memory only, and asserts the
// validator actually fails. A regression test that cannot fail is worthless.
//
//   node supabase/scripts/mutation-check-whatsapp.cjs
//
// Nothing here writes to disk: every mutation is a string applied to the
// module source before it is evaluated.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

const MUTANTS = [
  {
    name: "wa.me/message/<id> form (drops ?text=)",
    file: "src/lib/whatsapp.js",
    from: /return `https:\/\/wa\.me\/\$\{phone\}\?text=/,
    to: "return `https://wa.me/message/45GU7PROOYDFE1?text=",
  },
  {
    name: "no number normalisation (local 0XX passes through)",
    file: "src/lib/whatsapp.js",
    from: /const phone = toInternationalNumber\(number\);/,
    to: 'const phone = String(number || "");',
  },
  {
    name: "buildComplaintLink drops the number argument",
    file: "src/lib/complaints.js",
    from: /buildWhatsAppLink\(\s*SUPPORT_WHATSAPP,\s*/,
    to: "buildWhatsAppLink(",
  },
  {
    name: "openComplaintChat drops the number argument",
    file: "src/lib/complaints.js",
    from: /openWhatsApp\(\s*SUPPORT_WHATSAPP,\s*/,
    to: "openWhatsApp(",
  },
];

function toCommonJs(code) {
  const collected = [];
  const out = code
    .replace(
      /^import \{([^}]+)\} from "([^"]+)";$/gm,
      'const {$1} = require("$2");',
    )
    .replace(
      /^export const (\w+) =/gm,
      (_, n) => (collected.push(n), `const ${n} =`),
    )
    .replace(
      /^export function (\w+)\(/gm,
      (_, n) => (collected.push(n), `function ${n}(`),
    );
  return collected.length
    ? `${out}\nmodule.exports = { ${collected.join(", ")} };\n`
    : out;
}

const sources = new Map();
for (const f of ["src/lib/whatsapp.js", "src/lib/complaints.js"]) {
  sources.set(f, fs.readFileSync(path.join(ROOT, f), "utf8"));
}

const validator = fs.readFileSync(
  path.join(__dirname, "check-complaint-message.cjs"),
  "utf8",
);

// Run the real validator against mutated sources by evaluating it with `load`
// bound to our patched map instead of the filesystem.
function runValidator(patched) {
  const shimmed = validator.replace(
    /const code = toCommonJs\(fs\.readFileSync\(path\.join\(ROOT, file\), "utf8"\)\);/,
    "const code = toCommonJs(SOURCES.get(file));",
  );
  const module = { exports: {} };
  const requireShim = (id) => {
    if (id === "react-native")
      return {
        Linking: { openURL: async () => {}, canOpenURL: async () => true },
      };
    if (id === "./whatsapp")
      return loadTransformed(patched.get("src/lib/whatsapp.js"));
    if (id === "node:assert" || id === "node:fs" || id === "node:path")
      return require(id);
    throw new Error(`Unexpected require: ${id}`);
  };
  // The validator derives ROOT from __dirname at load time, so it has to be
  // injected explicitly - a `new Function` body cannot see module scope.
  new Function("require", "module", "SOURCES", "__dirname", shimmed)(
    requireShim,
    module,
    patched,
    __dirname,
  );
}

function loadTransformed(code) {
  const module = { exports: {} };
  new Function("require", "module", toCommonJs(code))((id) => {
    if (id === "react-native")
      return {
        Linking: { openURL: async () => {}, canOpenURL: async () => true },
      };
    return require(id);
  }, module);
  return module.exports;
}

let failed = 0;

// Control: unmutated sources must pass.
try {
  runValidator(new Map(sources));
  console.log("PASS (control)  unmutated sources pass");
} catch (e) {
  failed++;
  console.log(`FAIL (control)  unmutated sources REJECTED: ${e.message}`);
}

// Each mutant must be caught.
for (const m of MUTANTS) {
  const original = sources.get(m.file);
  if (!m.from.test(original)) {
    failed++;
    console.log(
      `FAIL (stale)    "${m.name}" no longer matches ${m.file} - update harness`,
    );
    continue;
  }
  const patched = new Map(sources);
  patched.set(m.file, original.replace(m.from, m.to));
  try {
    runValidator(patched);
    failed++;
    console.log(`FAIL (missed)   "${m.name}" was NOT caught by the validator`);
  } catch (e) {
    console.log(`PASS (caught)   "${m.name}" -> ${e.message.split("\n")[0]}`);
  }
}

console.log(
  `\n${failed === 0 ? "All mutants caught." : `${failed} harness failure(s).`}`,
);
process.exit(failed === 0 ? 0 : 1);
