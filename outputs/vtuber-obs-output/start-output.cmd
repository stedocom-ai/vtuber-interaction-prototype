@echo off
setlocal
cd /d "%~dp0"
set "OUTPUT_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%OUTPUT_NODE%" (
  "%OUTPUT_NODE%" src\server.ts --open
) else (
  node src\server.ts --open
)
set "OUTPUT_EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %OUTPUT_EXIT_CODE%
