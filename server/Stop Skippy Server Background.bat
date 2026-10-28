@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0background.ps1" -Action Remove
echo.
pause
