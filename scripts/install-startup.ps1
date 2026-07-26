[CmdletBinding()]
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-hidden.ps1'
$startupFolder = [Environment]::GetFolderPath('Startup')
$startupFile = Join-Path $startupFolder 'AgentRouter OpenAI Compatibility Proxy.vbs'
$legacyShortcut = Join-Path $startupFolder 'AgentRouter OpenAI Compatibility Proxy.lnk'

if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Launcher not found: $launcher"
}

if ((Test-Path -LiteralPath $startupFile) -and -not $Force) {
  Write-Host "Startup launcher already exists:" -ForegroundColor Yellow
  Write-Host "  $startupFile"
  Write-Host "Use .\scripts\install-startup.ps1 -Force to replace it."
  exit 0
}

$escapedLauncher = $launcher.Replace('"', '""')
$startupContent = @"
Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "pwsh.exe -NoProfile -ExecutionPolicy Bypass -File ""$escapedLauncher""", 0, False
"@

Set-Content -LiteralPath $startupFile -Value $startupContent -Encoding ascii
Remove-Item -LiteralPath $legacyShortcut -Force -ErrorAction SilentlyContinue

Write-Host "Silent startup launcher installed:" -ForegroundColor Green
Write-Host "  $startupFile"
Write-Host "It will start automatically the next time you sign in to Windows."
Write-Host "To start it now, double-click:"
Write-Host "  $launcher"
