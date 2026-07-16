@echo off
setlocal EnableExtensions
REM Production: start packaged Butler (no rebuild). Use Butler-Rebuild.cmd from the dev repo when updating.
set "HERE=%~dp0"
set "EXE=%HERE%Butler.exe"
if not exist "%EXE%" (
  echo Butler.exe not found:
  echo %EXE%
  pause
  exit /b 1
)
start "" "%EXE%"
exit /b 0
