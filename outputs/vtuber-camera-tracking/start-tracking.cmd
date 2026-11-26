@echo off
setlocal
cd /d "%~dp0"
set "TRACKING_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%TRACKING_NODE%" (
  "%TRACKING_NODE%" src\server.ts --open
) else (
  node src\server.ts --open
)
pause
