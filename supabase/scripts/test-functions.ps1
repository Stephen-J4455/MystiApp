# Hit the deployed health endpoint to verify the edge function deployment
# is live and connected to the expected environment.
#
# Usage:
#   pwsh supabase/scripts/test-functions.ps1 -Env test
#   pwsh supabase/scripts/test-functions.ps1 -Env production
#
# Optionally pass -Url to skip the URL lookup (useful for ephemeral
# preview deployments):
#   pwsh supabase/scripts/test-functions.ps1 -Url https://abc.supabase.co/functions/v1/health

[CmdletBinding()]
param(
    [ValidateSet("test", "production", "")][string]$Env = "",
    [string]$Url = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")

if (-not $Url) {
    if (-not $Env) {
        throw "Provide either -Env (test|production) or -Url"
    }
    $envFile = Join-Path $repoRoot "supabase/.env.$Env"
    if (-not (Test-Path $envFile)) {
        throw "Missing $envFile. Run `cp $envFile.template $envFile` and fill in your values first."
    }
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $eq = $line.IndexOf("=")
        if ($eq -eq -1) { return }
        $name = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim().Trim('"', "'")
        if (-not [string]::IsNullOrEmpty($value)) {
            Set-Item -Path "Env:$name" -Value $value -ErrorAction SilentlyContinue
        }
    }

    # Prefer the dedicated URL variable; fall back to legacy names.
    $urlVarCandidates = if ($Env -eq "test") {
        @("EXPO_PUBLIC_SUPABASE_TEST_URL", "SUPABASE_TEST_URL", "SUPABASE_URL_TEST")
    } else {
        @("EXPO_PUBLIC_SUPABASE_PRODUCTION_URL", "EXPO_PUBLIC_SUPABASE_LIVE_URL", "SUPABASE_PRODUCTION_URL", "SUPABASE_URL_PRODUCTION", "EXPO_PUBLIC_PAYSTACK_LIVE_PUBLIC_KEY")
    }
    $urlFromEnv = $null
    foreach ($v in $urlVarCandidates) {
        $candidate = (Get-Item "Env:$v" -ErrorAction SilentlyContinue).Value
        if (-not $candidate) { continue }
        if ($candidate -like "pk_*") { continue }
        if ($candidate -like "sk_*") { continue }
        $urlFromEnv = $candidate
        break
    }
    if (-not $urlFromEnv) {
        throw "Could not resolve Supabase URL for $Env. Set one of: $($urlVarCandidates -join ', ')"
    }
    $Url = "$urlFromEnv/functions/v1/health"
}

Write-Host "Calling health endpoint: $Url" -ForegroundColor Cyan

$headers = @{
    "apikey"      = $env:SUPABASE_ANON_KEY
    "Content-Type" = "application/json"
}

$response = Invoke-WebRequest -Uri $Url -Method GET -Headers $headers -UseBasicParsing -ErrorAction SilentlyContinue
if (-not $response) {
    Write-Host "Health check failed: no response" -ForegroundColor Red
    exit 1
}

$body = $response.Content
try {
    $json = $body | ConvertFrom-Json -ErrorAction Stop
} catch {
    Write-Host "Health check returned non-JSON response (HTTP $($response.StatusCode)):" -ForegroundColor Red
    Write-Host $body
    exit 1
}

Write-Host ""
Write-Host "HTTP $($response.StatusCode)" -ForegroundColor $(if ($response.StatusCode -eq 200) { "Green" } else { "Red" })
Write-Host ($json | ConvertTo-Json -Depth 6)

if ($json.ok) {
    Write-Host ""
    Write-Host "Health OK" -ForegroundColor Green
    exit 0
}
Write-Host ""
Write-Host "Health check reports issues. See above." -ForegroundColor Red
exit 1
