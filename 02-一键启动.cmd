@echo off
setlocal
cd /d "%~dp0"
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-hidden.ps1"
if errorlevel 1 pause
