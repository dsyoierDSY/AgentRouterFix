@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%PWSH%" set "PWSH=pwsh"

"%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo.
  echo 配置未完成。请查看上方提示。
  echo.
) else (
  echo 配置已完成。
  echo.
)
echo 按任意键关闭此窗口...
pause >nul
exit /b %EXIT_CODE%
