@echo off
REM FaceID + CLIP Vision + optional ComfyUI_IPAdapter_plus clone. Run from Butler repo root.
cd /d "%~dp0.."
python scripts\install_faceid_stack.py %*
exit /b %ERRORLEVEL%
