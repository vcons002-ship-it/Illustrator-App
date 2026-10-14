@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - Desktop
call "%~dp0scripts\windows-tool-path.bat"

if /i "%~1"=="--dev" goto :dev
call "%~dp0scripts\windows-desktop-closed.bat"
if errorlevel 1 (
  pause
  exit /b 1
)
set "EXE=%~dp0apps\desktop\src-tauri\target\release\visual-reader-desktop.exe"
if not exist "%EXE%" goto :build
echo Starting the packaged Visual Reader desktop app, using your saved desktop data...
echo Run update.bat to update this build; developer mode is run-desktop.bat --dev.
start "" "%EXE%"
exit /b 0

:build
call "%~dp0desktop-prod.bat"
exit /b %errorlevel%

:dev
echo DEVELOPER MODE: localhost:5173 uses a separate data store from the packaged app.
echo Your shortcut chats are not missing; use run-desktop.bat without --dev to see them.
call cargo tauri --version >nul 2>nul
if errorlevel 1 (
  echo The desktop app is not set up yet. Run desktop.bat first.
  pause
  exit /b 1
)
cd /d "%~dp0apps\desktop\src-tauri"
call cargo tauri dev
exit /b %errorlevel%
