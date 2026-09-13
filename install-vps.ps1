# Auto-install Shopee Toolkit on Windows Server VPS

Write-Host "========================================="
Write-Host " INSTALLING ENVIRONMENT FOR VPS..."
Write-Host "========================================="

# 1. Install Node.js
Write-Host "[1/5] Downloading Node.js v20..."
$nodeInstaller = "$env:TEMP\node-v20.msi"
Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi" -OutFile $nodeInstaller
Write-Host "[1/5] Installing Node.js..."
Start-Process -FilePath "msiexec.exe" -ArgumentList "/i $nodeInstaller /quiet /norestart" -Wait -NoNewWindow
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Write-Host "[1/5] Node.js installed OK"

# 2. Install Git
Write-Host "[2/5] Downloading Git..."
$gitInstaller = "$env:TEMP\git-setup.exe"
Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/download/v2.44.0.windows.1/Git-2.44.0-64-bit.exe" -OutFile $gitInstaller
Write-Host "[2/5] Installing Git..."
Start-Process -FilePath $gitInstaller -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS" -Wait -NoNewWindow
$env:Path += ";C:\Program Files\Git\cmd"
Write-Host "[2/5] Git installed OK"

# 3. Clone source code
Write-Host "[3/5] Cloning source code..."
Set-Location C:\
if (Test-Path -Path "C:\shopee-qr") {
    Remove-Item -Path "C:\shopee-qr" -Recurse -Force
}
& "C:\Program Files\Git\cmd\git.exe" clone https://github.com/trienphatlk54/trienvo.git shopee-qr
Set-Location C:\shopee-qr
Write-Host "[3/5] Source code cloned OK"

# 4. npm install
Write-Host "[4/5] Installing npm packages..."
& "C:\Program Files\nodejs\npm.cmd" install
Write-Host "[4/5] npm packages installed OK"

# 5. PM2 setup
Write-Host "[5/5] Installing PM2..."
& "C:\Program Files\nodejs\npm.cmd" install -g pm2
& "C:\Program Files\nodejs\npm.cmd" install -g pm2-windows-startup

$pm2Path = (Get-Command pm2 -ErrorAction SilentlyContinue).Source
if (-not $pm2Path) {
    $pm2Path = "$env:APPDATA\npm\pm2.cmd"
}
& $pm2Path start server.js --name "shopee-tool"
& $pm2Path save
Write-Host "[5/5] PM2 setup OK"

# 6. Open firewall port 3000
Write-Host "Opening port 3000..."
New-NetFirewallRule -DisplayName "Shopee Tool Port 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow -ErrorAction SilentlyContinue
Write-Host "Port 3000 opened OK"

Write-Host "========================================="
Write-Host " DONE! Website running at:"
Write-Host " http://157.66.218.153:3000"
Write-Host ""
Write-Host " IMPORTANT: Copy firebase-key.json to C:\shopee-qr"
Write-Host " Then run: pm2 restart shopee-tool"
Write-Host "========================================="
