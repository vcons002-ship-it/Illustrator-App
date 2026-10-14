@echo off
rem Never terminate the app or touch its profile. Windows locks a running exe.
tasklist /FI "IMAGENAME eq visual-reader-desktop.exe" /NH 2>nul | find /I "visual-reader-desktop.exe" >nul
if not errorlevel 1 (
  echo [X] Visual Reader is still running. Close it before rebuilding or updating.
  echo     If its window is gone or frozen, use Task Manager to end Visual Reader,
  echo     then retry. Do not delete or reset the app data folder.
  exit /b 1
)
exit /b 0
