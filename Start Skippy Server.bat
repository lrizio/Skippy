@echo off
cd /d "%~dp0server"
title Skippy Server - keep this window open
echo.
echo  Skippy server - leave this window OPEN (minimise it). Closing it stops the server.
echo  To run it hidden in the background instead, use "Run Skippy Server in Background.bat" in the server folder.
echo.
node server.js
pause
