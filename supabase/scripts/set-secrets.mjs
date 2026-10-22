#!/usr/bin/env node
// ===========================================================================
// Cross-platform set-secrets dispatcher
// ===========================================================================
//
// WHY THIS EXISTS
// ---------------
// The npm script shelled out to `pwsh`:
//
//     "secrets:set:test": "pwsh supabase/scripts/set-secrets.ps1 -Env test"
//
// which fails on a machine without PowerShell:
//
//     sh: line 1: pwsh: command not found
//
// The equivalent BASH script (`set-secrets.sh`) already exists, so this
// picks whichever runtime is installed.
//
// A NOTE ON SECRETS, BECAUSE THIS SCRIPT SETS THEM
// --------------------------------------------------
// `supabase secrets set` REPLACES the whole secret set; it does not merge.
// Every env file must therefore list all four Paystack keys, or the missing
// ones are DELETED from the project. A partial env file silently removes
// live secrets.
//
// The env files are gitignored. A real secret in a committed file is treated
// as compromised and must be rotated.
// ===========================================================================

import {
  BASH_FALLBACK_NOTICE,
  bashSibling,
  hasCommand,
  parseArgs,
  psSibling,
  run,
} from "./dispatch-common.mjs";

const args = parseArgs(process.argv.slice(2));

if (args.env !== "test" && args.env !== "production") {
  console.error(
    `Unknown environment "${args.env}". Use "test" or "production".`,
  );
  process.exit(1);
}

const childEnv = { ...process.env };

if (hasCommand("pwsh")) {
  const commandArgs = [psSibling("set-secrets.mjs"), "-Env", args.env];
  run("pwsh", commandArgs, childEnv);
} else {
  console.log(BASH_FALLBACK_NOTICE);
  run("bash", [bashSibling("set-secrets.mjs"), args.env], childEnv);
}
