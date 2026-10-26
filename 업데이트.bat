@echo off
title LO Battle Simulator - Update
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python not found. Install it from https://www.python.org and run again.
  pause
  exit /b 1
)

set "PROJ="
if exist "unity_project.txt" set /p PROJ=<"unity_project.txt"
if not defined PROJ if exist "..\Assets\LastOneTable\LoJson.js.bytes" set "PROJ=%~dp0.."
if defined PROJ if not exist "%PROJ%\Assets\LastOneTable\LoJson.js.bytes" set "PROJ="

if not defined PROJ (
  echo Unity project folder not found.
  echo Enter the folder that contains Assets  ^(example: E:\LAO\1_Onestre_QA^)
  set /p PROJ=Unity project folder: 
)
if not defined PROJ (
  echo No folder entered.
  pause
  exit /b 1
)

python -I "%~dp0tools\update.py" "%PROJ%"
echo.
pause
