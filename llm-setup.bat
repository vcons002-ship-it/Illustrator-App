@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Visual Reader - Built-in text model setup

echo ================================================
echo    Visual Reader - Built-in text model setup
echo ================================================
echo.
echo This downloads the small local text model the desktop app ships and runs on
echo its own (the "Built-in model" Text option): a llama.cpp server + a ~3B GGUF.
echo They go into apps\desktop\src-tauri\resources\llm so a desktop BUILD bundles
echo them into the installer. (At runtime the app can also fetch them into
echo %%USERPROFILE%%\VisualReader\llm, but bundling = zero setup for end users.)
echo.
echo Total download is about 2 GB. It runs on the CPU, so it never competes with a
echo local GPU image engine for VRAM. For faster local text, use Ollama instead.
echo.
pause

rem ---- Edit these to swap the model / llama.cpp build ------------------------
rem llama.cpp Windows CPU server (no CUDA dependency -> runs on any machine).
set "LLAMA_BUILD=b4604"
set "LLAMA_ZIP=llama-%LLAMA_BUILD%-bin-win-cpu-x64.zip"
set "LLAMA_URL=https://github.com/ggml-org/llama.cpp/releases/download/%LLAMA_BUILD%/%LLAMA_ZIP%"
rem The ~3B Q4 model. Must match BUNDLED_GGUF_FILE in main.rs + BUNDLED_LLM in catalog.ts.
set "GGUF_FILE=Llama-3.2-3B-Instruct-Q4_K_M.gguf"
set "GGUF_URL=https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/%GGUF_FILE%"
rem ---------------------------------------------------------------------------

set "DEST=apps\desktop\src-tauri\resources\llm"
if not exist "%DEST%" mkdir "%DEST%"

echo.
echo [1/3] Downloading the model weights (~2 GB, resumes if interrupted)...
if exist "%DEST%\%GGUF_FILE%" (
  echo       already present - skipping.
) else (
  powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '%GGUF_URL%' -OutFile '%DEST%\%GGUF_FILE%.part'; Move-Item -Force '%DEST%\%GGUF_FILE%.part' '%DEST%\%GGUF_FILE%'" || goto :fail
)

echo.
echo [2/3] Downloading the llama.cpp server (%LLAMA_ZIP%)...
if exist "%DEST%\llama-server.exe" (
  echo       already present - skipping.
) else (
  powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '%LLAMA_URL%' -OutFile '%TEMP%\%LLAMA_ZIP%'" || goto :fail
  echo [3/3] Unpacking llama-server.exe + its DLLs...
  powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $tmp=Join-Path $env:TEMP 'vr-llama'; if(Test-Path $tmp){Remove-Item -Recurse -Force $tmp}; Expand-Archive -Path '%TEMP%\%LLAMA_ZIP%' -DestinationPath $tmp -Force; Get-ChildItem -Path $tmp -Recurse -Include 'llama-server.exe','*.dll' | ForEach-Object { Copy-Item $_.FullName -Destination '%DEST%' -Force }" || goto :fail
  del "%TEMP%\%LLAMA_ZIP%" >nul 2>nul
)

echo.
echo Done. The built-in model is staged in:
echo   %CD%\%DEST%
echo.
echo Build the desktop app (desktop.bat or "pnpm build:desktop") and it ships inside
echo the installer; the app launches it automatically on first use.
echo.
pause
exit /b 0

:fail
echo.
echo [!] Download failed. Check your internet connection and try again. If the
echo     llama.cpp build %LLAMA_BUILD% is gone, set LLAMA_BUILD to a current release
echo     from https://github.com/ggml-org/llama.cpp/releases and re-run.
echo.
pause
exit /b 1
