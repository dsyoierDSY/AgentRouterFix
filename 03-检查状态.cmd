@echo off
setlocal
cd /d "%~dp0"
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\status.ps1"
pause
