@echo off
rem Called by launchers before probing tools. Deliberately no setlocal: the
rem caller owns the environment scope, and child builds need this PATH too.
rem Preserve tools already on PATH; append only existing standard installs.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%PATH%;%ProgramFiles%\nodejs"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%PATH%;%LOCALAPPDATA%\Programs\nodejs"
if exist "%APPDATA%\npm\pnpm.cmd" set "PATH=%PATH%;%APPDATA%\npm"
if defined PNPM_HOME if exist "%PNPM_HOME%\pnpm.exe" set "PATH=%PATH%;%PNPM_HOME%"
if exist "%LOCALAPPDATA%\pnpm\pnpm.exe" set "PATH=%PATH%;%LOCALAPPDATA%\pnpm"
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%PATH%;%USERPROFILE%\.cargo\bin"
exit /b 0
