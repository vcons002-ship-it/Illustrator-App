@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - Extension

set "DIST=%~dp0apps\extension\dist"

if not exist "%DIST%\manifest.json" (
  echo The extension hasn't been built yet.
  echo Double-click  extension.bat  to build and load it the first time.
  echo.
  pause
  exit /b 1
)

echo The extension is built and ready. Make sure it's loaded in Chrome:
echo.
echo   First time:  go to chrome://extensions, turn on Developer mode,
echo                click "Load unpacked", and select:
echo                  %DIST%
echo   After a rebuild:  click the circular refresh icon on the
echo                     Visual Reader card at chrome://extensions.
echo.
echo Then open any article and click the Visual Reader toolbar icon.
echo.

start "" "%DIST%"
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if defined CHROME (
  start "" "%CHROME%" "chrome://extensions"
) else (
  echo [i] Chrome wasn't found automatically. Open Chrome and go to: chrome://extensions
)
echo.
pause
