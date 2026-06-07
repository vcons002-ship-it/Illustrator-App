@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - Chrome extension

echo ==============================================
echo    Visual Reader - Chrome extension build
echo ==============================================
echo.
echo This builds the browser extension and opens the folder + Chrome so you
echo can load it. No typing required.
echo.

call :check_node   || goto :end_fail
call :check_pnpm   || goto :end_fail
call :install_deps || goto :end_fail
call :build_ext    || goto :end_fail
call :finish
goto :eof

:check_node
where node >nul 2>nul
if errorlevel 1 goto :install_node
for /f "delims=" %%v in ('node --version') do echo [OK] Node.js %%v found
exit /b 0

:install_node
echo [..] Node.js was not found. Trying to install it with winget...
where winget >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] Could not find winget to auto-install Node.js.
  echo     Please install Node.js LTS ^(v20 or newer^) from:
  echo         https://nodejs.org/en/download
  echo     Then run extension.bat again.
  exit /b 1
)
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo [!] Node.js was just installed. Please CLOSE this window and run
echo     extension.bat again so the updated PATH takes effect.
exit /b 1

:check_pnpm
where pnpm >nul 2>nul
if not errorlevel 1 (
  echo [OK] pnpm found
  exit /b 0
)
echo [..] Enabling pnpm via Corepack ^(bundled with Node.js^)...
call corepack enable >nul 2>nul
call corepack prepare pnpm@10.33.0 --activate >nul 2>nul
where pnpm >nul 2>nul
if not errorlevel 1 (
  echo [OK] pnpm ready
  exit /b 0
)
echo [..] Corepack unavailable; installing pnpm via npm...
call npm install -g pnpm
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [X] Could not install pnpm automatically.
  echo     Try manually:  npm install -g pnpm
  exit /b 1
)
echo [OK] pnpm installed
exit /b 0

:install_deps
echo.
echo [..] Installing dependencies ^(first run can take a minute^)...
call pnpm install
if errorlevel 1 (
  echo [X] "pnpm install" failed. Check your internet connection and the messages above.
  exit /b 1
)
echo [OK] Dependencies installed
exit /b 0

:build_ext
echo.
echo [..] Building the extension...
call pnpm --filter @visual-reader/extension build
if errorlevel 1 (
  echo [X] The extension build failed. Review the messages above.
  exit /b 1
)
echo [OK] Extension built
exit /b 0

:finish
set "DIST=%~dp0apps\extension\dist"
echo.
echo ==============================================
echo  Build complete. Load it into Chrome (one time):
echo ==============================================
echo.
echo   1. The extension folder and Chrome's Extensions page are opening now.
echo   2. In Chrome, turn ON "Developer mode" (toggle, top-right).
echo   3. Click "Load unpacked".
echo   4. Select this folder:
echo        %DIST%
echo   5. Open any article and click the Visual Reader toolbar icon (puzzle-piece
echo      menu) to show the panel. Open its Settings to add keys or a local server.
echo.
echo  After changing the code, run extension.bat again, then click the circular
echo  refresh icon on the Visual Reader card at chrome://extensions.
echo.
start "" "%DIST%"
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if defined CHROME (
  start "" "%CHROME%" "chrome://extensions"
) else (
  echo  [i] Chrome wasn't found automatically. Open Chrome yourself and go to:
  echo        chrome://extensions
)
echo.
pause
exit /b 0

:end_fail
echo.
echo Build did not finish. Please review the messages above and try again.
pause
exit /b 1
