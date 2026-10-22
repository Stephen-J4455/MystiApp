#!/usr/bin/env node
// ===========================================================================
// Cross-platform test-functions dispatcher
// ===========================================================================
//
// WHY THIS EXISTS
// ---------------
// The npm script shelled out to `pwsh`:
//
//     "functions:test:test": "pwsh supabase/scripts/test-functions.ps1 -Env test"
//
// which fails on a machine without PowerShell:
//
//     sh: line 1: pwsh: command not found
//
// The equivalent BASH script (`test-functions.sh`) already exists, so this
// picks whichever runtime is installed.
//
// WHAT IT CHECKS
// --------------
// It hits the deployed `health` endpoint for the given environment and
// confirms the function is live and pointed at the expected project. It is
// the quickest way to tell a successful deploy from one that silently went
// to the wrong environment - which matters because the test and production
// function names differ only by a `-test` suffix.
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
  const commandArgs = [psSibling("test-functions.mjs"), "-Env", args.env];
  run("pwsh", commandArgs, childEnv);
} else {
  console.log(BASH_FALLBACK_NOTICE);
  run("bash", [bashSibling("test-functions.mjs"), args.env], childEnv);
}
