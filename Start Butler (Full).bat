@echo off
title Butler (dev)
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

echo Butler dev: Knowledge API (8765) + Butler API (4001) + Vite (5173) in this window.
echo When Vite prints "ready", open http://localhost:5173
echo Live reload ^(API restart, Vite HMR, nodemon, Electron auto-restart^): npm run dev -- --live
echo For the Electron shell instead: npm run dev:electron   (add -- --live for live reload^)
echo.

call npm run dev
echo.
pause
