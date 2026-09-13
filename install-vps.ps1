# Cấu hình tự động cài đặt môi trường và chạy Project Shopee Toolkit trên Windows Server VPS

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " BẮT ĐẦU CÀI ĐẶT MÔI TRƯỜNG CHO VPS..." -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Tải và cài đặt Node.js
Write-Host "1. Đang tải và cài đặt Node.js..." -ForegroundColor Yellow
$nodeInstaller = "$env:TEMP\node-v20.x.msi"
Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi" -OutFile $nodeInstaller
Start-Process -FilePath "msiexec.exe" -ArgumentList "/i $nodeInstaller /quiet /norestart" -Wait -NoNewWindow
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Write-Host "=> Cài đặt Node.js thành công!" -ForegroundColor Green

# 2. Tải và cài đặt Git
Write-Host "2. Đang tải và cài đặt Git..." -ForegroundColor Yellow
$gitInstaller = "$env:TEMP\git-setup.exe"
Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/download/v2.44.0.windows.1/Git-2.44.0-64-bit.exe" -OutFile $gitInstaller
Start-Process -FilePath $gitInstaller -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS" -Wait -NoNewWindow
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Write-Host "=> Cài đặt Git thành công!" -ForegroundColor Green

# 3. Clone source code
Write-Host "3. Đang tải Source code từ Github..." -ForegroundColor Yellow
cd C:\
if (Test-Path -Path "C:\shopee-qr") {
    Remove-Item -Path "C:\shopee-qr" -Recurse -Force
}
git clone https://github.com/trienphatlk54/trienvo.git shopee-qr
cd shopee-qr
Write-Host "=> Tải source code thành công!" -ForegroundColor Green

# 4. Cài đặt các thư viện Node.js (npm install)
Write-Host "4. Đang cài đặt các thư viện phụ thuộc (Puppeteer, Express...)..." -ForegroundColor Yellow
npm install
Write-Host "=> Cài đặt thư viện thành công!" -ForegroundColor Green

# 5. Cài đặt PM2 để chạy ngầm và tự khởi động
Write-Host "5. Đang cài đặt PM2..." -ForegroundColor Yellow
npm install -g pm2
pm2 start server.js --name "shopee-tool"
pm2 save
npm install -g pm2-windows-startup
pm2-startup install
Write-Host "=> Đã cấu hình PM2 thành công!" -ForegroundColor Green

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " CÀI ĐẶT HOÀN TẤT!" -ForegroundColor Green
Write-Host " Website của bạn đang chạy tại: http://localhost:3000" -ForegroundColor White
Write-Host " (Đừng quên copy file firebase-key.json bỏ vào thư mục C:\shopee-qr trên VPS nhé)" -ForegroundColor Yellow
Write-Host "=========================================" -ForegroundColor Cyan
