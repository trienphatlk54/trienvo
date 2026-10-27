@echo off
cd /d "c:\Users\Admin\Documents\Test-Websites\shopee-qr"
C:\Windows\System32\netstat.exe -ano | C:\Windows\System32\findstr.exe ":9497 " | C:\Windows\System32\findstr.exe "LISTENING" >nul 2>&1
if %errorlevel% neq 0 (
  "C:\Program Files\nodejs\node.exe" "c:\Users\Admin\Documents\Test-Websites\shopee-qr\server.js" >> "c:\Users\Admin\Documents\Test-Websites\shopee-qr\bridge-startup.log" 2>&1
)
