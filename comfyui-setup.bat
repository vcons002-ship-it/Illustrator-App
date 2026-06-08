@echo off
setlocal
cd /d "%~dp0"
title Visual Reader - ComfyUI setup

echo ================================================
echo    Visual Reader - ComfyUI (local GPU) setup
echo ================================================
echo.
echo This downloads the official ComfyUI portable build (it includes its own
echo Python, so nothing else is installed system-wide), grabs a starter image
echo model, and creates a launcher that lets Visual Reader connect to it.
echo.
echo It is a LARGE download (several GB) and best with an NVIDIA GPU; it will
echo fall back to CPU (slow) otherwise. No typing required beyond a couple of
echo yes/no prompts.
echo.
echo Already installed? Re-running offers to UPDATE ComfyUI to the latest, in
echo place — nothing you've added (models, custom_nodes, workflows, settings) is
echo deleted. Pass  --upgrade  to update without asking, or  --clean  for a
echo from-scratch engine that still preserves your models and custom_nodes.
echo.
pause

rem ----- where things go (kept out of the project folder) -------------------
set "ROOT=%USERPROFILE%\VisualReader"
set "PORTABLE=%ROOT%\ComfyUI_windows_portable"
set "TMP7Z=%TEMP%\ComfyUI_windows_portable.7z"
set "PORTABLE_URL=https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z"
set "MODELNAME=v1-5-pruned-emaonly-fp16.safetensors"
set "MODELURL=https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors"
set "LAUNCHER=%ROOT%\run-comfyui.bat"

set "UPGRADE="
set "CLEAN="
if /i "%~1"=="--upgrade" set "UPGRADE=1"
if /i "%~1"=="upgrade" set "UPGRADE=1"
if /i "%~1"=="--clean" (
  set "UPGRADE=1"
  set "CLEAN=1"
)

call :check_curl || goto :end_fail
if not exist "%ROOT%" mkdir "%ROOT%"

if not exist "%PORTABLE%\python_embeded\python.exe" goto :install
rem --- already installed: keep, or update to latest ---
if defined UPGRADE goto :upgrade
echo.
echo [OK] ComfyUI is already installed at "%PORTABLE%".
set "ANS="
set /p "ANS=Update it to the latest now? Keeps everything you've set up. (y/N): "
if /i "%ANS%"=="y" goto :upgrade
echo Keeping the current install.
goto :after_install

:upgrade
echo.
if defined CLEAN (
  echo [..] CLEAN re-install to the latest. Your models, custom_nodes, saved
  echo      workflows, inputs/outputs and config are moved aside and restored;
  echo      only the engine code + bundled Python are replaced.
  echo      [!] Custom-node Python dependencies may need reinstalling afterwards.
) else (
  echo [..] Updating ComfyUI to the latest in place. Nothing is deleted — your
  echo      models, custom_nodes, workflows and settings are all kept. (For a
  echo      from-scratch engine, run:  comfyui-setup.bat --clean)
)
del "%TMP7Z%" >nul 2>nul
if defined CLEAN call :preserve_userdata

:install
call :get_7zip   || goto :end_fail
call :download   || goto :end_fail
call :extract    || goto :end_fail

:after_install
rem Restore any user data set aside by a --clean run (also recovers a failed one).
call :restore_userdata
call :get_model
call :write_launcher
call :finish
goto :eof

rem ----- preserve/restore user data across a --clean re-install ---------------
:preserve_userdata
set "BAK=%ROOT%\_userdata_backup"
if exist "%BAK%" rmdir /s /q "%BAK%"
mkdir "%BAK%" >nul 2>nul
for %%D in (models custom_nodes user input output) do (
  if exist "%PORTABLE%\ComfyUI\%%D" move "%PORTABLE%\ComfyUI\%%D" "%BAK%\%%D" >nul
)
if exist "%PORTABLE%\ComfyUI\extra_model_paths.yaml" move "%PORTABLE%\ComfyUI\extra_model_paths.yaml" "%BAK%\extra_model_paths.yaml" >nul
if exist "%PORTABLE%" rmdir /s /q "%PORTABLE%"
exit /b 0

:restore_userdata
set "BAK=%ROOT%\_userdata_backup"
if not exist "%BAK%" exit /b 0
for %%D in (models custom_nodes user input output) do (
  if exist "%BAK%\%%D" (
    if exist "%PORTABLE%\ComfyUI\%%D" rmdir /s /q "%PORTABLE%\ComfyUI\%%D"
    move "%BAK%\%%D" "%PORTABLE%\ComfyUI\%%D" >nul
  )
)
if exist "%BAK%\extra_model_paths.yaml" move /y "%BAK%\extra_model_paths.yaml" "%PORTABLE%\ComfyUI\extra_model_paths.yaml" >nul
rmdir /s /q "%BAK%" 2>nul
exit /b 0

rem -------------------------------------------------------------------- steps

:check_curl
where curl >nul 2>nul
if errorlevel 1 (
  echo [X] curl was not found. It ships with Windows 10/11 — please update Windows,
  echo     or download ComfyUI portable manually from:
  echo         https://github.com/comfyanonymous/ComfyUI/releases/latest
  exit /b 1
)
echo [OK] curl found
exit /b 0

:get_7zip
set "SEVENZIP="
if exist "%ProgramFiles%\7-Zip\7z.exe" set "SEVENZIP=%ProgramFiles%\7-Zip\7z.exe"
if not defined SEVENZIP if exist "%ProgramFiles(x86)%\7-Zip\7z.exe" set "SEVENZIP=%ProgramFiles(x86)%\7-Zip\7z.exe"
if defined SEVENZIP (
  echo [OK] 7-Zip found
  exit /b 0
)
echo [..] 7-Zip ^(to unpack the .7z^) not found. Installing it with winget...
where winget >nul 2>nul
if not errorlevel 1 (
  winget install -e --id 7zip.7zip --accept-source-agreements --accept-package-agreements
  if exist "%ProgramFiles%\7-Zip\7z.exe" set "SEVENZIP=%ProgramFiles%\7-Zip\7z.exe"
)
if defined SEVENZIP (
  echo [OK] 7-Zip installed
  exit /b 0
)
echo [!] Couldn't install 7-Zip; will try Windows' built-in tar instead.
exit /b 0

:download
echo.
echo [..] Downloading ComfyUI portable ^(several GB; resumes if interrupted^)...
curl -L -C - -o "%TMP7Z%" "%PORTABLE_URL%"
if errorlevel 1 (
  echo [X] Download failed. Check your connection and run comfyui-setup.bat again
  echo     ^(it resumes where it left off^).
  exit /b 1
)
echo [OK] Downloaded
exit /b 0

:extract
echo.
echo [..] Unpacking into "%ROOT%" ^(this takes a few minutes^)...
if defined SEVENZIP (
  "%SEVENZIP%" x "%TMP7Z%" -o"%ROOT%" -y >nul
) else (
  tar -xf "%TMP7Z%" -C "%ROOT%"
)
if not exist "%PORTABLE%\python_embeded\python.exe" (
  echo [X] Unpacking didn't produce the expected files. If you don't have 7-Zip,
  echo     install it from https://www.7-zip.org and run comfyui-setup.bat again.
  exit /b 1
)
del "%TMP7Z%" >nul 2>nul
echo [OK] Unpacked
exit /b 0

:get_model
set "MODELDIR=%PORTABLE%\ComfyUI\models\checkpoints"
if not exist "%MODELDIR%" mkdir "%MODELDIR%"
if exist "%MODELDIR%\%MODELNAME%" (
  echo [OK] A starter model is already present.
  exit /b 0
)
echo.
echo [..] Downloading a starter model ^(Stable Diffusion 1.5, ~2 GB^)...
curl -fL -C - -o "%MODELDIR%\%MODELNAME%" "%MODELURL%"
if errorlevel 1 (
  echo.
  echo [!] Couldn't auto-download a model ^(it may have moved, or need a login^).
  echo     ComfyUI is still installed. Add any .safetensors checkpoint here:
  echo         %MODELDIR%
  echo     Good free sources: https://civitai.com  or  https://huggingface.co/models
  echo.
  exit /b 0
)
echo [OK] Starter model downloaded
exit /b 0

:write_launcher
> "%LAUNCHER%" echo @echo off
>>"%LAUNCHER%" echo title Visual Reader - ComfyUI
>>"%LAUNCHER%" echo cd /d "%%~dp0ComfyUI_windows_portable"
>>"%LAUNCHER%" echo set "GPUARG="
>>"%LAUNCHER%" echo where nvidia-smi ^>nul 2^>nul ^|^| set "GPUARG=--cpu"
>>"%LAUNCHER%" echo echo Starting ComfyUI at http://127.0.0.1:8188  ^(keep this window open; Ctrl+C to stop^)
>>"%LAUNCHER%" echo .\python_embeded\python.exe -s ComfyUI\main.py --enable-cors-header %%GPUARG%%
>>"%LAUNCHER%" echo pause
echo [OK] Created launcher: "%LAUNCHER%"
exit /b 0

:finish
echo.
echo ================================================
echo  ComfyUI is ready.
echo ================================================
echo.
echo  To run it later, double-click:
echo      %LAUNCHER%
echo.
echo  Connect Visual Reader to it:
echo    1. Start ComfyUI (the launcher above). It serves at http://127.0.0.1:8188
echo    2. In Visual Reader, open Settings, set Images to "On my computer",
echo       choose ComfyUI, leave the URL as the default, and click Connect.
echo    3. Pick the model and read.
echo.
set "go="
set /p "go=Start ComfyUI now? (Y/N): "
if /i "%go%"=="Y" start "" "%LAUNCHER%"
echo.
echo Done.
pause
exit /b 0

:end_fail
echo.
echo Setup did not finish. Please review the messages above and try again.
pause
exit /b 1
