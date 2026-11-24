@echo off
setlocal
cd /d "%~dp0"

echo ===================================================
echo  Gesture Remote
echo ===================================================
echo.
echo Starting the remote server and the web page...
echo Keep both windows open while using the remote.
echo.

call :start_if_free 8766 "Gesture Remote - Input + Screen (8766)" "python cursor_server.py"

echo On your phone, open the "Phone" address printed in the
echo Gesture Remote window. It looks like:
echo   http://YOUR-PC-IP:8766/cursor.html
echo.
ping -n 6 127.0.0.1 >nul
exit /b 0

:start_if_free
set "PORT=%~1"
set "TITLE=%~2"
set "CMD=%~3"
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
    start "%TITLE%" cmd /k %CMD%
) else (
    echo Already running on port %PORT%
)
exit /b 0
