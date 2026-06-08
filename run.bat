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

rem Start the local ComfyUI engine if it's installed, so "On my computer" image
rem generation works in the web app with no extra steps.
call :maybe_start_comfyui

echo.
echo Starting Visual Reader at http://localhost:5173
echo Keep this window open; press Ctrl+C to stop.
echo.
start "" /b cmd /c "timeout /t 5 >nul && start "" http://localhost:5173"
call pnpm dev:web
goto :eof

:maybe_start_comfyui
set "COMFYLAUNCHER=%USERPROFILE%\VisualReader\run-comfyui.bat"
if not exist "%COMFYLAUNCHER%" exit /b 0
rem Port check catches an instance that's already running OR still booting, so we
rem never start a second ComfyUI (port 8188 / its database can only have one).
netstat -ano | findstr ":8188" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [OK] Local ComfyUI is already running on port 8188.
  exit /b 0
)
echo [..] Starting local ComfyUI in a separate window ^(first start can take a bit^)...
start "Visual Reader - ComfyUI" "%COMFYLAUNCHER%"
exit /b 0
