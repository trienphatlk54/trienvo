@echo off
title GPMLogin Bridge - Shopee Toolkit
chcp 65001 >nul
cls
echo ======================================================================
echo    🚀 GPMLOGIN BRIDGE CHO SHOPEE TOOLKIT (TIKTOK / DUOPLUS)
echo ======================================================================
echo.
echo  Bridge này giúp kết nối website Shopee Toolkit (chạy trên VPS hoặc Local)
echo  với phần mềm GPMLogin đang chạy trên máy tính của bạn.
echo.
echo  * Trạng thái: Đang khởi động Bridge tại cổng 9497...
echo  * Hãy chắc chắn rằng GPMLogin cũng đang được bật trên máy tính.
echo.
echo  [LƯU Ý]: GIỮ CỬA SỔ NÀY MỞ KHI BẠN SỬ DỤNG TÍNH NĂNG "TẠO DUOPLUS GPM"!
echo ======================================================================
echo.

node gpm-bridge.js
if %errorlevel% neq 0 (
  echo.
  echo [LỖI] Không thể khởi động GPMLogin Bridge. Vui lòng kiểm tra lại Node.js!
  pause
)
