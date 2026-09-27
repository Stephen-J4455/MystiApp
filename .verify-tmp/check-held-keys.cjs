// Throwaway validator (never shipped). Cross-checks every `styles.<key>` and
// `c.<token>` used by a screen against the keys the stylesheet factory and the
// palette actually define. A missing key is a silent runtime crash, not a type
// error, and `get_errors` does not catch it.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const SCREEN = "src/screens/SuperAgentHeldOrdersScreen.js";
const UI = "src/components/ui.js";
const THEME = "src/components/theme.js";

const screen = read(SCREEN);
const ui = read(UI);
const theme = read(THEME);

// --- palette tokens ---------------------------------------------------------
// Grab the top-level keys of each `const light = {` / `const dark = {` block.
function paletteKeys(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start === -1) throw new Error(`palette ${name} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open + 1, end);
  const keys = new Set();
  for (const line of body.split("\n")) {
    const m = line.match(/^\s{2}([A-Za-z_$][\w$]*)\s*:/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

const lightKeys = paletteKeys(theme, "light");
const darkKeys = paletteKeys(theme, "dark");
const used = new Set(
  [...screen.matchAll(/\bc\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
);
const badTokens = [...used].filter(
  (t) => !lightKeys.has(t) || !darkKeys.has(t),
);
if (badTokens.length) {
  console.log(
    "FAIL: tokens missing from one or both palettes:",
    badTokens.join(", "),
  );
  console.log(
    "  light-only:",
    [...used].filter((t) => !lightKeys.has(t)),
  );
  console.log(
    "  dark-only:",
    [...used].filter((t) => !darkKeys.has(t)),
  );
} else {
  console.log(
    `OK: all ${used.size} c.<token> references exist in both palettes`,
  );
}

// Hex-alpha suffixes like `${c.mint}1F` only work on a 6-digit hex token.
const hexAlpha = [
  ...screen.matchAll(/\$\{(c\.[A-Za-z_$][\w$]*)\}([0-9A-Fa-f]{2})\b/g),
];
for (const [, tokenRef, alpha] of hexAlpha) {
  const token = tokenRef.slice(2);
  for (const [scheme, keys] of [
    ["light", lightKeys],
    ["dark", darkKeys],
  ]) {
    const m = new RegExp(`${token}:\\s*"(#[0-9A-Fa-f]{3,8})"`).exec(
      scheme === "light"
        ? theme.slice(0, theme.indexOf("const dark = {"))
        : theme,
    );
    if (m && m[1].length !== 7) {
      console.log(
        `FAIL: ${tokenRef}\`...\` -> ${m[1]} is not a 6-digit hex (${scheme}); the alpha suffix is invalid`,
      );
    }
  }
}
console.log(`OK: checked ${hexAlpha.length} hex-alpha colour interpolations`);

// --- style keys -------------------------------------------------------------
// themedStyles() in ui.js contributes the shared ramp; the screen's own factory
// spreads it and then adds keys of its own.
function objectKeys(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const open = source.indexOf("{", source.indexOf("=>", start));
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open + 1, end);
  const keys = new Set();
  for (const line of body.split("\n")) {
    const m = line.match(/^\s{4}([A-Za-z_$][\w$]*)\s*[,:]/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

const baseKeys = objectKeys(ui, "export const themedStyles");
const ownKeys = objectKeys(
  screen,
  "const useHeldStyles = (c, topInset = 0) => {",
);
const defined = new Set([...baseKeys, ...ownKeys]);
const usedKeys = new Set(
  [...screen.matchAll(/\bstyles\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
);
const missing = [...usedKeys].filter((k) => !defined.has(k));
if (missing.length) {
  console.log("FAIL: undefined style keys used:", missing.join(", "));
} else {
  console.log(`OK: all ${usedKeys.size} styles.<key> references are defined`);
}

// Unused keys are not fatal, but a local key shadowing a base key is worth
// surfacing because the spread order decides which one wins.
const shadowed = [...ownKeys].filter((k) => baseKeys.has(k));
if (shadowed.length)
  console.log("note: locally overridden base keys:", shadowed.join(", "));

// --- leftover legacy references --------------------------------------------
const leftovers = [...screen.matchAll(/\bcolors\.[a-zA-Z]+/g)].map((m) => m[0]);
if (leftovers.length) {
  console.log(
    "FAIL: legacy flat-palette references remain:",
    leftovers.join(", "),
  );
} else {
  console.log("OK: no legacy colors.* references remain");
}
if (/\bSafeAreaView\b/.test(screen)) {
  console.log(
    "note: SafeAreaView still referenced - confirm it is intentional",
  );
}

// --- JSX parse --------------------------------------------------------------
const parser = require("@babel/parser");
parser.parse(screen, { sourceType: "module", plugins: ["jsx"] });
console.log("OK: babel parse clean");
