@echo off
setlocal
cd /d "%~dp0"
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
if errorlevel 1 (
  echo.
  echo 配置未完成。请查看上方提示。
  pause
)
