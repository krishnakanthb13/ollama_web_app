#!/bin/bash

echo "==================================================="
echo "     Ollama Web App - Local Launcher"
echo "==================================================="

# 1. Check for Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed or not in PATH."
    echo "Please install Node.js (e.g., sudo apt install nodejs npm)."
    exit 1
fi

# 2. Check/Install Dependencies
if [ ! -d "node_modules" ]; then
    echo "[INFO] First run detected. Installing local minimal web server..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[ERROR] Failed to install dependencies."
        exit 1
    fi
else
    echo "[INFO] Dependencies found."
fi

# 3. Serve and Open
echo ""
echo "[INFO] Starting Web Server..."
echo "[INFO] Attempting to open browser automatically at http://localhost:8087"
echo ""
echo "Press Ctrl+C to stop the server."
echo ""

npm start
