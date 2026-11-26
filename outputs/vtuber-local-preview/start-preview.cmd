@echo off
setlocal
cd /d "%~dp0"
set "PREVIEW_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%PREVIEW_NODE%" goto run
where node >nul 2>nul
if errorlevel 1 goto missing
set "PREVIEW_NODE=node"
:run
"%PREVIEW_NODE%" src\server.ts --open
if errorlevel 1 pause
exit /b
:missing
echo Node.js 24 or later is required. Please read README.md.
pause
exit /b 1
