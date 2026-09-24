const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourceDir = path.join(root, "web");
const outputDir = path.join(root, "dist");
const assetNames = ["reset-password.html", "styles.css"];

if (!fs.existsSync(outputDir)) {
  throw new Error("Web export was not created. Run the Expo export first.");
}

for (const name of assetNames) {
  const source = path.join(sourceDir, name);
  const destination = path.join(outputDir, name);
  fs.copyFileSync(source, destination);
}

const logoSource = path.join(root, "assets", "mystiwan.png");
const logoDestinationDir = path.join(outputDir, "assets");
fs.mkdirSync(logoDestinationDir, { recursive: true });
fs.copyFileSync(logoSource, path.join(logoDestinationDir, "mystiwan.jpg"));

console.log("Copied password-reset web assets to dist.");
