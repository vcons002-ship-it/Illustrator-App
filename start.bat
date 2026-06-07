@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - Start

:menu
cls
echo ================================================
echo            Visual Reader - what to start
echo ================================================
echo.
echo    [1] Web app           (opens in your browser)
echo    [2] Desktop app       (native window)
echo    [3] Chrome extension  (opens the folder + Chrome)
echo    [4] Local ComfyUI     (your own GPU image engine)
echo    [5] Exit
echo.
echo  First time? Use the matching installer instead:
echo    web/all = install.bat or full-install.bat,  desktop = desktop.bat,
echo    extension = extension.bat,  ComfyUI = comfyui-setup.bat
echo.
set "choice="
set /p "choice=Type 1-5 and press Enter: "

if "%choice%"=="1" goto :web
if "%choice%"=="2" goto :desktop
if "%choice%"=="3" goto :ext
if "%choice%"=="4" goto :comfyui
if "%choice%"=="5" goto :eof

echo.
echo Please type a number from 1 to 5.
timeout /t 2 >nul
goto :menu

:web
call "%~dp0run.bat"
goto :eof

:desktop
call "%~dp0run-desktop.bat"
goto :eof

:ext
call "%~dp0run-extension.bat"
goto :eof

:comfyui
set "COMFY=%USERPROFILE%\VisualReader\run-comfyui.bat"
if exist "%COMFY%" (
  echo Starting ComfyUI...
  start "" "%COMFY%"
) else (
  echo ComfyUI isn't installed yet. Double-click  comfyui-setup.bat  first.
  echo.
  pause
)
goto :eof
