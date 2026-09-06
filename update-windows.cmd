@echo off
if not exist "%~dp0update-windows.ps1" (
  echo Missing update-windows.ps1 beside this launcher.
  echo Right-click the ZIP and choose Extract All.
  echo Then run update-windows.cmd from the extracted folder.
  pause
  exit /b 1
)
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 is required. See docs\GETTING-STARTED.md.
  pause
  exit /b 1
)
pwsh.exe -NoProfile -File "%~dp0update-windows.ps1"
set "codex_update_result=%ERRORLEVEL%"
if not "%codex_update_result%"=="0" echo Update failed. Keep this window open to read the error above.
pause
exit /b %codex_update_result%
