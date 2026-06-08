@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - Full install

echo ================================================
echo    Visual Reader - FULL install (all versions)
echo ================================================
echo.
echo This sets up EVERYTHING for the web app, the desktop app, and the Chrome
echo extension: Node.js, pnpm, dependencies, Rust, the Visual C++ build tools,
echo the Tauri CLI, and a built extension. No typing required.
echo.
echo (It does NOT install AUTOMATIC1111 / ComfyUI — those are optional and set up
echo  separately. See SETUP.md.)
echo.
echo Some toolchains need a fresh window after install. If this script says it
echo just installed something and asks you to run it again, CLOSE this window and
echo double-click full-install.bat once more.
echo.
pause

call :check_node       || goto :end_fail
call :check_pnpm       || goto :end_fail
call :install_deps     || goto :end_fail
call :check_rust       || goto :end_fail
call :check_buildtools || goto :end_fail
call :check_tauri_cli  || goto :end_fail
call :build_ext        || goto :end_fail
call :menu
goto :eof

rem ---------------------------------------------------------------- prerequisites

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
  echo     Then run full-install.bat again.
  exit /b 1
)
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo [!] Node.js was just installed. Please CLOSE this window and run
echo     full-install.bat again so the updated PATH takes effect.
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

:check_rust
where cargo >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%v in ('cargo --version') do echo [OK] %%v found
  exit /b 0
)
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
  echo [OK] Rust found ^(added ~\.cargo\bin to PATH for this session^)
  exit /b 0
)
echo [..] Rust was not found. Trying to install it with winget...
where winget >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] Could not find winget to auto-install Rust.
  echo     Please install Rust from https://rustup.rs and run full-install.bat again.
  exit /b 1
)
winget install -e --id Rustlang.Rustup --accept-source-agreements --accept-package-agreements
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
if exist "%USERPROFILE%\.cargo\bin\rustup.exe" call "%USERPROFILE%\.cargo\bin\rustup.exe" default stable >nul 2>nul
where cargo >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Rust was just installed. Please CLOSE this window and run
  echo     full-install.bat again so the updated PATH takes effect.
  exit /b 1
)
for /f "delims=" %%v in ('cargo --version') do echo [OK] %%v installed
exit /b 0

:check_buildtools
set "VCDIR="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
  for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VCDIR=%%i"
)
if defined VCDIR (
  echo [OK] Visual C++ build tools found
  exit /b 0
)
echo [..] Visual C++ build tools ^(needed to compile the desktop app^) were not found.
echo      Trying to install them with winget. This is a large download.
where winget >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] Could not find winget to auto-install the build tools.
  echo     Install "Desktop development with C++" from the Visual Studio
  echo     Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/
  echo     Then run full-install.bat again.
  exit /b 1
)
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
echo.
echo [!] Visual C++ build tools were just installed. Please CLOSE this window
echo     and run full-install.bat again so the toolchain is picked up.
exit /b 1

:check_tauri_cli
call cargo tauri --version >nul 2>nul
if not errorlevel 1 (
  echo [OK] Tauri CLI found
  exit /b 0
)
echo [..] Installing the Tauri CLI ^(cargo install tauri-cli^)... this can take a few minutes.
call cargo install tauri-cli --version 2 --locked
call cargo tauri --version >nul 2>nul
if errorlevel 1 (
  echo [X] Could not install the Tauri CLI automatically.
  echo     Try manually:  cargo install tauri-cli --version 2 --locked
  exit /b 1
)
echo [OK] Tauri CLI ready
exit /b 0

:build_ext
echo.
echo [..] Building the Chrome extension...
call pnpm --filter @visual-reader/extension build
if errorlevel 1 (
  echo [X] The extension build failed. Review the messages above.
  exit /b 1
)
echo [OK] Extension built
exit /b 0

rem ---------------------------------------------------------------- launch menu

:menu
echo.
echo ================================================
echo  All set. Everything is installed and ready.
echo ================================================
echo.
echo  What would you like to start now?
echo.
echo    [1] Web app          (opens in your browser)
echo    [2] Desktop app      (native window)
echo    [3] Chrome extension (opens the folder + Chrome to load it)
echo    [4] Nothing - exit
echo.
set "choice="
set /p "choice=Type 1, 2, 3, or 4 and press Enter: "
if "%choice%"=="1" goto :start_web
if "%choice%"=="2" goto :start_desktop
if "%choice%"=="3" goto :load_ext
echo.
echo Done. Later you can use:  run.bat (web), desktop.bat, or extension.bat.
exit /b 0

:start_web
rem Delegate to run.bat so the web app + local ComfyUI (if installed) start together.
call "%~dp0run.bat"
exit /b 0

:start_desktop
echo.
echo Building and starting the desktop app ^(first build can take several minutes^)...
echo A window opens when it is ready. Keep this window open; press Ctrl+C to stop.
cd /d "%~dp0apps\desktop\src-tauri"
call cargo tauri dev
exit /b 0

:load_ext
set "DIST=%~dp0apps\extension\dist"
echo.
echo Opening the extension folder and Chrome. In Chrome:
echo   1. Turn ON "Developer mode" (top-right).
echo   2. Click "Load unpacked".
echo   3. Select this folder:  %DIST%
echo   4. Click the Visual Reader toolbar icon on any article.
start "" "%DIST%"
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if defined CHROME (
  start "" "%CHROME%" "chrome://extensions"
) else (
  echo  [i] Chrome wasn't found automatically. Open Chrome and go to: chrome://extensions
)
echo.
pause
exit /b 0

:end_fail
echo.
echo Install did not finish. Please review the messages above and try again.
pause
exit /b 1
