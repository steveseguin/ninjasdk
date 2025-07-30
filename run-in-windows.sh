#!/bin/bash

# Script to run Node.js commands in Windows from WSL

echo "Running Node.js in Windows environment..."
echo ""

# Convert WSL path to Windows path
WINDOWS_PATH=$(wslpath -w /mnt/c/Users/steve/Code/ninjasdk)

# Change to the Windows directory and run node
cd /mnt/c/Users/steve/Code/ninjasdk

# Run the overlay listener using Windows node.exe
echo "Starting overlay listener on Windows..."
echo "Room: testroom"
echo "Password: disabled"
echo ""

# Use cmd.exe to run node in Windows environment
cmd.exe /c "cd $WINDOWS_PATH && node demos\test-overlay-final.js"