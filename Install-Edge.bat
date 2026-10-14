@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title Goodog Chat Export - Installation
set "gce_folder=%~dp0extension"
if not exist "%gce_folder%\manifest.json" goto missing
echo Goodog Chat Export
echo.
echo 1. Enable Developer mode on the extensions page.
echo 2. Click "Load unpacked".
echo 3. Select the extension folder:
echo "%gce_folder%"
echo.
start "" explorer.exe "%gce_folder%"
set "gce_browser="
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "gce_browser=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "gce_browser=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" set "gce_browser=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not defined gce_browser goto manual
start "" "%gce_browser%" "edge://extensions/"
goto done
:manual
echo Could not find Edge in the standard locations.
echo Open edge://extensions/ manually.
goto done
:missing
echo The extension folder is missing. Extract the complete ZIP first.
:done
echo.
pause
