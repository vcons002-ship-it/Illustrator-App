@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - GitHub (git + gh) setup

echo ================================================
echo    Visual Reader - GitHub setup (git + gh CLI)
echo ================================================
echo.
echo This installs the two tools the desktop assistant needs to work with your
echo GitHub repos - Git and the GitHub CLI (gh) - so it can clone, branch, commit,
echo push, open pull requests, and manage issues. You approve every command.
echo.
echo After this, give it access ONE of two ways:
echo   - EASIEST (in-app): paste a token in the app's Settings -^> "GitHub token".
echo   - OR sign in to gh yourself (this script can do it) to use git/gh in a
echo     terminal - and the assistant will use that login too once a token is set.
echo.
echo No typing required beyond a couple of yes/no prompts.
echo.
pause

call :ensure_git || goto :end_fail
call :ensure_gh  || goto :end_fail
call :auth
goto :finish

rem -------------------------------------------------------------------- helpers

:ensure_git
where git >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%v in ('git --version') do echo [OK] %%v found
  exit /b 0
)
echo [..] Git was not found. Trying to install it with winget...
where winget >nul 2>nul
if errorlevel 1 (
  echo [X] Could not find winget to auto-install Git.
  echo     Install Git from https://git-scm.com/download/win and run this again.
  exit /b 1
)
winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Git was just installed. Please CLOSE this window and run
  echo     github-setup.bat again so the updated PATH takes effect.
  exit /b 1
)
echo [OK] Git installed
exit /b 0

:ensure_gh
where gh >nul 2>nul
if not errorlevel 1 (
  echo [OK] GitHub CLI ^(gh^) found
  exit /b 0
)
echo [..] The GitHub CLI (gh) was not found. Trying to install it with winget...
where winget >nul 2>nul
if errorlevel 1 (
  echo [X] Could not find winget to auto-install gh.
  echo     Install it from https://cli.github.com and run this again.
  exit /b 1
)
winget install -e --id GitHub.cli --accept-source-agreements --accept-package-agreements
where gh >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] gh was just installed. Please CLOSE this window and run
  echo     github-setup.bat again so the updated PATH takes effect.
  exit /b 1
)
echo [OK] GitHub CLI installed
exit /b 0

:auth
echo.
echo [?] Sign in to GitHub now with the gh CLI?
echo     This lets you use git/gh in a terminal without a token, and the assistant
echo     will reuse this login. (For the in-app assistant you ALSO paste a token in
echo     Settings - that is what it injects when running commands.)
set "ans="
set /p "ans=Type Y to sign in now, or just press Enter to skip: "
if /i "%ans%"=="Y" (
  gh auth login
  echo [..] Configuring git to use your gh login for pushes...
  gh auth setup-git
)
exit /b 0

:finish
echo.
echo ================================================
echo  Git + GitHub CLI are ready.
echo ================================================
echo.
echo  To let the desktop assistant work with your repos:
echo    1. Start the DESKTOP app (desktop.bat).
echo    2. Settings -^> turn ON "Let the assistant run commands".
echo    3. Settings -^> paste a GitHub token in "GitHub token"
echo       (create one at https://github.com/settings/tokens - give it
echo        Contents + Pull requests + Issues access for the repos you want).
echo.
echo  Then just ask, e.g. "clone my-user/my-repo and open a PR that fixes the README".
echo  You approve every command; the token is never shown to the model or printed.
echo.
pause
exit /b 0

:end_fail
echo.
echo Setup did not finish. Please review the messages above and try again.
pause
exit /b 1
