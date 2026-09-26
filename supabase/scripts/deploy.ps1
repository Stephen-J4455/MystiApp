# Deploy edge functions + migrations to a target Supabase environment.
#
# Usage:
#   pwsh supabase/scripts/deploy.ps1 -Env test
#   pwsh supabase/scripts/deploy.ps1 -Env production
#
# Optional flags:
#   -SkipLink      do not run `supabase link`
#   -SkipMigrations skip the `supabase db push` step
#   -SkipFunctions skip the `supabase functions deploy` step
#   -DryRun        print what would happen without running any commands

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet("test", "production")][string]$Env,
    [switch]$SkipLink,
    [switch]$SkipMigrations,
    [switch]$SkipFunctions,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

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
            ForEach-Object { "$($_.Name)$suffix" } |
            Sort-Object

        if (-not $functions) {
            throw "No edge functions found in $functionsDir"
        }

        Write-Host ""
        Write-Host "Deploying $($functions.Count) edge function(s):" -ForegroundColor Cyan
        $functions | ForEach-Object { Write-Host "  - $_" -ForegroundColor DarkGray }

        foreach ($fn in $functions) {
            Invoke-Step "Deploying edge function: $fn" "supabase functions deploy $fn --project-ref $projectId"
        }
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Deployment to $Env complete." -ForegroundColor Green
Write-Host "Run the health check: pwsh supabase/scripts/test-functions.ps1 -Env $Env" -ForegroundColor Cyan
