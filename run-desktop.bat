@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - Desktop

if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

call cargo tauri --version >nul 2>nul
if errorlevel 1 (
  echo The desktop app isn't set up yet.
  echo Double-click  desktop.bat  once to install the toolchain, then use this to run.
  echo.
  pause
  exit /b 1
)

echo Starting the Visual Reader desktop app...
echo The first build can take a few minutes; a window opens when it's ready.
echo Keep this window open while using the app; press Ctrl+C to stop.
echo.
cd /d "%~dp0apps\desktop\src-tauri"
call cargo tauri dev
