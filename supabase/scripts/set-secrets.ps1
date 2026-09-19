# Set Supabase edge function secrets from a local .env file.
#
# Usage:
#   pwsh supabase/scripts/set-secrets.ps1 -Env test
#   pwsh supabase/scripts/set-secrets.ps1 -Env production
#
# Reads keys/values from supabase/.env.$Env and pushes them to the target
# Supabase project as edge function secrets via `supabase secrets set`.
# Anything starting with EXPO_PUBLIC_ or SUPABASE_DB_URL_ is skipped
# because those are client-side or CLI-only and should not be secrets.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet("test", "production")][string]$Env,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$envFile = Join-Path $repoRoot "supabase/.env.$Env"

if (-not (Test-Path $envFile)) {
    throw "Missing $envFile. Copy the .template next to it and fill in your values."
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

$shortSuffix = if ($Env.ToUpper() -eq "PRODUCTION") { "PROD" } else { $Env.ToUpper() }
$projectId = $null
foreach ($name in @("SUPABASE_PROJECT_ID_$($Env.ToUpper())", "SUPABASE_PROJECT_ID_$shortSuffix")) {
    $value = (Get-Item "Env:$name" -ErrorAction SilentlyContinue).Value
    if ($value) { $projectId = $value; break }
}

if (-not $projectId) {
    throw "Missing SUPABASE_PROJECT_ID_$($Env.ToUpper()) (or SUPABASE_PROJECT_ID_$shortSuffix) in $envFile"
}

$secretsToPush = @()
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -eq -1) { return }
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim().Trim('"', "'")
    if ([string]::IsNullOrEmpty($value)) { return }
    if ($name.StartsWith("EXPO_PUBLIC_")) { return }
    if ($name -like "SUPABASE_DB_URL_*") { return }
    if ($name -like "SUPABASE_PROJECT_ID_*") { return }
    $secretsToPush += "$name=$value"
}

if (-not $secretsToPush) {
    Write-Host "No secrets found in $envFile" -ForegroundColor Yellow
    return
}

# Always tag the deployment with APP_ENV so functions know which project
# they are running in.
$secretsToPush += "APP_ENV=$Env"

Write-Host "About to push $($secretsToPush.Count) secret(s) to $Env ($projectId):" -ForegroundColor Cyan
$secretsToPush | ForEach-Object { Write-Host "  - $($_.Split('=')[0])" -ForegroundColor Gray }

if ($DryRun) {
    Write-Host "[dry-run] Would run: supabase secrets set --project-ref $projectId" -ForegroundColor DarkGray
    return
}

Push-Location $repoRoot
try {
    supabase secrets set --project-ref $projectId @secretsToPush
    if ($LASTEXITCODE -ne 0) {
        throw "supabase secrets set failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Secrets deployed. Functions now see APP_ENV=$Env." -ForegroundColor Green
