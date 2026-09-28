// WCAG relative-luminance contrast check for the DataScreen hero.
//
// The bug: the hero photo is painted under `adScrim`, an 88%-opaque near-black
// overlay that is deliberately dark in BOTH schemes. Light mode still coloured
// the hero text with `c.textPrimary` (#0B1F1E, near-black), so the title sat at
// ~1.1:1 against the scrim - unreadable.
//
//   node supabase/scripts/check-data-hero-contrast.cjs
//
// Parses theme.js for the real token values, so it fails if a palette change
// makes the hero unreadable again.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

const themeSrc = fs.readFileSync(
  path.join(ROOT, "src/components/theme.js"),
  "utf8",
);
const dataSrc = fs.readFileSync(
  path.join(ROOT, "src/screens/DataScreen.js"),
  "utf8",
);

// Pull `name: "value"` pairs out of a palette object literal.
//
// The block must be BOUNDED: `light` and `dark` share key names, so slicing to
// the end of the file would let `dark` overwrite every `light` token and the
// light-mode checks would silently assert against dark-mode values.
function tokens(block) {
  const out = {};
  const start = themeSrc.indexOf(`const ${block} = {`);
  assert.ok(start !== -1, `could not find the ${block} palette in theme.js`);
  // The palette ends at the next top-level `const` declaration.
  const rest = themeSrc.slice(start);
  const end = rest.slice(1).search(/\nconst \w/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  for (const m of body.matchAll(/(\w+):\s*("(?:[^"]*)"|#[0-9A-Fa-f]{3,8})/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

function toRgb(value) {
  let hex = String(value).replace(/"/g, "");
  if (hex.startsWith("rgba")) {
    const [r, g, b, a] = hex.slice(5, -1).split(",").map(parseFloat);
    return { r, g, b, a };
  }
  hex = hex.replace("#", "");
  if (hex.length === 3)
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

// Flatten `fg` (possibly translucent) onto an opaque `bg`.
function flatten(fg, bg) {
  const f = toRgb(fg);
  const b = toRgb(bg);
  return {
    r: f.r * f.a + b.r * (1 - f.a),
    g: f.g * f.a + b.g * (1 - f.a),
    b: f.b * f.a + b.b * (1 - f.a),
  };
}

function ratio(fg, bg) {
  const a = luminance(flatten(fg, bg));
  const b = luminance(toRgb(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokens("light");
const dark = tokens("dark");

// Worst case for the backdrop: the scrim is 88% opaque, so up to 12% of the
// carrier photo shows through. Carrier art is dark, but assume the palest
// plausible photo (#FFFFFF) so the check fails safe rather than optimistic.
const PHOTO = "#FFFFFF";
const scrimmed = (t) => flatten(t.adScrim, PHOTO);
const HERO_ACCENT = "#5CF0C8";

for (const scheme of ["light", "dark"]) {
  const t = scheme === "light" ? light : dark;
  const backdrop = scrimmed(t);
  const asHex = `#${[backdrop.r, backdrop.g, backdrop.b]
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("")}`;

  const title = ratio(t.heroText, asHex);
  const dim = ratio(t.heroTextDim, asHex);
  const accent = ratio(HERO_ACCENT, asHex);

  console.log(
    `[${scheme}] backdrop ${asHex} -> title ${title.toFixed(2)}:1, ` +
      `subtitle ${dim.toFixed(2)}:1, count ${accent.toFixed(2)}:1`,
  );

  // 22px / 12.5px / 11.5px are all "normal text" to WCAG, so all need 4.5:1.
  assert.ok(
    title >= 4.5,
    `[${scheme}] hero title ${title.toFixed(2)}:1 < 4.5:1`,
  );
  assert.ok(
    dim >= 4.5,
    `[${scheme}] hero subtitle ${dim.toFixed(2)}:1 < 4.5:1`,
  );
  assert.ok(
    accent >= 4.5,
    `[${scheme}] hero count ${accent.toFixed(2)}:1 < 4.5:1`,
  );

  // Pin the regression: light mode's own text colour was the thing that failed.
  if (scheme === "light") {
    const legacy = ratio(t.textPrimary, asHex);
    console.log(
      `[${scheme}] old textPrimary on the same backdrop: ${legacy.toFixed(2)}:1 (the bug)`,
    );
    assert.ok(
      legacy < 4.5,
      "light textPrimary unexpectedly passes now - re-check the premise",
    );
  }
}

// The hero must stay scrim-aware, or the fix silently reverts on a palette tweak.
assert.ok(
  dataSrc.includes("heroImage ? c.heroText : c.textPrimary"),
  "hero text must be scrim-aware, not scheme-only",
);
assert.ok(/color: heroText/.test(dataSrc), "heroTitle must consume heroText");
assert.ok(
  /color: heroTextDim/.test(dataSrc),
  "heroSubtitle must consume heroTextDim",
);
assert.ok(
  /color: heroAccent/.test(dataSrc),
  "heroCount must consume heroAccent",
);

console.log("\nAll contrast checks passed.");
