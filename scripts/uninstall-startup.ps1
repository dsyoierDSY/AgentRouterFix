$ErrorActionPreference = 'Stop'
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'AgentRouter OpenAI Compatibility Proxy.lnk'

if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Host "Removed startup shortcut:" -ForegroundColor Green
  Write-Host "  $shortcutPath"
} else {
  Write-Host "No startup shortcut was installed."
}
