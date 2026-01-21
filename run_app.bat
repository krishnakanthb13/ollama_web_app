@echo off
setlocal
title Ollama Web App Launcher

echo ===================================================
echo      Ollama Web App - Local Launcher
echo ===================================================

:: 1. Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b
)

:: 2. Check/Install Dependencies
if not exist "node_modules" (
    echo [INFO] First run detected. Installing local minimal web server...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b
    )
) else (
    echo [INFO] Dependencies found.
)

:: 3. Serve and Open
echo.
echo [INFO] Starting Web Server...
echo [INFO] Attempting to open browser automatically at http://localhost:8087
echo.
echo Press Ctrl+C to stop the server.
echo.

call npm start

pause
