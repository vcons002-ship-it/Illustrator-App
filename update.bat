@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem cmd reads batch files as it runs them. Never git-pull over the active worker.
set "VR_UPDATE_ROOT=%~dp0"
:choose_worker
set "VR_UPDATE_SCRIPT=%TEMP%\visual-reader-update-%RANDOM%-%RANDOM%.bat"
if exist "%VR_UPDATE_SCRIPT%" goto :choose_worker
copy /b "%~dp0scripts\windows-update-worker.bat" "%VR_UPDATE_SCRIPT%" >nul
if errorlevel 1 (
  echo [X] Could not prepare a stable updater. Nothing was updated.
  exit /b 1
)
rem Parse this ENTIRE block before the worker can replace update.bat via git pull.
rem Keep the tiny temp worker for diagnostics; CALL expands the result after it runs.
(
  call "%VR_UPDATE_SCRIPT%"
  call exit /b %%errorlevel%%
)
