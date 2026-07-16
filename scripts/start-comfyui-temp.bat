@echo off
REM ComfyUI with previews in system TEMP (not ComfyUI\output). Dev / npm-run-dev instance on port 8188.
REM Desktop Butler uses scripts\start-comfyui-desktop.bat (port 8198, separate temp) so both can run.
REM --lowvram: needed for Wan 14B I2V on ~32GB systems (avoids pagefile OSError 1455).
REM Console log redirect keeps a valid stdout/stderr handle on Windows so tqdm/KSampler
REM does not die with OSError Errno 22 after the parent console detaches.
set "COMFY=D:\BUTLER\sd\ComfyUI"
set "TEMP_ROOT=%TEMP%\butler-comfyui"
set "COMFY_LOG=%TEMP_ROOT%\comfy-console.log"
if not exist "%TEMP_ROOT%" mkdir "%TEMP_ROOT%"
cd /d "%COMFY%"
if exist "%~dp0patch_comfy_logger_windows.py" (
  "%COMFY%\venv\Scripts\python.exe" "%~dp0patch_comfy_logger_windows.py"
)
if exist "%~dp0patch_comfy_object_info_cache.py" (
  "%COMFY%\venv\Scripts\python.exe" "%~dp0patch_comfy_object_info_cache.py"
)
echo ComfyUI port: 8188 (dev)
echo ComfyUI temp: %TEMP_ROOT%\temp
echo ComfyUI log:  %COMFY_LOG%
echo Low VRAM mode (Wan I2V / heavy graphs); pinned memory disabled (32GB RAM hosts).
echo Output folder unused when workflows use PreviewImage.
venv\Scripts\python.exe main.py --port 8188 --temp-directory "%TEMP_ROOT%" --lowvram --disable-smart-memory --disable-pinned-memory >> "%COMFY_LOG%" 2>&1
