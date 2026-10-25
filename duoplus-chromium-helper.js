// duoplus-chromium-helper.js
// Khởi chạy trực tiếp trình duyệt Chromium / Chrome trên máy tính (KHÔNG qua Proxy GPM)
// Tự động trích xuất & đồng bộ phiên đăng nhập DuoPlus (access_token, deviceId, expired_in)
// Kết nối thẳng vào màn hình điều khiển Cloud Phone (/control?id=...&type=connect)
// Và cung cấp bộ kết nối GPMLogin tự phục hồi (Auto-Recover khi tắt/mở lại GPM, chống lỗi 502/Socket Reset)

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const puppeteer = require('puppeteer');

const PROFILE_BASE_DIR = path.join(__dirname, '.duoplus_chromium_profile');
const AUTH_CACHE_FILE = path.join(PROFILE_BASE_DIR, 'auth_cache.json');

// Map lưu debugPort đang mở theo từng accountKey để tái sử dụng cửa sổ Chrome mượt mà
const activeDebugPorts = new Map();
let lastGpmAutoStartAttempt = 0;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadAuthCache() {
  try {
    if (fs.existsSync(AUTH_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_CACHE_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveDuoPlusAuthCache({ profileId, hotmail, apiKey, auth }) {
  if (!auth || !auth.accessToken) return;
  try {
    ensureDir(PROFILE_BASE_DIR);
    const cache = loadAuthCache();
    const entry = {
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken || '',
      expiredIn: auth.expiredIn || String(Date.now() + 30 * 86400 * 1000),
      deviceId: auth.deviceId || '',
      updatedAt: Date.now()
    };
    if (profileId) cache[`profile:${profileId}`] = entry;
    if (hotmail) cache[`hotmail:${hotmail.toLowerCase().trim()}`] = entry;
    if (apiKey) cache[`apikey:${apiKey.trim()}`] = entry;
    cache['latest'] = entry;
    fs.writeFileSync(AUTH_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error('[DuoPlus Auth Cache] Save error:', e.message);
  }
}

/**
 * Quét thư mục LevelDB của 1 GPM Profile để lấy access_token & deviceId DuoPlus
 */
function extractAuthFromLevelDbDir(ldbDir, targetEmail = '') {
  try {
    if (!fs.existsSync(ldbDir)) return null;
    const files = fs.readdirSync(ldbDir)
      .filter(f => f.endsWith('.ldb') || f.endsWith('.log'))
      .map(f => {
        const full = path.join(ldbDir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (e) {}
        return { name: f, full, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime);

    if (files.length === 0) return null;

    let combined = '';
    for (const f of files) {
      try {
        combined += fs.readFileSync(f.full).toString('latin1') + '\n';
      } catch (e) {}
    }

    if (targetEmail && !combined.toLowerCase().includes(targetEmail.toLowerCase().trim())) {
      return null;
    }

    const accessMatches = [...combined.matchAll(/access_t[^\x22]{1,25}(\x22[A-Za-z0-9_\-.]{25,80}\x22)/g)].map(m => m[1]);
    if (accessMatches.length === 0) return null;

    const devMatches = [...combined.matchAll(/deviceId[^\x22]{1,20}(\x22[A-Za-z0-9_\-]{20,60}\x22)/g)].map(m => m[1]);
    const expMatches = [...combined.matchAll(/expired_in[^\d]{1,20}(\d{12,15})/g)].map(m => m[1]);

    return {
      accessToken: accessMatches[accessMatches.length - 1],
      deviceId: devMatches.length > 0 ? devMatches[devMatches.length - 1] : '"9bb925e4-dbd1-4fdc-bc57-ebba080590fd"',
      expiredIn: expMatches.length > 0 ? expMatches[expMatches.length - 1] : String(Date.now() + 30 * 86400 * 1000)
    };
  } catch (e) {
    return null;
  }
}

/**
 * Tìm token đăng nhập DuoPlus từ GPM Folder hoặc Cache
 */
function getDuoPlusAuth({ profileId, hotmail, apiKey } = {}) {
  const gpmRoots = ['C:\\GPM Folder', 'D:\\GPM Folder', 'E:\\GPM Folder'].filter(p => fs.existsSync(p));

  // 1. Tìm trực tiếp theo profileId trong GPM Folder
  if (profileId) {
    for (const root of gpmRoots) {
      const ldbDir = path.join(root, profileId, 'Default', 'Local Storage', 'leveldb');
      const auth = extractAuthFromLevelDbDir(ldbDir);
      if (auth && auth.accessToken) {
        saveDuoPlusAuthCache({ profileId, hotmail, apiKey, auth });
        return auth;
      }
    }
  }

  // 2. Kiểm tra trong Auth Cache
  const cache = loadAuthCache();
  if (profileId && cache[`profile:${profileId}`]) return cache[`profile:${profileId}`];
  if (hotmail && cache[`hotmail:${hotmail.toLowerCase().trim()}`]) return cache[`hotmail:${hotmail.toLowerCase().trim()}`];
  if (apiKey && cache[`apikey:${apiKey.trim()}`]) return cache[`apikey:${apiKey.trim()}`];

  // 3. Nếu có hotmail, quét các thư mục GPM gần nhất để tìm profile chứa email đó
  if (hotmail) {
    for (const root of gpmRoots) {
      try {
        const dirs = fs.readdirSync(root)
          .map(d => {
            const full = path.join(root, d);
            let mtime = 0;
            try { mtime = fs.statSync(full).mtimeMs; } catch (e) {}
            return { d, full, mtime };
          })
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 60);

        for (const item of dirs) {
          const ldbDir = path.join(item.full, 'Default', 'Local Storage', 'leveldb');
          const auth = extractAuthFromLevelDbDir(ldbDir, hotmail);
          if (auth && auth.accessToken) {
            saveDuoPlusAuthCache({ profileId: item.d, hotmail, apiKey, auth });
            return auth;
          }
        }
      } catch (e) {}
    }
  }

  // 4. Fallback: Quét profile GPM mới nhất có đăng nhập DuoPlus
  for (const root of gpmRoots) {
    try {
      const dirs = fs.readdirSync(root)
        .map(d => {
          const full = path.join(root, d);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch (e) {}
          return { d, full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 40);

      for (const item of dirs) {
        const ldbDir = path.join(item.full, 'Default', 'Local Storage', 'leveldb');
        const auth = extractAuthFromLevelDbDir(ldbDir);
        if (auth && auth.accessToken) {
          saveDuoPlusAuthCache({ profileId: item.d, hotmail, apiKey, auth });
          return auth;
        }
      }
    } catch (e) {}
  }

  if (cache['latest']) return cache['latest'];
  return null;
}

/**
 * Tìm đường dẫn trình duyệt Chromium / Chrome trên máy tính
 * Ưu tiên Chromium riêng biệt (GPMLogin ChromiumCore / Puppeteer Chromium) trước để luôn hiển thị cửa sổ Chromium độc lập,
 * không bị gộp chung hoặc xung đột với Google Chrome cá nhân đang mở.
 */
async function resolveBrowserExecutablePath() {
  const isWin = process.platform === 'win32';
  if (isWin) {
    // 1. Ưu tiên ChromiumCore của GPMLogin (v154, v153, v144...) - đây là Chromium thuần, chạy cửa sổ riêng biệt cực nhạy
    const appData = process.env.APPDATA || 'C:\\Users\\Admin\\AppData\\Roaming';
    const gpmBrowsersDir = path.join(appData, 'GPMLoginGlobal', 'Browsers');
    if (fs.existsSync(gpmBrowsersDir)) {
      try {
        const subDirs = fs.readdirSync(gpmBrowsersDir)
          .filter(d => d.toLowerCase().startsWith('chromium'))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const sub of subDirs) {
          const candidate = path.join(gpmBrowsersDir, sub, 'chrome.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch (e) {}
    }
  }

  // 2. Thử Chromium đi kèm Puppeteer
  try {
    const pPath = typeof puppeteer.executablePath === 'function' ? await puppeteer.executablePath() : null;
    if (pPath && fs.existsSync(pPath)) return pPath;
  } catch (e) {}

  // 3. Fallback sang Google Chrome / Brave / Edge trên máy
  const commonPaths = isWin ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean) : [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

async function isDebugPortAlive(port) {
  if (!port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      headers: { 'Connection': 'close' },
      signal: AbortSignal.timeout(1200)
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

/**
 * Gửi HTTP Request thuần (agent: false, Connection: close) tới GPMLogin để không bao giờ bị kẹt socket cũ khi tắt/mở lại GPM
 */
function rawHttpRequestToGpm({ host = '127.0.0.1', port = 9495, urlPath = '/api/v1/profiles?page=1&per_page=1', method = 'GET', bodyBuffer = '', timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Connection': 'close'
    };
    if (bodyBuffer && method !== 'GET' && method !== 'HEAD') {
      headers['Content-Length'] = Buffer.byteLength(bodyBuffer);
    }

    const req = http.request({
      hostname: host,
      port: parseInt(port, 10) || 9495,
      path: urlPath,
      method,
      headers,
      agent: false,
      family: 4,
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode || 200,
          contentType: res.headers['content-type'] || 'application/json',
          text
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', (err) => {
      if (!err.message) {
        err.message = err.code || (err.errors && err.errors[0] && (err.errors[0].message || err.errors[0].code)) || 'ECONNREFUSED';
      }
      reject(err);
    });

    if (bodyBuffer && method !== 'GET' && method !== 'HEAD') {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

/**
 * Tự động khởi chạy lại GPMLoginGlobal.exe trên màn hình chính nếu người dùng lỡ tắt
 */
function tryAutoStartGpmLogin() {
  if (process.platform !== 'win32') return false;
  if (Date.now() - lastGpmAutoStartAttempt < 8000) return false;
  lastGpmAutoStartAttempt = Date.now();

  const gpmPaths = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'GPMLoginGlobal', 'GPMLoginGlobal.exe') : '',
    'C:\\Users\\Admin\\AppData\\Local\\Programs\\GPMLoginGlobal\\GPMLoginGlobal.exe',
    'C:\\Program Files\\GPMLoginGlobal\\GPMLoginGlobal.exe'
  ].filter(Boolean);

  const exePath = gpmPaths.find(p => fs.existsSync(p));
  if (!exePath) return false;

  try {
    ensureDir(PROFILE_BASE_DIR);
    const vbsPath = path.join(PROFILE_BASE_DIR, 'launch_gpm.vbs');
    const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${exePath}""", 1, False\r\n`;
    fs.writeFileSync(vbsPath, vbsContent, 'utf8');
    execSync(`schtasks /Create /TN "GpmAutoStartTask" /TR "wscript.exe ${vbsPath}" /SC ONCE /ST 00:00 /F`, { stdio: 'ignore' });
    execSync(`schtasks /Run /TN "GpmAutoStartTask"`, { stdio: 'ignore' });
    console.log('[GPM Auto-Recover] Đã kích hoạt mở lại GPMLoginGlobal.exe');
    return true;
  } catch (e) {
    try {
      const child = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return true;
    } catch (e2) {}
  }
  return false;
}

/**
 * Gọi GPMLogin API với cơ chế tự động thử lại & tự động đợi GPMLogin khởi động xong khi vừa tắt/mở lại
 */
async function ensureGpmRunningAndRequest({ port = 9495, urlPath, method = 'GET', bodyBuffer = '', maxRetries = 6 }) {
  const hosts = ['127.0.0.1', 'localhost'];
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    for (const host of hosts) {
      try {
        const res = await rawHttpRequestToGpm({
          host,
          port,
          urlPath,
          method,
          bodyBuffer,
          timeoutMs: 10000
        });
        return res;
      } catch (err) {
        lastError = err;
      }
    }

    // Nếu lần đầu thất bại do GPMLogin đang tắt hoặc đang mở lại, tự động kích hoạt GPMLogin và chờ
    if (attempt === 1) {
      tryAutoStartGpmLogin();
    }
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 900));
    }
  }

  throw lastError || new Error(`Không thể kết nối GPMLogin (Port ${port})`);
}

/**
 * Phát âm thanh cảnh báo lớn trực tiếp qua hệ thống Windows (dự phòng khi tab trình duyệt bị ẩn)
 */
function triggerSystemAlarmBeep() {
  if (process.platform !== 'win32') return;
  try {
    const cmd = `[Console]::Beep(1100,220); [Console]::Beep(1500,220); [Console]::Beep(1100,220); [Console]::Beep(1500,350)`;
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmd], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch (e) {}
}

/**
 * Mở trực tiếp cửa sổ Chrome/Chromium điều khiển Cloud Phone (Không qua Proxy GPM)
 * Hỗ trợ thoát khỏi sandbox desktop (WinSta0\exebox) để hiển thị trực tiếp lên màn hình chính (WinSta0\Default)
 */
async function launchDuoPlusDirectChromium(options = {}) {
  const {
    imageId = '',
    imageName = '',
    url = '',
    profileId = '',
    hotmail = '',
    apiKey = ''
  } = options;

  const browserPath = await resolveBrowserExecutablePath();
  if (!browserPath) {
    throw new Error('Không tìm thấy trình duyệt Chrome/Chromium trên máy tính');
  }

  // Nếu có imageId, mở thẳng link điều khiển & Temporary Startup của máy đó
  let targetUrl = url;
  if (imageId && (!targetUrl || targetUrl === 'https://my.duoplus.net/images')) {
    const devName = imageName || `snap_${imageId}`;
    targetUrl = `https://my.duoplus.net/control?id=${encodeURIComponent(imageId)}&mid=${encodeURIComponent(imageId)}&name=${encodeURIComponent(devName)}&w=363&h=682&isMobile=false&type=connect`;
  }
  if (!targetUrl) {
    targetUrl = 'https://my.duoplus.net/images';
  }

  const isControlUrl = targetUrl.includes('/control?');
  const auth = getDuoPlusAuth({ profileId, hotmail, apiKey });

  // Mỗi tài khoản DuoPlus có 1 thư mục profile riêng để không bị đá session nhau
  const rawKey = profileId || hotmail || apiKey || 'default';
  const safeKey = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'default';
  const userDataDir = path.join(PROFILE_BASE_DIR, `acct_${safeKey}`);
  ensureDir(userDataDir);

  let debugPort = activeDebugPorts.get(safeKey);
  let portAlive = await isDebugPortAlive(debugPort);

  let childPid = null;

  // Nếu chưa có cửa sổ Chrome/Chromium nào đang mở cho tài khoản này, khởi chạy mới
  if (!portAlive) {
    debugPort = 59100 + Math.floor(Math.random() * 800);
    activeDebugPorts.set(safeKey, debugPort);

    const winSize = isControlUrl ? '480,860' : '1280,840';
    const args = [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${debugPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--new-window',
      `--window-size=${winSize}`,
      'about:blank'
    ];

    if (process.platform === 'win32') {
      try {
        const vbsPath = path.join(PROFILE_BASE_DIR, 'launch_chrome.vbs');
        const vbsCmd = `""${browserPath}"" --user-data-dir=""${userDataDir}"" --remote-debugging-port=${debugPort} --no-first-run --no-default-browser-check --no-proxy-server --new-window --window-size=${winSize} ""about:blank""`;
        const vbsContent = [
          `Set WshShell = CreateObject("WScript.Shell")`,
          `WshShell.Run "${vbsCmd}", 1, False`,
          `WScript.Sleep 600`,
          `On Error Resume Next`,
          `WshShell.AppActivate "DuoPlus"`,
          `WshShell.AppActivate "Chromium"`,
          `WshShell.AppActivate "Chrome"`
        ].join('\r\n') + '\r\n';
        fs.writeFileSync(vbsPath, vbsContent, 'utf8');

        execSync(`schtasks /Create /TN "DuoPlusChromeLaunch" /TR "wscript.exe \\"${vbsPath}\\"" /SC ONCE /ST 00:00 /F`, { stdio: 'ignore' });
        execSync(`schtasks /Run /TN "DuoPlusChromeLaunch"`, { stdio: 'ignore' });
      } catch (e) {
        console.warn('[DuoPlus Chromium] schtasks warning:', e.message);
      }
    }

    // Chờ cổng DevTools từ schtasks sẵn sàng (tối đa 3.5 giây)
    const waitStart = Date.now();
    while (Date.now() - waitStart < 3500) {
      if (await isDebugPortAlive(debugPort)) {
        portAlive = true;
        break;
      }
      await new Promise(r => setTimeout(r, 250));
    }

    // Nếu schtasks chưa mở được (ví dụ đang dùng laptop bằng Pin nên Task Scheduler mặc định chặn), spawn trực tiếp!
    if (!portAlive) {
      const child = spawn(browserPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      childPid = child.pid;

      const waitSpawn = Date.now();
      while (Date.now() - waitSpawn < 5000) {
        if (await isDebugPortAlive(debugPort)) {
          portAlive = true;
          break;
        }
        await new Promise(r => setTimeout(r, 250));
      }
    }
  }

  if (portAlive) {
    let browser = null;
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${debugPort}`,
        defaultViewport: null
      });

      const pages = await browser.pages();
      let page = null;

      // Tìm tab trống hoặc tạo tab mới
      const blankPage = pages.find(p => p.url() === 'about:blank' || p.url().startsWith('chrome://newtab'));
      if (blankPage) {
        page = blankPage;
      } else {
        page = await browser.newPage();
      }

      // Bơm token đăng nhập DuoPlus vào localStorage trước khi trang chạy script
      if (auth && auth.accessToken) {
        await page.evaluateOnNewDocument((authObj) => {
          try {
            localStorage.setItem('duoplus.access_token', authObj.accessToken);
            localStorage.setItem('duoplus.expired_in', authObj.expiredIn);
            if (authObj.deviceId) localStorage.setItem('duoplus.deviceId', authObj.deviceId);
            localStorage.setItem('duoplus.locale', '"en"');
          } catch (e) {}
        }, auth);
      }

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

      // Đảm bảo localStorage đã có token (nếu trang vừa khởi tạo origin lần đầu)
      if (auth && auth.accessToken) {
        const needsReload = await page.evaluate((authObj) => {
          try {
            const current = localStorage.getItem('duoplus.access_token');
            if (current !== authObj.accessToken) {
              localStorage.setItem('duoplus.access_token', authObj.accessToken);
              localStorage.setItem('duoplus.expired_in', authObj.expiredIn);
              if (authObj.deviceId) localStorage.setItem('duoplus.deviceId', authObj.deviceId);
              localStorage.setItem('duoplus.locale', '"en"');
              return true;
            }
          } catch (e) {}
          return false;
        }, auth);

        if (needsReload) {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        }
      }

      try { await page.bringToFront(); } catch (e) {}
      await browser.disconnect();

      // Đưa cửa sổ Chromium lên trên cùng (Foreground) trên màn hình Windows
      if (process.platform === 'win32') {
        try {
          const focusVbs = path.join(PROFILE_BASE_DIR, 'focus_chrome.vbs');
          fs.writeFileSync(focusVbs, `Set WshShell = CreateObject("WScript.Shell")\r\nOn Error Resume Next\r\nWshShell.AppActivate "DuoPlus"\r\nWshShell.AppActivate "Chromium"\r\n`, 'utf8');
          const fChild = spawn('wscript.exe', [focusVbs], { detached: true, stdio: 'ignore' });
          fChild.unref();
        } catch (e) {}
      }
    } catch (connErr) {
      console.error('[DuoPlus Chromium Connect Error]:', connErr.message);
      if (browser) {
        try { await browser.disconnect(); } catch (e) {}
      }
    }
  } else {
    throw new Error('Không thể khởi chạy cửa sổ Chromium trên máy tính (DevTools port không phản hồi)');
  }

  return {
    success: true,
    pid: childPid,
    debugPort,
    browserPath,
    targetUrl,
    authenticated: !!(auth && auth.accessToken)
  };
}

module.exports = {
  saveDuoPlusAuthCache,
  getDuoPlusAuth,
  launchDuoPlusDirectChromium,
  isDebugPortAlive,
  ensureGpmRunningAndRequest,
  triggerSystemAlarmBeep
};
