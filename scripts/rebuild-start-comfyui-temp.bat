@echo off
setlocal EnableExtensions
REM Safely stop Butler's ComfyUI, refresh Butler custom-node code, and restart.
REM This intentionally does not reinstall dependencies or touch models/workflows.

set "ROOT=%~dp0.."
set "COMFY=%ROOT%\sd\ComfyUI"
set "CUSTOM_NODES=%COMFY%\custom_nodes"
set "COMFY_PYTHON=%COMFY%\venv\Scripts\python.exe"
set "TEMP_ROOT=%TEMP%\butler-comfyui"

if not exist "%COMFY%\main.py" (
  echo ERROR: ComfyUI was not found at "%COMFY%".
  pause
  exit /b 1
)
if not exist "%COMFY_PYTHON%" (
  echo ERROR: ComfyUI Python was not found at "%COMFY_PYTHON%".
  pause
  exit /b 1
)

echo Stopping Butler ComfyUI processes on port 8188...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$comfy = [IO.Path]::GetFullPath($env:COMFY).TrimEnd('\') + '\';" ^
  "$all = @(Get-CimInstance Win32_Process);" ^
  "$listeners = @(Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique);" ^
  "$seeds = @($all | Where-Object { $exe = [string]$_.ExecutablePath; $cmd = [string]$_.CommandLine; ($listeners -contains [uint32]$_.ProcessId -and (($exe -and $exe.StartsWith($comfy, [StringComparison]::OrdinalIgnoreCase)) -or $cmd.IndexOf($comfy, [StringComparison]::OrdinalIgnoreCase) -ge 0)) -or ($exe -and $exe.StartsWith($comfy, [StringComparison]::OrdinalIgnoreCase) -and $cmd -match '(?:^|\s|[\\/])main\.py(?:\s|$)') });" ^
  "$ids = [Collections.Generic.HashSet[uint32]]::new(); $queue = [Collections.Generic.Queue[uint32]]::new();" ^
  "foreach ($p in $seeds) { if ($ids.Add([uint32]$p.ProcessId)) { $queue.Enqueue([uint32]$p.ProcessId) } };" ^
  "while ($queue.Count) { $parent = $queue.Dequeue(); foreach ($child in $all | Where-Object ParentProcessId -eq $parent) { if ($ids.Add([uint32]$child.ProcessId)) { $queue.Enqueue([uint32]$child.ProcessId) } } };" ^
  "if (-not $ids.Count) { Write-Host 'No matching Butler ComfyUI process is running.'; exit 0 };" ^
  "$ordered = @($ids) | Sort-Object { $id = $_; $depth = 0; while (($p = $all | Where-Object ProcessId -eq $id | Select-Object -First 1) -and $ids.Contains([uint32]$p.ParentProcessId)) { $depth++; $id = [uint32]$p.ParentProcessId }; $depth } -Descending;" ^
  "foreach ($id in $ordered) { Write-Host ('Stopping PID ' + $id); Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }"
if errorlevel 1 (
  echo ERROR: Unable to safely stop Butler ComfyUI.
  pause
  exit /b 1
)

echo Removing Python __pycache__ folders under "%CUSTOM_NODES%"...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "if (Test-Path -LiteralPath $env:CUSTOM_NODES) { Get-ChildItem -LiteralPath $env:CUSTOM_NODES -Directory -Filter '__pycache__' -Recurse -Force | Remove-Item -Recurse -Force }"
if errorlevel 1 (
  echo ERROR: Failed to remove one or more __pycache__ folders.
  pause
  exit /b 1
)

if exist "%ROOT%\scripts\install_butler_simple_ui.py" (
  echo Refreshing Butler's ComfyUI custom node...
  "%COMFY_PYTHON%" "%ROOT%\scripts\install_butler_simple_ui.py"
  if errorlevel 1 (
    echo ERROR: Butler custom-node refresh failed.
    pause
    exit /b 1
  )
) else (
  echo Butler custom-node installer not present; skipping refresh.
)

if exist "%ROOT%\scripts\patch_comfy_logger_windows.py" (
  echo Hardening ComfyUI logger against Windows stderr Errno 22...
  "%COMFY_PYTHON%" "%ROOT%\scripts\patch_comfy_logger_windows.py"
  if errorlevel 1 (
    echo ERROR: ComfyUI logger patch failed.
    pause
    exit /b 1
  )
)

if exist "%ROOT%\scripts\patch_comfy_object_info_cache.py" (
  echo Caching ComfyUI /object_info to reduce RAM spikes...
  "%COMFY_PYTHON%" "%ROOT%\scripts\patch_comfy_object_info_cache.py"
  if errorlevel 1 (
    echo ERROR: ComfyUI object_info cache patch failed.
    pause
    exit /b 1
  )
)

if not exist "%TEMP_ROOT%" mkdir "%TEMP_ROOT%"
if errorlevel 1 (
  echo ERROR: Could not create temp directory "%TEMP_ROOT%".
  pause
  exit /b 1
)

cd /d "%COMFY%"
if errorlevel 1 (
  echo ERROR: Could not enter "%COMFY%".
  pause
  exit /b 1
)

set "COMFY_LOG=%TEMP_ROOT%\comfy-console.log"
echo ComfyUI temp: %TEMP_ROOT%\temp
echo ComfyUI log:  %COMFY_LOG%
echo Low VRAM mode (Wan I2V / heavy graphs).
echo Starting ComfyUI on port 8188. Close this window to stop it.
REM Redirect keeps a durable stdout/stderr handle so tqdm flush cannot kill KSampler.
"%COMFY_PYTHON%" main.py --temp-directory "%TEMP_ROOT%" --lowvram --disable-smart-memory --disable-pinned-memory >> "%COMFY_LOG%" 2>&1

set "COMFY_EXIT=%ERRORLEVEL%"
echo.
echo ComfyUI exited with code %COMFY_EXIT%.
pause
exit /b %COMFY_EXIT%
