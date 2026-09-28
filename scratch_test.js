const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The module is plain JS with a single `export const`, so stripping that one
// keyword is enough to evaluate it. Avoids needing @babel/register, which is
// not a dependency of this project.
const src = fs
  .readFileSync(path.join(__dirname, "src/lib/webLinking.js"), "utf8")
  .replace(/^export const /gm, "const ")
  .concat("\n;globalThis.__getWebLinking = getWebLinking;");

vm.runInThisContext(src, { filename: "webLinking.js" });
const { getWebLinking } = globalThis.__getWebLinking;

const stack = (name) => ({ routes: [{ name }], index: 0 });
const out = getWebLinking(true);
const auth = getWebLinking(false);

// --- getPathFromState: route name only, no params ---
assert.strictEqual(out.getPathFromState(stack("Home")), "/Home");
assert.strictEqual(out.getPathFromState(stack("Profile")), "/Profile");

// A route reached with a params object must NOT serialise the object.
assert.strictEqual(
  out.getPathFromState(stack("Receipt")),
  "/Receipt",
  "Receipt must not leak params",
);

// Nested state: the LEAF is what should be serialised.
const nested = {
  routes: [{ name: "Home", state: stack("WalletTopUp") }],
  index: 0,
};
assert.strictEqual(out.getPathFromState(nested), "/WalletTopUp");

// A state naming a route from the OTHER branch falls back to root.
assert.strictEqual(auth.getPathFromState(stack("Profile")), "/");

// Malformed states must not throw.
for (const bad of [undefined, null, {}, { routes: [] }, { index: 9 }]) {
  assert.strictEqual(out.getPathFromState(bad), "/");
}

// --- getStateFromPath ---
assert.deepStrictEqual(out.getStateFromPath("/Profile"), {
  routes: [{ name: "Profile" }],
});
assert.deepStrictEqual(out.getStateFromPath("/Profile?x=1"), {
  routes: [{ name: "Profile" }],
});
assert.strictEqual(out.getStateFromPath("/Bogus"), undefined);
assert.strictEqual(out.getStateFromPath("/"), undefined);

// --- filter: rejects routes outside the mounted branch ---
assert.strictEqual(out.filter("https://x.example/Profile"), true);
assert.strictEqual(out.filter("https://x.example/Receipt?a=b"), true);
assert.strictEqual(
  out.filter("https://x.example/Login"),
  false,
  "app branch must reject Login",
);
assert.strictEqual(auth.filter("https://x.example/Login"), true);
assert.strictEqual(
  auth.filter("https://x.example/Profile"),
  false,
  "auth branch must reject Profile",
);

console.log("all webLinking assertions passed");
