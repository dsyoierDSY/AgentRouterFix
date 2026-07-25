[CmdletBinding()]
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-hidden.vbs'
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'AgentRouter OpenAI Compatibility Proxy.lnk'

if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Launcher not found: $launcher"
}

if ((Test-Path -LiteralPath $shortcutPath) -and -not $Force) {
  Write-Host "Startup shortcut already exists:" -ForegroundColor Yellow
  Write-Host "  $shortcutPath"
  Write-Host "Use .\scripts\install-startup.ps1 -Force to replace it."
  exit 0
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$shortcut.Arguments = "`"$launcher`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = 'Starts the AgentRouter OpenAI Compatibility Proxy silently at Windows logon.'
$shortcut.WindowStyle = 7
$shortcut.Save()

Write-Host "Startup shortcut installed:" -ForegroundColor Green
Write-Host "  $shortcutPath"
Write-Host "It will start automatically the next time you sign in to Windows."
Write-Host "To start it now, double-click:"
Write-Host "  $launcher"
