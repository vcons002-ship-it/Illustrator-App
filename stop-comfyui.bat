@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Visual Reader - stop ComfyUI

echo ================================================
echo    Visual Reader - stop ComfyUI on port 8188
echo ================================================
echo.
echo Use this to clear a stuck or duplicate ComfyUI (e.g. "Port 8188 is already
echo in use" or a database-lock error). It stops EVERY process listening on
echo port 8188, so afterwards you can start exactly one ComfyUI.
echo.

set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8188" ^| findstr "LISTENING"') do (
  set "FOUND=1"
  echo [..] Stopping ComfyUI process PID %%p ...
  taskkill /f /pid %%p >nul 2>nul && echo [OK] Stopped PID %%p || echo [X] Could not stop PID %%p ^(try closing its window manually^).
)

if not defined FOUND (
  echo [OK] Nothing is listening on port 8188 - you're clear to start one ComfyUI.
)

echo.
echo Now start exactly ONE ComfyUI:
echo   - the app-managed one:  %USERPROFILE%\VisualReader\run-comfyui.bat
echo   - or your own install (start it with  --enable-cors-header  so the app can
echo     connect), then in the app: Settings - Images - On my computer - Connect.
echo.
pause
