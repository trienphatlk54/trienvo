@echo off
title Shopee Toolkit - Localhost:3000
chcp 65001 >nul
cls
cd /d "%~dp0"
echo ======================================================================
echo    🚀 KHỞI ĐỘNG SHOPEE TOOLKIT TẠI MÁY TÍNH CỦA BẠN
echo ======================================================================
echo.
echo  Website sẽ mở tại: http://localhost:3000
echo.
node server.js
if %errorlevel% neq 0 (
  echo.
  echo [LỖI] Đã xảy ra sự cố khi chạy server.js!
  pause
)
