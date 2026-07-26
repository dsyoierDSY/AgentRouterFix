$ErrorActionPreference = 'Stop'
$startupFolder = [Environment]::GetFolderPath('Startup')
$startupFile = Join-Path $startupFolder 'AgentRouter OpenAI Compatibility Proxy.vbs'
$legacyShortcut = Join-Path $startupFolder 'AgentRouter OpenAI Compatibility Proxy.lnk'

if ((Test-Path -LiteralPath $startupFile) -or (Test-Path -LiteralPath $legacyShortcut)) {
  Remove-Item -LiteralPath $startupFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $legacyShortcut -Force -ErrorAction SilentlyContinue
  Write-Host "Removed silent startup launcher." -ForegroundColor Green
} else {
  Write-Host "No startup launcher was installed."
}
