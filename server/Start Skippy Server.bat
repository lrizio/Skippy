@echo off
title Skippy Server - keep this window open
cd /d "%~dp0"
echo.
echo  Skippy server - leave this window OPEN (minimise it). Closing it stops the server.
echo  To run it hidden in the background instead, close this and use
echo  "Run Skippy Server in Background.bat".
echo.
node server.js
pause
