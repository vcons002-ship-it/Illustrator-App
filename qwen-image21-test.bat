@echo off
setlocal
cd /d "%~dp0"
echo Illustrator evaluation build: http://127.0.0.1:5181
echo Existing ComfyUI endpoint: http://127.0.0.1:8188
echo See docs\QWEN-IMAGE-21-EVALUATION.md for the Qwen preset and license scope.
call pnpm.cmd --filter @visual-reader/web dev --host 127.0.0.1 --port 5181 --strictPort
pause
