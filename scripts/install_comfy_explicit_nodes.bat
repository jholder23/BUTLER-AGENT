@echo off
REM Clone IP-Adapter+, Impact Pack, Impact Subpack (+ optional Manager) into ComfyUI/custom_nodes.
cd /d "%~dp0.."
python scripts\install_comfy_explicit_nodes.py %*
exit /b %ERRORLEVEL%
