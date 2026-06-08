@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - Update

echo ==============================================
echo    Visual Reader - update
echo ==============================================
echo.
echo This pulls the latest code, refreshes dependencies, and rebuilds the web app
echo and Chrome extension. (The per-version scripts only rebuild the code you
echo already have on disk; this also fetches new code.)
echo.

call :git_update   || goto :end_fail
call :check_node   || goto :end_fail
call :check_pnpm   || goto :end_fail
call :install_deps || goto :end_fail
call :build_all    || goto :end_fail
call :desktop_opt
call :finish
goto :eof

:git_update
where git >nul 2>nul
if errorlevel 1 (
  echo [X] Git isn't installed, so this folder can't auto-update.
  echo     Install Git ^(https://git-scm.com^) or re-download the latest project ZIP.
  exit /b 1
)
if not exist ".git" (
  echo [X] This folder isn't a Git checkout ^(you may have unzipped a download^).
  echo     Re-download the latest ZIP, or get it with:  git clone ^<repo-url^>
  exit /b 1
)
echo [..] Pulling the latest code...
call git pull
if errorlevel 1 (
  echo.
  echo [X] "git pull" failed. If you changed files locally, set them aside first:
  echo        git stash
  echo     then run update.bat again.
  exit /b 1
)
echo [OK] Code updated
exit /b 0

:check_node
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js was not found. Run install.bat once first ^(it installs Node.js^).
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo [OK] Node.js %%v found
exit /b 0

:check_pnpm
where pnpm >nul 2>nul
if not errorlevel 1 (
  echo [OK] pnpm found
  exit /b 0
)
echo [..] Enabling pnpm via Corepack...
call corepack enable >nul 2>nul
call corepack prepare pnpm@10.33.0 --activate >nul 2>nul
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [X] pnpm not available. Run install.bat once first.
  exit /b 1
)
echo [OK] pnpm ready
exit /b 0

:install_deps
echo.
echo [..] Refreshing dependencies ^(only changed/new packages download^)...
call pnpm install
if errorlevel 1 (
  echo [X] "pnpm install" failed. Check the messages above and your connection.
  exit /b 1
)
echo [OK] Dependencies up to date
exit /b 0

:build_all
echo.
echo [..] Rebuilding packages, the web app, and the extension...
call pnpm -r build
if errorlevel 1 (
  echo [X] Build failed. Review the messages above.
  exit /b 1
)
echo [OK] Rebuilt
exit /b 0

:desktop_opt
rem Optional desktop rebuild, only when the Rust/Tauri toolchain is already set up.
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
call cargo tauri --version >nul 2>nul
if errorlevel 1 (
  echo [i] Desktop toolchain not found - skipping the desktop rebuild.
  echo     ^(If you use the desktop app, run desktop.bat; it recompiles on launch.^)
  exit /b 0
)
set "ANS="
set /p "ANS=Rebuild the desktop app too? It can take a few minutes. (y/N): "
if /i not "%ANS%"=="y" (
  echo Skipped the desktop rebuild ^(run-desktop.bat recompiles on launch anyway^).
  exit /b 0
)
echo [..] Rebuilding the desktop app...
cd /d "%~dp0apps\desktop\src-tauri"
call cargo tauri build
cd /d "%~dp0"
echo [OK] Desktop app rebuilt
exit /b 0

:finish
echo.
echo ==============================================
echo  Update complete.
echo ==============================================
echo.
echo  Start it again with start.bat ^(or run.bat / run-desktop.bat^).
echo  Using the Chrome extension? Click the refresh icon on the Visual Reader
echo  card at chrome://extensions to load the new build.
echo  Updating ComfyUI too? Run:  comfyui-setup.bat --upgrade
echo.
pause
exit /b 0

:end_fail
echo.
echo Update did not finish. Review the messages above and try again.
pause
exit /b 1
