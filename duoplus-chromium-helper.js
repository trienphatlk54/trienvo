// duoplus-chromium-helper.js
// Khởi chạy trực tiếp trình duyệt Chromium / Chrome trên máy tính (KHÔNG qua Proxy GPM)
// Tự động trích xuất & đồng bộ phiên đăng nhập DuoPlus (access_token, deviceId, expired_in)
// và kết nối thẳng vào màn hình điều khiển Cloud Phone (/control?id=...&type=connect)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const PROFILE_BASE_DIR = path.join(__dirname, '.duoplus_chromium_profile');
const AUTH_CACHE_FILE = path.join(PROFILE_BASE_DIR, 'auth_cache.json');

// Map lưu debugPort đang mở theo từng accountKey để tái sử dụng cửa sổ Chrome mượt mà
const activeDebugPorts = new Map();

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
 * Tìm đường dẫn trình duyệt Chrome / Chromium trên máy tính
 * Ưu tiên Google Chrome bản chính thức để hỗ trợ đầy đủ codec H264/WebRTC của Cloud Phone
 */
async function resolveBrowserExecutablePath() {
  const isWin = process.platform === 'win32';
  const commonPaths = isWin ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
  ].filter(Boolean) : [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const pPath = await puppeteer.executablePath();
    if (pPath && fs.existsSync(pPath)) return pPath;
  } catch (e) {}

  return null;
}

async function isDebugPortAlive(port) {
  if (!port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1200)
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

/**
 * Mở trực tiếp cửa sổ Chrome/Chromium điều khiển Cloud Phone (Không qua Proxy GPM)
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

  // Nếu chưa có cửa sổ Chrome nào đang mở cho tài khoản này, khởi chạy mới
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
      `--window-size=${winSize}`,
      'about:blank'
    ];

    const child = spawn(browserPath, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    childPid = child.pid;

    // Chờ cổng DevTools sẵn sàng (tối đa 5 giây)
    const waitStart = Date.now();
    while (Date.now() - waitStart < 5000) {
      if (await isDebugPortAlive(debugPort)) {
        portAlive = true;
        break;
      }
      await new Promise(r => setTimeout(r, 250));
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
    } catch (connErr) {
      console.error('[DuoPlus Chromium Connect Error]:', connErr.message);
      if (browser) {
        try { await browser.disconnect(); } catch (e) {}
      }
    }
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
  launchDuoPlusDirectChromium
};
