@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0knowledge\download_wan_models.py" (
  py -3 "%~dp0knowledge\download_wan_models.py" %*
) else (
  echo Missing knowledge\download_wan_models.py
  exit /b 1
)
