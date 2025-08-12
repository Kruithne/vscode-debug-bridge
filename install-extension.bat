@echo off
echo VSCode Debug Bridge Extension Installer
echo ==========================================

where code >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: VSCode 'code' command not found. Please install VSCode and add it to PATH.
    echo Download from: https://code.visualstudio.com/
    pause
    exit /b 1
)

echo VSCode found!

set "extensionsDir=%USERPROFILE%\.vscode\extensions"
set "targetDir=%extensionsDir%\vscode-debug-bridge-1.0.0"

echo Extensions directory: %extensionsDir%

if exist "%targetDir%" (
    echo Removing old version...
    rmdir /s /q "%targetDir%"
)

echo Creating extension directory...
mkdir "%targetDir%"

echo Copying extension files...
copy "vscode-debug-bridge\package.json" "%targetDir%\"
copy "vscode-debug-bridge\extension.js" "%targetDir%\"
xcopy "vscode-debug-bridge\node_modules" "%targetDir%\node_modules\" /e /i /h

if exist "%targetDir%\package.json" (
    echo Extension installed successfully!
) else (
    echo Installation verification failed!
    pause
    exit /b 1
)

echo.
echo Installation Complete!
pause