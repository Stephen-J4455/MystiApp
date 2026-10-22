#!/usr/bin/env node
// ===========================================================================
// Cross-platform deploy dispatcher
// ===========================================================================
//
// WHY THIS EXISTS
// ---------------
// The npm scripts all shelled out to `pwsh` and ran the PowerShell scripts:
//
//     "functions:deploy:test": "pwsh supabase/scripts/deploy.ps1 -Env test ..."
//
// That works on a machine with PowerShell installed and FAILS on one without
// it, with a bare:
//
//     sh: line 1: pwsh: command not found
//
// which says nothing about what to do next. The repository already ships
// equivalent BASH scripts (`deploy.sh`) that do the same work, so the fix is
// to pick whichever runtime is present.
//
// THE FLAGS ARE THE SAME ON BOTH
// ------------------------------
//   -Env <test|production>      which environment
//   -SkipMigrations             do not run `supabase db push`
//   -SkipFunctions              do not run `supabase functions deploy`
//   -SkipLink                   do not run `supabase link`
//   -OnlyFunctions "a b"        deploy only these functions
//   -IUnderstandThisDeploysToProduction
//                               required acknowledgement for production
//
// The bash script takes the environment as a POSITIONAL argument and the
// flags as environment variables, so they are translated here.
//
// PRODUCTION IS FAIL-CLOSED IN BOTH
// --------------------------------
// A production deploy needs the explicit acknowledgement flag, and BOTH
// scripts refuse without it. This dispatcher does not add a way around that,
// and it does not offer a "just do it" flag of its own.
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
  // THE POWER SHELL SCRIPT.
  const commandArgs = [psSibling("deploy.mjs"), "-Env", args.env];
  if (args.skipMigrations) commandArgs.push("-SkipMigrations");
  if (args.skipFunctions) commandArgs.push("-SkipFunctions");
  if (args.skipLink) commandArgs.push("-SkipLink");
  if (args.onlyFunctions) {
    commandArgs.push("-OnlyFunctions", args.onlyFunctions);
  }
  if (args.acknowledgeProduction) {
    commandArgs.push("-IUnderstandThisDeploysToProduction");
  }
  run("pwsh", commandArgs, childEnv);
} else {
  // THE BASH SCRIPT.
  //
  // The flags become environment variables, because the bash script was
  // written that way.
  if (args.skipMigrations) childEnv.SKIP_MIGRATIONS = "1";
  if (args.skipFunctions) childEnv.SKIP_FUNCTIONS = "1";
  if (args.skipLink) childEnv.SKIP_LINK = "1";
  if (args.onlyFunctions) childEnv.ONLY_FUNCTIONS = args.onlyFunctions;

  const commandArgs = [bashSibling("deploy.mjs"), args.env];
  if (args.acknowledgeProduction) {
    commandArgs.push("-IUnderstandThisDeploysToProduction");
  }

  console.log(BASH_FALLBACK_NOTICE);
  run("bash", commandArgs, childEnv);
}
