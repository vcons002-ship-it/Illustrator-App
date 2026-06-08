@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - Desktop setup

echo ==============================================
echo    Visual Reader - desktop app setup
echo ==============================================
echo.
echo This sets up the native desktop app (Tauri). It checks prerequisites
echo (Node.js, pnpm, Rust, Visual C++ build tools, the Tauri CLI), installs
echo anything missing, then builds and opens the desktop window.
echo.
echo The FIRST run compiles the Rust shell and can take several minutes.
echo Later runs are fast.
echo.

call :check_node      || goto :end_fail
call :check_pnpm      || goto :end_fail
call :install_deps    || goto :end_fail
call :check_rust      || goto :end_fail
call :check_buildtools || goto :end_fail
call :check_tauri_cli || goto :end_fail
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
  echo     Then run desktop.bat again.
  exit /b 1
)
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo [!] Node.js was just installed. Please CLOSE this window and run
echo     desktop.bat again so the updated PATH takes effect.
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
echo [..] Installing web dependencies ^(the desktop app renders the web UI^)...
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
  echo     Please install Rust from https://rustup.rs and run desktop.bat again.
  exit /b 1
)
winget install -e --id Rustlang.Rustup --accept-source-agreements --accept-package-agreements
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
if exist "%USERPROFILE%\.cargo\bin\rustup.exe" call "%USERPROFILE%\.cargo\bin\rustup.exe" default stable >nul 2>nul
where cargo >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Rust was just installed. Please CLOSE this window and run
  echo     desktop.bat again so the updated PATH takes effect.
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
echo [..] Visual C++ build tools ^(needed to compile Rust^) were not found.
echo      Trying to install them with winget. This is a large download.
where winget >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] Could not find winget to auto-install the build tools.
  echo     Install "Desktop development with C++" from the Visual Studio
  echo     Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/
  echo     Then run desktop.bat again.
  exit /b 1
)
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
echo.
echo [!] Visual C++ build tools were just installed. Please CLOSE this window
echo     and run desktop.bat again so the toolchain is picked up.
exit /b 1

:check_tauri_cli
call cargo tauri --version >nul 2>nul
if not errorlevel 1 (
  echo [OK] Tauri CLI found
  exit /b 0
)
echo [..] Installing the Tauri CLI ^(cargo install tauri-cli^)... this can take a few minutes.
cargo install tauri-cli --version "^2" --locked
call cargo tauri --version >nul 2>nul
if errorlevel 1 (
  echo [X] Could not install the Tauri CLI automatically.
  echo     Try manually:  cargo install tauri-cli --version "^2" --locked
  exit /b 1
)
echo [OK] Tauri CLI ready
exit /b 0

:launch
echo.
echo [OK] Setup complete. Building and starting the desktop app...
echo     The first build compiles the Rust shell and may take several minutes.
echo     A desktop window opens when it's ready. Keep this window open while
echo     using the app; press Ctrl+C here to stop.
echo.
cd /d "%~dp0apps\desktop\src-tauri"
call cargo tauri dev
exit /b 0

:end_fail
echo.
echo Setup did not finish. Please review the messages above and try again.
pause
exit /b 1
