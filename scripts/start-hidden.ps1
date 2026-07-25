[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$pidFile = Join-Path $projectRoot '.proxy.pid'
$lockFile = Join-Path $projectRoot '.proxy.starting.lock'
$logDirectory = Join-Path $projectRoot 'logs'
$stdoutLog = Join-Path $logDirectory 'proxy.out.log'
$stderrLog = Join-Path $logDirectory 'proxy.err.log'

function Get-ConfiguredPort {
  $port = 8787
  if (Test-Path -LiteralPath $envFile) {
    $line = Get-Content -LiteralPath $envFile |
      Where-Object { $_ -match '^\s*PORT\s*=' } |
      Select-Object -First 1
    if ($line) {
      $parsed = 0
      $candidate = ($line -split '=', 2)[1].Trim()
      if ([int]::TryParse($candidate, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 65535) {
        $port = $parsed
      }
    }
  }
  return $port
}

$lockStream = $null
try {
  try {
    $lockStream = [System.IO.File]::Open(
      $lockFile,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch {
    Write-Host 'Proxy is already starting. Please wait a moment.'
    exit 0
  }

  $port = Get-ConfiguredPort
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
    if ($health.ok) {
      Write-Host "Proxy is already running: http://127.0.0.1:$port"
      exit 0
    }
  } catch {}

  if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Proxy is not configured. Run 01-setup first.'
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw 'Node.js 20+ was not found in PATH.'
  }

  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  $process = Start-Process `
    -FilePath $node.Source `
    -ArgumentList 'src\index.js' `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
  Start-Sleep -Milliseconds 800

  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
    if ($health.ok) {
      Write-Host "Proxy started in the background: http://127.0.0.1:$port" -ForegroundColor Green
      exit 0
    }
  } catch {}

  Write-Host 'Proxy did not start successfully. Check logs:' -ForegroundColor Red
  Write-Host "  $stdoutLog"
  Write-Host "  $stderrLog"
  exit 1
} finally {
  if ($lockStream) {
    $lockStream.Dispose()
  }
  Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
}
