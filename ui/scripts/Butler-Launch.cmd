@echo off
setlocal EnableExtensions
title Butler — update then start
set "HERE=%~dp0"
set "EXE=%HERE%Butler.exe"
set "UI=%HERE%..\.."

if exist "%UI%\package.json" (
  where npm >nul 2>&1
  if errorlevel 1 (
    echo npm not on PATH — starting Butler without rebuild.
  ) else (
    echo Rebuilding Butler from: %UI%
    cd /d "%UI%"
    call npm run build:app
    if errorlevel 1 (
      echo.
      echo Build failed — Butler was not started.
      pause
      exit /b 1
    )
  )
)

if not exist "%EXE%" (
  echo Butler.exe not found at:
  echo %EXE%
  pause
  exit /b 1
)

start "" "%EXE%"
exit /b 0
