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
set "RUNNING="
where curl >nul 2>nul && curl -s -o nul --max-time 2 http://127.0.0.1:8188/system_stats && set "RUNNING=1"
if defined RUNNING (
  echo [OK] Local ComfyUI is already running.
  exit /b 0
)
echo [..] Starting local ComfyUI in a separate window ^(first start can take a bit^)...
start "Visual Reader - ComfyUI" "%COMFYLAUNCHER%"
exit /b 0
