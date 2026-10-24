@echo off
cd /d "%~dp0"
:loop
REM Kiểm tra xem cổng 9497 đã có tiến trình lắng nghe chưa
netstat -ano | findstr ":9497 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% neq 0 (
  node server.js
)
timeout /t 3 /nobreak >nul
goto loop
