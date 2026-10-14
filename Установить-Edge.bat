@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title Goodog Chat Export - Установка
set "gce_folder=%~dp0extension"
if not exist "%gce_folder%\manifest.json" goto missing
echo Goodog Chat Export
echo.
echo 1. Включите режим разработчика на странице расширений.
echo 2. Нажмите "Загрузить распакованное".
echo 3. Выберите открытую папку extension:
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
echo Не удалось найти Edge в стандартных папках.
echo Откройте edge://extensions/ вручную.
goto done
:missing
echo Папка extension не найдена. Полностью распакуйте ZIP перед запуском.
:done
echo.
pause
