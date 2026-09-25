const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourceDir = path.join(root, "web");
const outputDir = path.join(root, "dist");
const assetNames = [
  "reset-password.html",
  "styles.css",
  "manifest.json",
  "service-worker.js",
];

if (!fs.existsSync(outputDir)) {
  throw new Error("Web export was not created. Run the Expo export first.");
}

for (const name of assetNames) {
  const source = path.join(sourceDir, name);
  const destination = path.join(outputDir, name);
  fs.copyFileSync(source, destination);
}

const indexPath = path.join(outputDir, "index.html");
const indexHtml = fs.readFileSync(indexPath, "utf8");
if (!indexHtml.includes('rel="manifest"')) {
  const manifestTag = '    <link rel="manifest" href="/manifest.json" />\n';
  fs.writeFileSync(
    indexPath,
    indexHtml.replace("</head>", `${manifestTag}  </head>`),
  );
}

const logoSource = path.join(root, "assets", "mystiwan.png");
const logoDestinationDir = path.join(outputDir, "assets");
fs.mkdirSync(logoDestinationDir, { recursive: true });
fs.copyFileSync(logoSource, path.join(logoDestinationDir, "mystiwan.jpg"));

for (const size of [192, 512]) {
  fs.copyFileSync(
    path.join(root, "assets", `pwa-icon-${size}.png`),
    path.join(logoDestinationDir, `pwa-icon-${size}.png`),
  );
}

console.log("Copied web and PWA assets to dist.");
