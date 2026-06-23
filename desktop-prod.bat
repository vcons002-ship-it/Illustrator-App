@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - Desktop (packaged build)

echo ================================================
echo   Visual Reader - Desktop (PACKAGED build)
echo ================================================
echo.
echo This builds the FULL desktop app with the web UI EMBEDDED, then runs it.
echo It is the right mode for the phone link / Cloudflare tunnel: the relay
echo serves a built, cache-headed bundle (fast + always fresh) instead of
echo proxying the dev server like "cargo tauri dev" (run-desktop.bat) does.
echo.
echo The first build can take several minutes. Re-run this after every update
echo (update.bat / git pull) so the phone gets the new UI.
echo.
pause

if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
call cargo tauri --version >nul 2>nul
if errorlevel 1 (
  echo [X] Tauri CLI not found. Run full-install.bat once first.
  pause
  exit /b 1
)

echo [..] Building the packaged desktop app (rebuilds + embeds the web bundle)...
cd /d "%~dp0apps\desktop\src-tauri"
call cargo tauri build --no-bundle
if errorlevel 1 (
  echo.
  echo [X] Build failed. Review the messages above.
  pause
  exit /b 1
)

set "EXE=%~dp0apps\desktop\src-tauri\target\release\visual-reader-desktop.exe"
if not exist "%EXE%" (
  echo.
  echo [X] Built, but couldn't find the executable at:
  echo     %EXE%
  echo     Check the build output above for the actual path.
  pause
  exit /b 1
)
echo.
echo [OK] Built. Launching the desktop app...
start "" "%EXE%"
exit /b 0
