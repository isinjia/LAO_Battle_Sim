@echo off
title LO Battle Simulator
cd /d "%~dp0"

set PORT=8765
:findport
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  set /a PORT+=1
  goto findport
)

where python >nul 2>nul
if errorlevel 1 (
  echo Python not found. Install it from https://www.python.org and run again.
  pause
  exit /b 1
)

echo LO Battle Simulator: http://localhost:%PORT%
echo Close this window to stop the server.
start "" "http://localhost:%PORT%"
python "%~dp0tools\serve.py" %PORT%
