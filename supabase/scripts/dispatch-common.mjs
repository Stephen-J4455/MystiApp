// ===========================================================================
// Shared helpers for the cross-platform script dispatchers
// ===========================================================================
//
// The npm scripts in `package.json` used to call `pwsh` directly, which fails
// on any machine without PowerShell:
//
//     sh: line 1: pwsh: command not found
//
// The repository already ships equivalent BASH scripts, so each npm script
// now goes through a small `.mjs` dispatcher that picks whichever runtime is
// actually installed.
//
// These helpers are the shared parts of that dispatch.
//
// WHY THE BASH SCRIPTS ARE NOT SUFFICIENT ON THEIR OWN
// ------------------------------------------------------
// The `.ps1` scripts are the ones documented in AGENTS.md, and on Windows
// `bash` may be a Git-Bash shim with a different path layout. Preferring the
// native PowerShell on a machine that has it, and bash otherwise, means each
// platform runs the script that was written for it.
// ===========================================================================

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Whether an executable is on PATH.
 *
 * Checks the PATHEXT-style list on Windows, because `where` is not available
 * on Linux and `which` is not always on Windows.
 */
export const hasCommand = (name) => {
  const pathEnv = process.env.PATH || "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
      : [""];

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      if (existsSync(path.join(dir, `${name}${ext}`))) return true;
    }
  }
  return false;
};

/**
 * Parse the shared flags.
 *
 * `-Env <test|production>` and `-OnlyFunctions "a b"` are the two that
 * differ in shape between the two script families; the rest are switches.
 */
export const parseArgs = (argv) => {
  const args = {
    env: "test",
    skipMigrations: false,
    skipFunctions: false,
    skipLink: false,
    onlyFunctions: "",
    acknowledgeProduction: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "-Env":
      case "--env":
        args.env = next;
        i += 1;
        break;
      case "-SkipMigrations":
      case "--skip-migrations":
        args.skipMigrations = true;
        break;
      case "-SkipFunctions":
      case "--skip-functions":
        args.skipFunctions = true;
        break;
      case "-SkipLink":
      case "--skip-link":
        args.skipLink = true;
        break;
      case "-OnlyFunctions":
      case "--only-functions":
        args.onlyFunctions = next || "";
        i += 1;
        break;
      case "-IUnderstandThisDeploysToProduction":
      case "--i-understand-this-deploys-to-production":
        args.acknowledgeProduction = true;
        break;
      default:
        break;
    }
  }

  return args;
};

/**
 * Run a child process and exit with its code.
 */
export const run = (command, commandArgs, env) => {
  const child = spawn(command, commandArgs, {
    stdio: "inherit",
    env: env || { ...process.env },
  });
  child.on("exit", (code) => process.exit(code ?? 1));
};

/**
 * The message shown when the bash scripts are used instead of PowerShell.
 */
export const BASH_FALLBACK_NOTICE =
  "[dispatch] pwsh not found - using the bash scripts. " +
  "Install PowerShell (`pacman -S powershell` / `apt install powershell`) " +
  "to use the .ps1 variants instead.";

/**
 * The bash sibling of a `.mjs` dispatcher.
 *
 * The two files are named in step: `deploy.mjs` -> `deploy.sh`.
 */
export const bashSibling = (mjsName) =>
  path.join(SCRIPT_DIR, mjsName.replace(/\.mjs$/, ".sh"));

/**
 * The PowerShell sibling of a `.mjs` dispatcher.
 */
export const psSibling = (mjsName) =>
  path.join(SCRIPT_DIR, mjsName.replace(/\.mjs$/, ".ps1"));
