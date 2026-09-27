// Verifies ComplaintSheet references only real palette tokens and style keys.
// get_errors does NOT catch either - both are silent runtime failures
// (a missing style key is `undefined`, not a TypeError).
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const theme = fs.readFileSync("src/components/theme.js", "utf8");

function paletteKeys(name) {
  const start = theme.indexOf(`const ${name} = {`);
  if (start === -1) return null;
  const keys = new Set();
  let depth = 0;
  let inBody = false;
  for (const line of theme.slice(start).split("\n")) {
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
        inBody = true;
      } else if (ch === "}") {
        depth -= 1;
        if (inBody && depth === 0) return keys;
      }
    }
    const m = line.match(/^  (\w+):/);
    if (m && depth === 1) keys.add(m[1]);
  }
  return keys;
}

const light = paletteKeys("light");
const dark = paletteKeys("dark");
console.log(`light keys: ${light.size}, dark keys: ${dark.size}`);

const onlyLight = [...light].filter((k) => !dark.has(k));
console.log(`in light but not dark: ${onlyLight.join(", ") || "none"}`);
assert.deepStrictEqual(onlyLight, [], "palettes have drifted apart");

// Style keys defined by the shared ramp.
const ui = fs.readFileSync("src/components/ui.js", "utf8");
const rampKeys = new Set([...ui.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));

const files = [
  "src/components/ComplaintSheet.js",
  "src/lib/complaints.js",
  "src/lib/whatsapp.js",
];

let problems = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");

  // Local factory keys, where the file defines one.
  const localKeys = new Set();
  const lm = src.match(/=>\s*\{([\s\S]*?)\n\};?\s*$/);
  if (lm) {
    for (const m of lm[1].matchAll(/^ {4}(\w+):/gm)) localKeys.add(m[1]);
  }
  // Also catch the `{ ...base, ... }` object-literal factories.
  const lm2 = src.match(/return\s*\{([\s\S]*?)\n\s*\};/);
  if (lm2) {
    for (const m of lm2[1].matchAll(/^ {4}(\w+):/gm)) localKeys.add(m[1]);
  }

  const usedStyles = new Set([...src.matchAll(/\bs\.(\w+)/g)].map((m) => m[1]));
  const badStyles = [...usedStyles].filter(
    (k) => !rampKeys.has(k) && !localKeys.has(k),
  );

  const usedTokens = new Set([...src.matchAll(/\bc\.(\w+)/g)].map((m) => m[1]));
  const badTokens = [...usedTokens].filter(
    (k) => !light.has(k) || !dark.has(k),
  );

  // Any `${c.x}NN` tint must target a 6-digit hex in BOTH palettes.
  const badTints = [];
  for (const [, tok] of src.matchAll(/\$\{c\.(\w+)\}([0-9A-Fa-f]{1,2})\b/g)) {
    if (!light.has(tok) || !dark.has(tok)) badTints.push(tok);
  }

  const issues = [];
  if (badStyles.length)
    issues.push(`MISSING STYLE KEYS: ${badStyles.join(", ")}`);
  if (badTokens.length) issues.push(`MISSING TOKENS: ${badTokens.join(", ")}`);
  if (badTints.length) issues.push(`BAD TINT TARGETS: ${badTints.join(", ")}`);
  if (issues.length) problems += 1;

  console.log(
    `${path.basename(f).padEnd(26)} ${issues.length ? issues.join(" | ") : `ok (${usedStyles.size} styles, ${usedTokens.size} tokens)`}`,
  );
}

console.log(
  problems === 0 ? "\nNo problems." : `\n${problems} file(s) with problems.`,
);
process.exit(problems === 0 ? 0 : 1);
