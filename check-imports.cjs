// Dev-only guard: verify every RELATIVE named import in src/screens resolves
// to a real export. Metro happily bundles a missing named import (it becomes
// undefined) and fails only at render time with "undefined is not a function",
// so this catches the class of bug that the bundler and the language server
// both miss.
const fs = require("fs");
const path = require("path");

const ROOTS = [
  "src/screens",
  "src/components",
  "src/contexts",
  "src/lib",
  "src/hooks",
  "src/services",
];

const IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g;

function exportsOf(source) {
  const names = new Set();
  const declRe =
    /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g;
  let m;
  while ((m = declRe.exec(source))) names.add(m[1]);
  const listRe = /export\s*\{([^}]+)\}/g;
  while ((m = listRe.exec(source))) {
    m[1]
      .split(",")
      .map((s) =>
        s
          .trim()
          .split(/\s+as\s+/)
          .pop()
          .trim(),
      )
      .filter(Boolean)
      .forEach((n) => names.add(n));
  }
  return names;
}

let problems = 0;
let checked = 0;

for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    if (!/\.(js|jsx|ts|tsx)$/.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(source))) {
      // Resolve the relative specifier segment by segment. path.resolve() on a
      // Windows mixed path like "src\screens\..\components\ui" does not collapse
      // the "..", so every import reads as a missing file. Imports also omit the
      // extension, so try the JS/TS variants.
      const base = path.dirname(path.resolve(file));
      const basePath = path.normalize(path.join(base, ...m[2].split(/[\\/]/)));
      const CANDIDATES = [
        basePath,
        ...[".js", ".jsx", ".ts", ".tsx", "/index.js", "/index.jsx"].map(
          (ext) => basePath + ext,
        ),
      ];
      const target = CANDIDATES.find((p) => fs.existsSync(p));
      if (!target) {
        console.log(`MISSING FILE  ${file} -> ${m[2]}`);
        problems++;
        continue;
      }
      const available = exportsOf(fs.readFileSync(target, "utf8"));
      for (const raw of m[1].split(",")) {
        const name = raw
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (!name) continue;
        checked++;
        if (!available.has(name)) {
          console.log(
            `MISSING EXPORT  ${file} imports { ${name} } from ${m[2]}`,
          );
          problems++;
        }
      }
    }
  }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...walk(full));
    } else out.push(full);
  }
  return out;
}

console.log(
  problems === 0
    ? `OK - ${checked} relative named imports all resolve`
    : `${problems} problem(s) across ${checked} imports`,
);
process.exit(problems === 0 ? 0 : 1);
