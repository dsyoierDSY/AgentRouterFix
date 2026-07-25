$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$port = 8787

if (Test-Path -LiteralPath $envFile) {
  $line = Get-Content -LiteralPath $envFile |
    Where-Object { $_ -match '^\s*PORT\s*=' } |
    Select-Object -First 1
  if ($line) {
    $candidate = ($line -split '=', 2)[1].Trim()
    $parsed = 0
    if ([int]::TryParse($candidate, [ref]$parsed)) {
      $port = $parsed
    }
  }
}

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3
  if ($health.ok) {
    Write-Host "Proxy is running: http://127.0.0.1:$port" -ForegroundColor Green
    Write-Host "Cherry Studio: http://127.0.0.1:$port"
    Write-Host "OpenCode:      http://127.0.0.1:$port/v1"
    exit 0
  }
} catch {}

Write-Host "Proxy is not running on port $port." -ForegroundColor Red
Write-Host 'Double-click 02-start to launch it in the background.'
exit 1
