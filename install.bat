@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - Setup

echo ==============================================
echo    Visual Reader - local setup
echo ==============================================
echo.
echo This will check prerequisites, install dependencies,
echo and open the app in your browser.
echo.

call :check_node || goto :end_fail
call :check_pnpm || goto :end_fail
call :install_deps || goto :end_fail
call :launch
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
  echo     Then run install.bat again.
  exit /b 1
)
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo [!] Node.js was just installed. Please CLOSE this window and run
echo     install.bat again so the updated PATH takes effect.
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

:launch
echo.
echo [OK] Setup complete. Starting the app...
rem Delegate to run.bat so the web app + local ComfyUI (if installed) start together.
call "%~dp0run.bat"
exit /b 0

:end_fail
echo.
echo Setup did not finish. Please review the messages above and try again.
pause
exit /b 1
