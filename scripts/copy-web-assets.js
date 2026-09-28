// Copies the static files from web/ into dist/ after `expo export`.
// vercel.json whitelists these paths from the SPA rewrite, so they must be
// present in dist/ or the service worker and PWA manifest 404.
//
// index.html is DELIBERATELY NOT COPIED. Expo's export owns dist/index.html —
// it is the SPA entry that loads _expo/static/js/web/*.js. web/index.html is a
// separate static landing page for password-reset links, and overwriting the
// SPA entry with it produces a build that exits 0 and 404s every asset: the
// app never boots. Copying it would also make the vercel.json rewrite's
// destination ("/index.html") resolve to the landing page instead of the app.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(root, "web");
const dist = path.join(root, "dist");

if (!fs.existsSync(src)) {
  console.error(`[copy-web-assets] missing source dir: ${src}`);
  process.exit(1);
}
if (!fs.existsSync(dist)) {
  console.error(
    `[copy-web-assets] missing dist dir: ${dist} — did expo export run?`,
  );
  process.exit(1);
}

let copied = 0;
const skipped = [];
for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (entry.name === "index.html") {
    skipped.push(entry.name);
    continue;
  }
  fs.copyFileSync(path.join(src, entry.name), path.join(dist, entry.name));
  copied += 1;
}

// Fail loudly rather than shipping a build that cannot boot. expo export
// always writes dist/index.html, so its absence means something upstream
// removed the SPA entry and every asset reference would 404.
const indexHtml = path.join(dist, "index.html");
if (!fs.existsSync(indexHtml)) {
  console.error(
    `[copy-web-assets] dist/index.html is missing — the Expo SPA entry was ` +
      `clobbered. Refusing to report success.`,
  );
  process.exit(1);
}
const html = fs.readFileSync(indexHtml, "utf8");
if (!html.includes("_expo/static")) {
  console.error(
    `[copy-web-assets] dist/index.html has no _expo/static reference — this ` +
      `is not the Expo SPA entry. Refusing to report success.`,
  );
  process.exit(1);
}

console.log(
  `[copy-web-assets] copied ${copied} file(s) from web/ to dist/` +
    (skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""),
);
console.log(`[copy-web-assets] verified dist/index.html loads the Expo bundle`);
