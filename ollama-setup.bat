@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - Ollama (local text) setup

echo ================================================
echo    Visual Reader - Ollama (local text) setup
echo ================================================
echo.
echo This installs Ollama, the free local text engine Visual Reader uses to read
echo your book and write illustration prompts on YOUR machine (no API key, no
echo cloud). After this one-time setup you download the text models themselves
echo from inside the app: Settings -^> Text -^> On my computer -^> Local server.
echo.
echo No typing required beyond a couple of yes/no prompts.
echo.
pause

set "OLLAMA_URL=http://localhost:11434"
set "SETUP_EXE=%TEMP%\OllamaSetup.exe"

call :check_installed && goto :configure

rem ----- install: winget first, official installer as the fallback ------------
echo.
echo [..] Installing Ollama with winget...
where winget >nul 2>nul
if not errorlevel 1 (
  winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
)
call :check_installed && goto :configure

echo [..] winget didn't work; downloading the official installer instead...
curl -fL -C - -o "%SETUP_EXE%" "https://ollama.com/download/OllamaSetup.exe"
if errorlevel 1 (
  echo [X] Couldn't download Ollama. Check your connection, or install it
  echo     yourself from https://ollama.com/download and run this again.
  goto :end_fail
)
echo [..] Running the installer ^(silent^)...
start /wait "" "%SETUP_EXE%" /silent
del "%SETUP_EXE%" >nul 2>nul
call :check_installed && goto :configure
echo [X] Ollama still wasn't found after the install. Install it yourself from
echo     https://ollama.com/download and run ollama-setup.bat again.
goto :end_fail

:configure
echo.
rem Let the web app / extension call Ollama from a browser page. The desktop app
rem and terminal don't need this; without it the BROWSER paths are blocked by CORS.
echo [..] Allowing browser access ^(setting OLLAMA_ORIGINS=*^ for your user^)...
setx OLLAMA_ORIGINS "*" >nul
echo [OK] Browser access allowed ^(takes effect when Ollama restarts^)

rem ----- start the server and verify it answers ------------------------------
call :server_up && goto :finish
echo [..] Starting Ollama...
set "OLLAMA_EXE=ollama"
where ollama >nul 2>nul
if errorlevel 1 if exist "%LocalAppData%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LocalAppData%\Programs\Ollama\ollama.exe"
start "" /min "%OLLAMA_EXE%" serve
for /l %%i in (1,1,15) do (
  call :server_up && goto :finish
  timeout /t 1 >nul
)
echo [!] Ollama was installed but isn't answering yet at %OLLAMA_URL%.
echo     Start it from the Start menu (it then runs in the background), or open a
echo     NEW terminal and run:  ollama serve
goto :finish

:finish
echo.
echo ================================================
echo  Ollama is ready.
echo ================================================
echo.
echo  Now get a text model - no terminal needed:
echo    1. Start Visual Reader (start.bat) and open Settings.
echo    2. Set Text to "On my computer" -^> "Local server (Ollama ...)".
echo    3. Click Connect, then Download next to a model
echo       (Qwen 3 8B is the recommended default).
echo.
echo  Ollama runs in the background and starts with Windows from now on.
echo.
pause
exit /b 0

rem -------------------------------------------------------------------- helpers

:check_installed
where ollama >nul 2>nul
if not errorlevel 1 (
  echo [OK] Ollama is installed
  exit /b 0
)
if exist "%LocalAppData%\Programs\Ollama\ollama.exe" (
  echo [OK] Ollama is installed
  exit /b 0
)
exit /b 1

:server_up
curl -s -o nul -w "" "%OLLAMA_URL%/api/version" 2>nul
if errorlevel 1 exit /b 1
echo [OK] Ollama is running at %OLLAMA_URL%
exit /b 0

:end_fail
echo.
echo Setup did not finish. Please review the messages above and try again.
pause
exit /b 1
