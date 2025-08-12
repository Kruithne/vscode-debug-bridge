#!/bin/bash
set -e

echo "VSCode Debug Bridge Extension Installer"
echo "========================================"
echo

if ! command -v code &> /dev/null; then
    echo "ERROR: VSCode 'code' command not found. Please install VSCode and add it to PATH."
    echo "Download from: https://code.visualstudio.com/"
    exit 1
fi

echo "VSCode found!"

EXTENSIONS_DIR="$HOME/.vscode/extensions"
TARGET_DIR="$EXTENSIONS_DIR/vscode-debug-bridge-1.0.0"

echo "Extensions directory: $EXTENSIONS_DIR"

if [ -d "$TARGET_DIR" ]; then
    echo "Removing old version..."
    rm -rf "$TARGET_DIR"
fi

echo "Creating extension directory..."
mkdir -p "$TARGET_DIR"

echo "Copying extension files..."
cp "vscode-debug-bridge/package.json" "$TARGET_DIR/"
cp "vscode-debug-bridge/extension.js" "$TARGET_DIR/"
cp -r "vscode-debug-bridge/node_modules" "$TARGET_DIR/"

if [ -f "$TARGET_DIR/package.json" ]; then
    echo "Extension installed successfully!"
else
    echo "Installation verification failed!"
    exit 1
fi

echo "Installation Complete!"