// Verifies AUTH_ROUTE_NAMES matches the signed-out branch of the navigator in
// App.js. A screen registered as an auth route but missing from the list would
// render WITH the bottom dock over it, which is easy to miss because the
// regression is purely visual.
const assert = require("node:assert");
const fs = require("node:fs");

const app = fs.readFileSync("App.js", "utf8");
const dockNav = fs.readFileSync("src/lib/dockNav.js", "utf8");

// The signed-out branch: everything between the `) : (` and the closing of the
// Navigator's conditional.
const elseStart = app.indexOf(") : (");
if (elseStart === -1) throw new Error("Could not find the signed-out branch");

const navigatorEnd = app.indexOf("</Stack.Navigator>", elseStart);
const branch = app.slice(elseStart, navigatorEnd);

const registered = [...branch.matchAll(/<Stack\.Screen\s+name="([^"]+)"/g)].map(
  (m) => m[1],
);

const listMatch = dockNav.match(
  /export const AUTH_ROUTE_NAMES = \[([\s\S]*?)\];/,
);
if (!listMatch) throw new Error("Could not find AUTH_ROUTE_NAMES");

const declared = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

console.log("auth routes registered in App.js:", registered.join(", "));
console.log("AUTH_ROUTE_NAMES declared:      ", declared.join(", "));

const missing = registered.filter((r) => !declared.includes(r));
const extra = declared.filter((r) => !registered.includes(r));

console.log(
  `registered but not declared: ${missing.length ? missing.join(", ") : "none"}`,
);
console.log(
  `declared but not registered: ${extra.length ? extra.join(", ") : "none"}`,
);

// A dock-visible route must never be an auth route: the two branches of the
// navigator are mutually exclusive, so any overlap means a name is registered
// in both branches at once.
const signedInBranch = app.slice(
  app.indexOf("{user && !isResettingPassword ? ("),
  elseStart,
);
const signedInRoutes = [
  ...signedInBranch.matchAll(/<Stack\.Screen\s+name="([^"]+)"/g),
].map((m) => m[1]);
const overlap = signedInRoutes.filter((r) => declared.includes(r));
console.log(
  `present in BOTH branches: ${overlap.length ? overlap.join(", ") : "none"}`,
);

assert.deepStrictEqual(
  missing,
  [],
  "auth route(s) missing from AUTH_ROUTE_NAMES",
);
assert.deepStrictEqual(extra, [], "AUTH_ROUTE_NAMES contains a non-auth route");
assert.deepStrictEqual(
  overlap,
  [],
  "route registered in both navigator branches",
);

console.log("\nAll checks passed.");
