@echo off
REM Download SDXL base weights into Butler\sd\ComfyUI\models\checkpoints (large download).
cd /d "%~dp0.."
py -3 -m pip install -q huggingface_hub
if errorlevel 1 (
  echo pip install huggingface_hub failed.
  exit /b 1
)
py -3 "%~dp0download_comfy_checkpoint.py" --preset sdxl-base
exit /b %ERRORLEVEL%
