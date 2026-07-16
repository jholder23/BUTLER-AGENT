@echo off
setlocal EnableExtensions
title Rebuild Butler to Desktop
cd /d "%~dp0.."
if not exist "ui\package.json" (
  echo Expected Butler repo at: %CD%
  echo ui\package.json not found.
  pause
  exit /b 1
)
where npm >nul 2>&1 || (
  echo npm not on PATH.
  pause
  exit /b 1
)
echo Building from: %CD%
call npm run rebuild-butler
if not "%ERRORLEVEL%"=="0" (
  echo Build failed.
  pause
  exit /b %ERRORLEVEL%
)
set "DESK=%USERPROFILE%\Desktop\Butler"
if not exist "%DESK%" mkdir "%DESK%"
echo Copying win-unpacked to: %DESK%
robocopy "%CD%\ui\dist-app-new\win-unpacked" "%DESK%" /E /COPY:DAT /R:2 /W:2 /NFL /NDL /NJH /NJS
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  echo robocopy failed code %RC%
  pause
  exit /b %RC%
)
echo Done. Run: %DESK%\Butler.exe
pause
exit /b 0
