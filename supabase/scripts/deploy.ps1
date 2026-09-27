# Deploy edge functions + migrations to a target Supabase environment.
#
# Usage:
#   pwsh supabase/scripts/deploy.ps1 -Env test
#   pwsh supabase/scripts/deploy.ps1 -Env production -IUnderstandThisDeploysToProduction
#
# Optional flags:
#   -SkipLink      do not run `supabase link`
#   -SkipMigrations skip the `supabase db push` step
#   -SkipFunctions skip the `supabase functions deploy` step
#   -DryRun        print what would happen without running any commands
#   -IUnderstandThisDeploysToProduction
#                  required acknowledgement for -Env production. Without it
#                  the script refuses to run, because the unsuffixed function
#                  names are the ones real customers call.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet("test", "production")][string]$Env,
    [switch]$SkipLink,
    [switch]$SkipMigrations,
    [switch]$SkipFunctions,
    [switch]$DryRun,
    [switch]$IUnderstandThisDeploysToProduction,
    # Deploy only these functions, by their on-disk folder name (WITHOUT the
    # -test suffix - the suffix is added by this script). Omit to deploy all.
    #
    # Named $OnlyFunctions, NOT $Functions: PowerShell variable names are
    # case-insensitive, so a $Functions param collides with the $functions
    # discovery list below. The assignment overwrote the param, the filter
    # silently saw the full list, and every function deployed regardless of
    # what was requested.
    [string[]]$OnlyFunctions
)

$ErrorActionPreference = "Stop"

# Fail closed on production. The unsuffixed edge function names serve live
# customers, so a bad deploy is a payments outage. Agents and CI should use
# -Env test only; a human doing a deliberate release passes the
# acknowledgement switch.
if ($Env -eq "production" -and -not $IUnderstandThisDeploysToProduction) {
    throw @"
REFUSING TO DEPLOY TO PRODUCTION.

  -Env production deploys the UNSUFFIXED edge function names, which are the
  ones real customers call, and can also apply database migrations.

Use the test variants instead:
  pwsh supabase/scripts/deploy.ps1 -Env test

If you genuinely mean to release to production, re-run with:
  pwsh supabase/scripts/deploy.ps1 -Env production -IUnderstandThisDeploysToProduction
"@
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$envFile = Join-Path $repoRoot "supabase/.env.$Env"
$templateFile = Join-Path $repoRoot "supabase/.env.$Env.template"

if (-not (Test-Path $envFile)) {
    Write-Host "Missing $envFile." -ForegroundColor Yellow
    if (Test-Path $templateFile) {
        Write-Host "A template is available at $templateFile." -ForegroundColor Yellow
        Write-Host "Copy it and fill in your project values before deploying." -ForegroundColor Yellow
    }
    throw "Environment file missing for $Env"
}

Write-Host "Loading $envFile..." -ForegroundColor Cyan
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -eq -1) { return }
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim().Trim('"', "'")
    if (-not [string]::IsNullOrEmpty($value)) {
        Set-Item -Path "Env:$name" -Value $value
    }
}

# Accept either the long-form (_PRODUCTION/_TEST) or the short-form
# (_PROD/_TEST) variable names so users can use whichever feels natural.
$shortSuffix = if ($Env.ToUpper() -eq "PRODUCTION") { "PROD" } else { $Env.ToUpper() }
$projectId = $null
foreach ($name in @("SUPABASE_PROJECT_ID_$($Env.ToUpper())", "SUPABASE_PROJECT_ID_$shortSuffix")) {
    $value = (Get-Item "Env:$name" -ErrorAction SilentlyContinue).Value
    if ($value) { $projectId = $value; break }
}
$dbUrl = $null
foreach ($name in @("SUPABASE_DB_URL_$($Env.ToUpper())", "SUPABASE_DB_URL_$shortSuffix")) {
    $value = (Get-Item "Env:$name" -ErrorAction SilentlyContinue).Value
    if ($value) { $dbUrl = $value; break }
}

if (-not $projectId) {
    throw "Missing SUPABASE_PROJECT_ID_$($Env.ToUpper()) (or SUPABASE_PROJECT_ID_$shortSuffix) in $envFile"
}

function Invoke-Step {
    param([string]$Title, [string]$Command)
    Write-Host ""
    Write-Host "==>" -ForegroundColor Green -NoNewline
    Write-Host " $Title" -ForegroundColor White
    Write-Host "    cmd: $Command" -ForegroundColor DarkGray
    if ($DryRun) {
        Write-Host "    [dry-run] not executing" -ForegroundColor DarkGray
        return
    }
    Invoke-Expression $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    if (-not $SkipLink) {
        Invoke-Step "Linking to $Env project ($projectId)" "supabase link --project-ref $projectId"
    }

    if (-not $SkipMigrations -and $dbUrl) {
        Invoke-Step "Applying migrations to $Env database" "supabase db push --db-url $dbUrl --include-all"
    } elseif (-not $SkipMigrations) {
        Write-Host ""
        Write-Host "Skipping db push: SUPABASE_DB_URL_$($Env.ToUpper()) (or _${shortSuffix}) not set in $envFile" -ForegroundColor Yellow
    }

    if (-not $SkipFunctions) {
        # Test env uses -test suffix on all function names (e.g. health-test, verify-payment-test)
        $suffix = if ($Env.ToUpper() -eq "TEST") { "-test" } else { "" }
        $functionsDir = Join-Path $repoRoot "supabase/functions"

        # Discovered from the filesystem rather than a hardcoded list. The list
        # had drifted and left admin-users, bulk-update-orders and
        # dispatch-order undeployed. It also named "get-order-status", which is
        # not a real folder.
        #
        # Every function is self-contained: the identity helpers and the
        # invocation logger are INLINED into each index.ts. A relative import
        # of a shared module would bundle fine via the CLI but FAIL through the
        # dashboard's "Deploy with upload file", which only bundles the
        # selected function folder:
        #
        #   Failed to bundle the function (reason: Module not found
        #   "file:///tmp/user_fn_.../_shared/auth.ts")
        #
        # So there is deliberately no _shared directory, and no cross-function
        # imports to resolve.
        $functions = Get-ChildItem -Path $functionsDir -Directory |
            Where-Object { $_.Name -notlike "_*" } |
            Where-Object {
                (Test-Path (Join-Path $_.FullName "index.ts")) -or
                (Test-Path (Join-Path $_.FullName "index.js"))
            } |
            ForEach-Object { $_.Name } |
            Sort-Object

        # Optional narrowing to specific functions, named WITHOUT the -test
        # suffix (the suffix is appended below). Validated against the
        # discovered list so a typo fails loudly instead of silently
        # deploying nothing.
        if ($OnlyFunctions) {
            $requested = @($OnlyFunctions | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            $unknown = @($requested | Where-Object { $_ -notin $functions })
            if ($unknown.Count -gt 0) {
                throw "Unknown function(s): $($unknown -join ', '). Available: $($functions -join ', ')"
            }
            $functions = @($functions | Where-Object { $_ -in $requested })
        }

        if (-not $functions) {
            throw "No edge functions found in $functionsDir"
        }

        Write-Host ""
        Write-Host "Deploying $($functions.Count) edge function(s):" -ForegroundColor Cyan
        $functions | ForEach-Object { Write-Host "  - $_$suffix" -ForegroundColor DarkGray }

        # `supabase functions deploy <name>` uploads
        # supabase/functions/<name>/index.ts - the deployed name IS the folder
        # name. So `deploy health-test` looks for a `health-test` folder that
        # does not exist and fails with:
        #   Entrypoint path does not exist - .../supabase/functions/health-test/index.ts
        # For production (empty suffix) the folder already matches and we
        # deploy in place. For test we stage each function into a temp
        # functions root under its suffixed name, deploy from there, then
        # delete it. Staging is per-function and cleaned up in `finally` so a
        # mid-run failure cannot leave a half-populated tree behind.
        $stagingDir = $null
        if ($suffix) {
            # --workdir is the directory that CONTAINS the supabase/ folder, so
            # the staged layout must be <root>/supabase/functions/<name>/.
            $stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) ("mysti-fn-" + [Guid]::NewGuid().ToString("N"))
            $stagingFunctions = Join-Path (Join-Path $stagingDir "supabase") "functions"
            New-Item -ItemType Directory -Path $stagingFunctions -Force | Out-Null
            Write-Host "Staging suffixed functions under $stagingDir" -ForegroundColor DarkGray
        }

        try {
            foreach ($fn in $functions) {
                $deployName = "$fn$suffix"

                if ($suffix) {
                    $source = Join-Path $functionsDir $fn
                    $target = Join-Path $stagingFunctions $deployName
                    Copy-Item -Path $source -Destination $target -Recurse -Force

                    # import_map.json / deno.json live beside the function
                    # folders and the CLI reads them from the same root.
                    foreach ($shared in @("import_map.json", "deno.json")) {
                        $sharedPath = Join-Path $functionsDir $shared
                        if (Test-Path $sharedPath) {
                            Copy-Item -Path $sharedPath -Destination (Join-Path $stagingFunctions $shared) -Force
                        }
                    }
                }

                if ($stagingDir) {
                    Invoke-Step "Deploying edge function: $deployName" "supabase functions deploy $deployName --project-ref $projectId --workdir `"$stagingDir`" --use-api"
                }
                else {
                    Invoke-Step "Deploying edge function: $deployName" "supabase functions deploy $deployName --project-ref $projectId --use-api"
                }
            }
        }
        finally {
            if ($stagingDir -and (Test-Path $stagingDir)) {
                Remove-Item -Path $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Deployment to $Env complete." -ForegroundColor Green
Write-Host "Run the health check: pwsh supabase/scripts/test-functions.ps1 -Env $Env" -ForegroundColor Cyan
