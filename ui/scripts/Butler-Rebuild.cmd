@echo off
setlocal EnableExtensions
title Rebuild Butler

REM If you copied Butler to Desktop (flat folder), set BUTLER_REPO_DIR to your clone, e.g. D:\BUTLER
if defined BUTLER_REPO_DIR if exist "%BUTLER_REPO_DIR%\ui\package.json" (
  cd /d "%BUTLER_REPO_DIR%\ui"
  goto :run_npm
)

REM Optional: set BUTLER_UI_DIR to your ui folder if this script cannot find it.
if defined BUTLER_UI_DIR if exist "%BUTLER_UI_DIR%\package.json" (
  cd /d "%BUTLER_UI_DIR%"
  goto :run_npm
)

REM Default: Butler.exe lives in ui\dist-app-new\win-unpacked — repo ui is two levels up.
set "EXEDIR=%~dp0"
if exist "%EXEDIR%..\..\package.json" (
  cd /d "%EXEDIR%..\.."
  goto :run_npm
)

echo Could not find the Butler ui project ^(expected package.json two folders above this script^).
echo.
echo Fix: open a terminal in your Butler repo "ui" folder and run:  npm run build:app
echo Or set environment variable BUTLER_UI_DIR to that folder, then run this again.
echo.
pause
exit /b 1

:run_npm
where npm >nul 2>&1 || (
  echo npm was not found on PATH. Install Node.js, then try again.
  pause
  exit /b 1
)

echo Rebuilding from: %CD%
echo.
call npm run build:app
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo Build failed ^(exit %ERR%^).
) else (
  echo Build finished. Close this window and start Butler from your desktop shortcut.
)
pause
exit /b %ERR%
