const path = require("path");
const fs = require("fs");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);
const nodeModulesRoot = path.resolve(projectRoot, "node_modules");
const extraNodeModules = {};

function addPackage(packageName, packagePath) {
  if (!extraNodeModules[packageName]) {
    extraNodeModules[packageName] = fs.realpathSync(packagePath);
  }
}

function addPackages(root) {
  for (const packageName of fs.readdirSync(root)) {
    const packagePath = path.join(root, packageName);

    if (packageName.startsWith("@")) {
      for (const scopedPackage of fs.readdirSync(packagePath)) {
        addPackage(`${packageName}/${scopedPackage}`, path.join(packagePath, scopedPackage));
      }
    } else if (!packageName.startsWith(".")) {
      addPackage(packageName, packagePath);
    }
  }
}

addPackages(nodeModulesRoot);
for (const storeEntry of fs
  .readdirSync(path.join(nodeModulesRoot, ".pnpm"))
  .sort()
  .reverse()) {
  const storeNodeModules = path.join(nodeModulesRoot, ".pnpm", storeEntry, "node_modules");
  if (fs.existsSync(storeNodeModules)) addPackages(storeNodeModules);
}

config.resolver.nodeModulesPaths = [
  nodeModulesRoot,
];
config.resolver.extraNodeModules = extraNodeModules;

module.exports = config;