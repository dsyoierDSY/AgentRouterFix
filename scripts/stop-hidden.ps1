$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot '.proxy.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host 'No proxy process started by this project was recorded.'
  exit 0
}

$rawPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
$proxyPid = 0
if (-not [int]::TryParse($rawPid, [ref]$proxyPid)) {
  Remove-Item -LiteralPath $pidFile -Force
  Write-Host 'Removed invalid proxy process record.'
  exit 0
}

$process = Get-Process -Id $proxyPid -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id $proxyPid -Force
  Write-Host "Stopped background proxy (PID $proxyPid)." -ForegroundColor Green
} else {
  Write-Host 'Proxy process was already stopped.'
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
