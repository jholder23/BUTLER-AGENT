@echo off
REM Desktop Butler ComfyUI instance (port 8198).
REM Same install as dev (sd\ComfyUI) but separate listen port + temp/input/output under %TEMP%.
REM Match flags from start-comfyui-temp.bat so desktop and npm run dev can run together.
REM Dev Comfy stays on 8188 via scripts\start-comfyui-temp.bat.
set "ROOT=%~dp0.."
set "COMFY=%ROOT%\sd\ComfyUI"
if defined SD_PROJECT_PATH set "COMFY=%SD_PROJECT_PATH%\ComfyUI"
set "TEMP_ROOT=%TEMP%\butler-comfyui-desktop"
if defined BUTLER_COMFY_TEMP_ROOT set "TEMP_ROOT=%BUTLER_COMFY_TEMP_ROOT%"
set "COMFY_LOG=%TEMP_ROOT%\comfy-console.log"
set "COMFY_PORT=8198"
if not exist "%TEMP_ROOT%" mkdir "%TEMP_ROOT%"
if not exist "%TEMP_ROOT%\input" mkdir "%TEMP_ROOT%\input"
if not exist "%TEMP_ROOT%\output" mkdir "%TEMP_ROOT%\output"
if not exist "%COMFY%\main.py" (
  echo ERROR: ComfyUI was not found at "%COMFY%".
  echo Set SD_PROJECT_PATH to your sd root ^(folder containing ComfyUI^).
  exit /b 1
)
cd /d "%COMFY%"
if exist "%COMFY%\venv\Scripts\python.exe" (
  if exist "%~dp0patch_comfy_logger_windows.py" (
    "%COMFY%\venv\Scripts\python.exe" "%~dp0patch_comfy_logger_windows.py"
  )
  if exist "%~dp0patch_comfy_object_info_cache.py" (
    "%COMFY%\venv\Scripts\python.exe" "%~dp0patch_comfy_object_info_cache.py"
  )
)
echo Desktop ComfyUI port: %COMFY_PORT%
echo ComfyUI temp: %TEMP_ROOT%\temp
echo ComfyUI input: %TEMP_ROOT%\input
echo ComfyUI log:  %COMFY_LOG%
echo Normal VRAM + fp16 VAE (avoids Windows VAEDecode unload crash). Pinned memory disabled.
echo Override with COMFYUI_EXTRA_ARGS if Wan needs --lowvram. Dev Comfy stays on 8188 via start-comfyui-temp.bat.
REM Prefer COMFYUI_EXTRA_ARGS when set (same override Electron uses).
if defined COMFYUI_EXTRA_ARGS (
  set "COMFY_FLAGS=%COMFYUI_EXTRA_ARGS%"
) else (
  set "COMFY_FLAGS=--normalvram --fp16-vae --disable-cuda-malloc --disable-pinned-memory"
)
if exist "%COMFY%\venv\Scripts\python.exe" (
  "%COMFY%\venv\Scripts\python.exe" main.py --port %COMFY_PORT% --temp-directory "%TEMP_ROOT%" --input-directory "%TEMP_ROOT%\input" --output-directory "%TEMP_ROOT%\output" %COMFY_FLAGS% >> "%COMFY_LOG%" 2>&1
) else (
  py -3 main.py --port %COMFY_PORT% --temp-directory "%TEMP_ROOT%" --input-directory "%TEMP_ROOT%\input" --output-directory "%TEMP_ROOT%\output" %COMFY_FLAGS% >> "%COMFY_LOG%" 2>&1
)
set "COMFY_EXIT=%ERRORLEVEL%"
echo ComfyUI ^(desktop^) exited with code %COMFY_EXIT%.
exit /b %COMFY_EXIT%
