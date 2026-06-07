@echo off
setlocal
cd /d "%~dp0"
title Visual Reader

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm is not available. Please run install.bat first.
  pause
  exit /b 1
)

echo Starting Visual Reader at http://localhost:5173
echo Keep this window open; press Ctrl+C to stop.
echo.
start "" /b cmd /c "timeout /t 5 >nul && start "" http://localhost:5173"
call pnpm dev:web
