@echo off
title OpenCreator Desktop
cd /d "%~dp0"

:: 1. Uu tien Node.js v24 vi better-sqlite3 da duoc bien dich tuong thich ABI 137
if exist "C:\Program Files\nodejs\node.exe" (
    set "OPENCREATOR_NODE_BIN=C:\Program Files\nodejs\node.exe"
    set "PATH=C:\Program Files\nodejs;D:\program\nodejs;%~dp0node_modules\.bin;%PATH%"
) else (
    set "PATH=D:\program\nodejs;%~dp0node_modules\.bin;%PATH%"
)

:: 2. Co dinh toan bo du lieu va cache tren o D (tuyet doi khong dung o C)
set "OPENCREATOR_HOME=%~dp0.opencreator"
set "OPENCREATOR_LANG=vi-VN"
set "OPENCREATOR_DESKTOP_DEV=1"

:: Tu dong don dep file khoa cu neu co
if exist "%OPENCREATOR_HOME%\data\opencreator-runtime.lock" (
    del /f /q "%OPENCREATOR_HOME%\data\opencreator-runtime.lock" >nul 2>&1
)

echo ====================================================
echo       Dang khoi dong OpenCreator Desktop GUI...
echo ====================================================

:: 3. Kiem tra neu ban build da san sang thi khoi chay truc tiep bang Electron
if "%1"=="--rebuild" goto BUILD_ALL
if exist "%~dp0apps\desktop\dist\main\main.js" if exist "%~dp0apps\daemon\dist\main.js" if exist "%~dp0apps\web\dist\index.html" (
    echo [OK] Ban build san sang. Dang mo cua so OpenCreator Desktop...
    cd /d "%~dp0apps\desktop"
    start "" "%~dp0node_modules\.pnpm\electron@43.7.7\node_modules\electron\dist\electron.exe" .
    ping 127.0.0.1 -n 3 >nul
    exit /b 0
)

:BUILD_ALL
:: 4. Neu chua build hoac co yeu cau build thi chay pnpm de build va khoi dong
echo Dang bien dich cac goi va khoi chay...
call pnpm desktop:dev

if %errorlevel% neq 0 (
    echo.
    echo [Loi] Khong the khoi dong OpenCreator Desktop. Ma loi: %errorlevel%
    pause
)
