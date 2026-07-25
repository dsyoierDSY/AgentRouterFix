@echo off
setlocal
cd /d "%~dp0.."
title AgentRouter OpenAI Compatibility Proxy

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH. Install Node.js 20+ and try again.
  pause
  exit /b 1
)

echo Starting AgentRouter OpenAI Compatibility Proxy...
echo Keep this window open while using Cherry Studio or OpenCode.
echo Check health: http://127.0.0.1:8787/healthz
node src\index.js

echo.
echo Proxy stopped with exit code %ERRORLEVEL%.
pause
