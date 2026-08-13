const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Simple log capturer
const sysLogs = [];
function addSysLog(type, ...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  sysLogs.push(`[${new Date().toISOString()}] [${type}] ${msg}`);
  if (sysLogs.length > 200) sysLogs.shift();
}
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
console.log = function(...args) { origLog.apply(console, args); addSysLog('INFO', ...args); };
console.error = function(...args) { origErr.apply(console, args); addSysLog('ERROR', ...args); };
console.warn = function(...args) { origWarn.apply(console, args); addSysLog('WARN', ...args); };
const path = require('path');
const bodyParser = require('body-parser');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

let serviceAccount;
try {
  serviceAccount = require('./firebase-key.json');
} catch (e) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    console.error("⚠️ Thiếu file firebase-key.json hoặc biến môi trường FIREBASE_SERVICE_ACCOUNT");
  }
}

// Initialize Firebase
const appFirebase = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://trienshopeetool-default-rtdb.asia-southeast1.firebasedatabase.app/"
});
const db = getDatabase(appFirebase);

const PORT   = process.env.PORT || 3000;
const QR_TTL = 3 * 60 * 1000;

const app = express();
app.get('/api/logs', (req, res) => res.type('text/plain').send(sysLogs.join('\n')));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname)); // Fallback cho trường hợp up code không có folder public
app.use(express.json());

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Proxy Config ──────────────────────────────────────────────────
let proxyConfig = null;

function parseProxy(type, raw) {
  const parts = raw.trim().split(':');
  if (parts.length < 2) return null;
  return {
    type,
    host: parts[0],
    port: parts[1],
    user: parts[2] || '',
    pass: parts[3] || '',
    verified: false,
  };
}

function proxyUrl(p) {
  return `${p.type}://${p.host}:${p.port}`;
}

// ─── Session ───────────────────────────────────────────────────────
const S = {
  browser:  null,
  ctx:      null,
  page:     null,
  status:   'idle',
  qrImage:  null,
  cookies:  null,
  userInfo: null,
  error:    null,
  poll:     null,
  expire:   null,
  expiresAt:null,
  attemptId:0,
};

async function reset() {
  S.attemptId++;
  clearInterval(S.poll); clearTimeout(S.expire);
  S.poll = S.expire = null;
  if (S.page) { try { await S.page.close(); } catch(_){} S.page = null; }
  if (S.ctx)  { try { await S.ctx.close();  } catch(_){} S.ctx  = null; }
  if (S.browser) { try { await S.browser.close(); } catch(_){} S.browser = null; }
  Object.assign(S, { status:'idle', qrImage:null, cookies:null, userInfo:null, error:null, expiresAt:null });
}

// ─── Launch Browser (with optional proxy) ──────────────────────────
async function launchBrowser(proxy) {
  const args = [
    '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled','--lang=vi-VN,vi',
    '--disable-gpu', '--no-first-run',
    '--disable-features=site-per-process',
  ];
  if (proxy) {
    args.push(`--proxy-server=${proxyUrl(proxy)}`);
    console.log(`  🌐 Chrome + proxy: ${proxyUrl(proxy)}`);
  } else {
    console.log('  🌐 Chrome (không proxy)');
  }
  return await puppeteer.launch({
    headless: 'new',
    args,
    defaultViewport: { width: 1280, height: 900 },
    protocolTimeout: 180000,
  });
}

async function newPage(browser, proxy) {
  const ctx  = await browser.createBrowserContext();
  const page = await ctx.newPage();

  // Chặn image, media, font để tải nhanh
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    const url = req.url();
    if (['image', 'media', 'font'].includes(t)) {
      req.abort();
    } else if (url.includes('google-analytics') || url.includes('facebook.net') || url.includes('doubleclick') || url.includes('tracker')) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Strategy 1: Bắt QR từ API response
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/v2/authentication/gen_qrcode') || url.includes('/api/v4/authentication/gen_qrcode')) {
      try {
        const text = await res.text();
        const json = JSON.parse(text);
        if (json.data && json.data.qrcode_base64) {
          S.qrImage = 'data:image/png;base64,' + json.data.qrcode_base64;
          console.log('  🎉 QR lấy qua API intercept!');
        } else if (json.data && json.data.qrcode_token) {
          S.qrToken = json.data.qrcode_token;
          console.log('  📌 Nhận QR token:', S.qrToken.substring(0, 30) + '...');
        }
      } catch (e) {
        console.warn('  ⚠️ Lỗi đọc API QR:', e.message);
      }
    }
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['vi-VN', 'vi', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8' });
  if (proxy && proxy.user) {
    await page.authenticate({ username: proxy.user, password: proxy.pass });
  }
  return { ctx, page };
}

// ─── Debug: log trạng thái trang hiện tại ──────────────────────────
async function logPageState(page, label) {
  try {
    const url = page.url();
    const title = await page.title();
    const bodySnippet = await page.evaluate(() => {
      const b = document.body;
      if (!b) return '(no body)';
      const text = b.innerText || '';
      return text.substring(0, 200).replace(/\n/g, ' ');
    });
    const elCount = await page.evaluate(() => document.querySelectorAll('*').length);
    console.log(`  📍 [${label}] URL: ${url}`);
    console.log(`  📄 [${label}] Title: ${title}`);
    console.log(`  📝 [${label}] Elements: ${elCount} | Body: ${bodySnippet}`);
  } catch(e) {
    console.log(`  ⚠️ [${label}] logPageState error: ${e.message}`);
  }
}

// ── Strategy 2: Fallback — lấy QR từ DOM (<img> hoặc <canvas>) ──────
async function extractQRFromDOM(page) {
  try {
    const qrData = await page.evaluate(() => {
      // Tìm img có src là data:image (QR base64)
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        if (img.src && img.src.startsWith('data:image') && img.width > 80 && img.width < 400) {
          return img.src;
        }
      }
      // Tìm canvas (Shopee đôi khi render QR bằng canvas)
      const canvases = document.querySelectorAll('canvas');
      for (const c of canvases) {
        if (c.width > 80 && c.width < 400) {
          try { return c.toDataURL('image/png'); } catch(_) {}
        }
      }
      // Tìm img có src là URL chứa "qrcode"
      for (const img of imgs) {
        if (img.src && (img.src.includes('qrcode') || img.src.includes('qr_code')) && img.naturalWidth > 80) {
          return img.src;
        }
      }
      return null;
    });
    return qrData;
  } catch(e) {
    console.warn('  ⚠️ extractQRFromDOM error:', e.message);
    return null;
  }
}

// ── Strategy 3: Screenshot vùng QR ──────────────────────────────────
async function screenshotQR(page) {
  try {
    const qrBox = await page.evaluate(() => {
      const selectors = [
        '[class*="qr-code"]', '[class*="qrcode"]', '[class*="QrCode"]',
        'img[alt*="QR"]', 'img[alt*="qr"]', 'canvas',
        '[data-testid*="qr"]', '[id*="qr"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 80 && r.height > 80) {
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          }
        }
      }
      return null;
    });
    if (qrBox) {
      const b64 = await page.screenshot({ clip: qrBox, type: 'png', encoding: 'base64' });
      return `data:image/png;base64,${b64}`;
    }
  } catch(e) {
    console.warn('  ⚠️ screenshotQR error:', e.message);
  }
  return null;
}

// ── Master: Lấy QR với nhiều chiến lược ──────────────────────────────
async function fetchQRCode(page, proxy, attemptId) {
  console.log('  🚀 Bắt đầu lấy mã QR Shopee...');
  S.qrImage = null;
  S.qrToken = null;

  // Navigate
  try {
    await page.goto('https://shopee.vn/buyer/login/qr', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    console.log('  ✔️ Đã tải trang login/qr');
  } catch(navErr) {
    if (!navErr.message.includes('detached') && !navErr.message.includes('ERR_ABORTED')) {
      throw navErr;
    }
    console.log('  ⚠️ Navigation warning (bỏ qua):', navErr.message.substring(0, 60));
  }

  // Chờ API intercept (Strategy 1) — tối đa 30s
  console.log('  ⏳ Chờ API QR response...');
  for (let i = 0; i < 60; i++) {
    if (attemptId !== undefined && S.attemptId !== attemptId) return null;
    if (S.qrImage) {
      console.log(`  ✅ [Strategy 1] QR từ API intercept (${i * 500}ms)`);
      return S.qrImage;
    }
    await delay(500);
  }

  // Chờ thêm sau khi trang render xong
  console.log('  ⏳ API chưa trả, chờ trang render...');
  try {
    await page.waitForSelector('img, canvas', { timeout: 15000 });
  } catch(_) {}
  await delay(2000);

  // Strategy 2: DOM extraction
  const domQR = await extractQRFromDOM(page);
  if (domQR) {
    console.log('  ✅ [Strategy 2] QR từ DOM!');
    S.qrImage = domQR;
    return domQR;
  }

  // Chờ thêm 15s cho trường hợp trang chậm
  console.log('  ⏳ Chờ thêm 15s...');
  for (let i = 0; i < 30; i++) {
    if (attemptId !== undefined && S.attemptId !== attemptId) return null;
    if (S.qrImage) {
      console.log('  ✅ [Strategy 1 - delayed] QR từ API!');
      return S.qrImage;
    }
    const dom2 = await extractQRFromDOM(page);
    if (dom2) {
      console.log('  ✅ [Strategy 2 - retry] QR từ DOM!');
      S.qrImage = dom2;
      return dom2;
    }
    await delay(500);
  }

  // Strategy 3: Screenshot vùng QR
  const ssQR = await screenshotQR(page);
  if (ssQR) {
    console.log('  ✅ [Strategy 3] QR từ screenshot!');
    S.qrImage = ssQR;
    return ssQR;
  }

  // Tất cả thất bại
  await logPageState(page, 'qr-all-strategies-failed');
  console.log('  ❌ Không lấy được QR sau tất cả strategies');
  return null;
}

// ─── Fetch User Info ───────────────────────────────────────────────
async function fetchUserInfo(page) {
  console.log('  👤 Lấy thông tin tài khoản...');
  const info = await page.evaluate(async () => {
    try {
      const r = await fetch('https://shopee.vn/api/v4/account/basic/get_account_info', { credentials: 'include' });
      const json = await r.json();
      if (json.data && json.error === 0) return json.data;
    } catch(_) {}
    return null;
  });
  if (info) {
    console.log('  ✅ User info OK');
    const result = {
      username:  info.username || info.shopname || '',
      email:     info.email || '',
      phone:     info.phone || info.phone_number || '',
      createdAt: info.ctime || info.created_at || null,
      avatar:    info.portrait || info.avatar || '',
      userid:    info.userid || info.user_id || '',
    };
    console.log('    User:', result.username, '| Keys:', Object.keys(info).join(','));
    return { ...result, raw: info };
  }
  return null;
}

// ─── Cookie Polling ────────────────────────────────────────────────
function startPoll(page) {
  clearInterval(S.poll);
  S.poll = setInterval(async () => {
    if (['success','error','idle'].includes(S.status)) { clearInterval(S.poll); return; }
    try {
      const cookies = await page.cookies('https://shopee.vn');
      const ST = cookies.find(c => c.name === 'SPC_ST' && c.value.length > 20);
      const url = page.url();
      if (S.status === 'ready' && !url.includes('/buyer/login')) {
        S.status = 'scanned';
        console.log('  📲 QR đã quét!');
      }
      if (ST) {
        clearInterval(S.poll); clearTimeout(S.expire);
        const F = cookies.find(c => c.name === 'SPC_F');
        const keep = ['SPC_ST','SPC_F','SPC_U','SPC_EC','SPC_CDS','SPC_R_T_ID','SPC_R_T_IV'];
        S.cookies = {
          SPC_ST: ST.value,
          SPC_F:  F ? F.value : '',
          all: cookies.filter(c => keep.includes(c.name)).map(c => ({ name:c.name, value:c.value })),
        };
        console.log('\n🎉 ĐĂNG NHẬP OK! SPC_ST:', ST.value.substring(0,50) + '…');
        try { S.userInfo = await fetchUserInfo(page); } catch(e) { console.warn('  ⚠️', e.message); }
        S.status = 'success';
      }
    } catch(e) {
      if (!['success','idle'].includes(S.status)) console.warn('  ⚠️ poll:', e.message.substring(0,50));
    }
  }, 2000);
}

// ─── POST /api/proxy/save ──────────────────────────────────────────
app.post('/api/proxy/save', async (req, res) => {
  const { type, raw } = req.body;
  if (!type || !raw) return res.json({ success:false, error:'Thiếu thông tin proxy' });

  const p = parseProxy(type, raw.trim());
  if (!p) return res.json({ success:false, error:'Sai định dạng. Dùng: ip:port hoặc ip:port:user:pass' });

  console.log(`\n🔒 Test proxy: ${proxyUrl(p)}${p.user ? ' (auth)' : ''}`);

  let testBrowser = null;
  try {
    testBrowser = await launchBrowser(p);
    const { ctx, page } = await newPage(testBrowser, p);

    const ipServices = [
      { url: 'https://api.ipify.org?format=json', parse: b => { try { return JSON.parse(b).ip; } catch(_) { return null; } } },
      { url: 'https://icanhazip.com',              parse: b => b.trim() },
      { url: 'https://checkip.amazonaws.com',       parse: b => b.trim() },
      { url: 'https://api.myip.com',                parse: b => { try { return JSON.parse(b).ip; } catch(_) { return null; } } },
    ];

    let ip = '';
    for (const svc of ipServices) {
      try {
        console.log(`  🔍 Thử ${svc.url}...`);
        await page.goto(svc.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const body = await page.evaluate(() => document.body.innerText);
        const parsed = svc.parse(body);
        if (parsed && /^[\d.:a-fA-F]+$/.test(parsed) && parsed.length >= 7 && parsed.length <= 45) {
          ip = parsed;
          console.log(`  ✅ IP: ${ip}`);
          break;
        }
        console.log(`  ⚠️ Response không hợp lệ: "${(body || '').substring(0, 60)}"`);
      } catch(e2) {
        console.log(`  ⚠️ ${svc.url} lỗi: ${e2.message.substring(0, 50)}`);
      }
    }

    await page.close();
    await ctx.close();
    await testBrowser.close();
    testBrowser = null;

    if (!ip) {
      proxyConfig = null;
      return res.json({ success:false, error:'Proxy kết nối nhưng không lấy được IP. Kiểm tra lại proxy.' });
    }

    p.verified = true;
    p.ip = ip;
    proxyConfig = p;
    console.log(`  ✅ Proxy OK! IP: ${ip}`);
    res.json({ success:true, ip, proxy: proxyUrl(p) });

  } catch(e) {
    if (testBrowser) try { await testBrowser.close(); } catch(_){}
    proxyConfig = null;
    const msg = e.message || '';
    let hint = '';
    if (msg.includes('ERR_SOCKS_CONNECTION_FAILED'))
      hint = ' — Proxy không hỗ trợ SOCKS5, thử chọn HTTP';
    else if (msg.includes('ERR_PROXY_CONNECTION_FAILED'))
      hint = ' — Proxy từ chối kết nối, kiểm tra IP/port';
    else if (msg.includes('ERR_TUNNEL_CONNECTION_FAILED'))
      hint = ' — Proxy không cho phép CONNECT tunnel';
    else if (msg.includes('ERR_PROXY_AUTH'))
      hint = ' — Sai username/password proxy';
    console.log(`  ❌ Proxy lỗi: ${msg}`);
    res.json({ success:false, error: `Không kết nối được${hint}: ${msg.substring(0,80)}` });
  }
});

// ─── GET /api/proxy/status ─────────────────────────────────────────
app.get('/api/proxy/status', (_req, res) => {
  if (!proxyConfig) return res.json({ active:false });
  res.json({
    active: true,
    verified: proxyConfig.verified,
    type: proxyConfig.type,
    host: proxyConfig.host,
    port: proxyConfig.port,
    hasAuth: !!proxyConfig.user,
    ip: proxyConfig.ip || '',
  });
});

// ─── DELETE /api/proxy ─────────────────────────────────────────────
app.delete('/api/proxy', (_req, res) => {
  proxyConfig = null;
  console.log('  🗑️ Proxy đã xóa');
  res.json({ success:true });
});

// ─── POST /api/start ───────────────────────────────────────────────
app.post('/api/start', async (_req, res) => {
  await reset();
  const myAttemptId = S.attemptId;
  S.status = 'loading';
  S.error = null;
  res.json({ success:true, status:'loading', message:'Đang khởi động...' });

  const proxy = proxyConfig && proxyConfig.verified ? proxyConfig : null;
  console.log(`\n🚀 PHIÊN MỚI ${proxy ? '(proxy: '+proxyUrl(proxy)+')' : '(IP thật)'}`);

  try {
    S.browser = await launchBrowser(proxy);
    if (S.attemptId !== myAttemptId) return; // Superseded
    const { ctx, page } = await newPage(S.browser, proxy);
    if (S.attemptId !== myAttemptId) return; // Superseded
    S.ctx = ctx;
    S.page = page;

    const qr = await fetchQRCode(S.page, proxy, myAttemptId);
    if (S.attemptId !== myAttemptId) return; // Superseded

    if (!qr) throw new Error("Không lấy được mã QR. Thử lại hoặc đổi IP/Proxy.");
    
    S.qrImage   = qr;
    S.status    = 'ready';
    S.expiresAt = Date.now() + QR_TTL;

    S.expire = setTimeout(() => {
      if (S.status === 'ready') { S.status = 'expired'; console.log('  ⏰ QR hết hạn'); }
    }, QR_TTL - 30000);

    startPoll(S.page);
    console.log('  ✅ QR sẵn sàng\n');
  } catch(e) {
    if (S.attemptId !== myAttemptId) return; // Ignore errors from old tasks
    console.error('❌ /api/start error:', e.message);
    S.status = 'error'; S.error = e.message;
    try { await reset(); } catch(_) {}
  }
});

// ─── POST /api/refresh ─────────────────────────────────────────────
app.post('/api/refresh', async (_req, res) => {
  S.attemptId++;
  const myAttemptId = S.attemptId;
  clearTimeout(S.expire); clearInterval(S.poll);
  S.status = 'loading';
  S.qrImage = null;
  S.error = null;
  res.json({ success:true, status:'loading', message:'Đang làm mới QR...' });

  console.log('\n🔄 Refresh QR...');
  const proxy = proxyConfig && proxyConfig.verified ? proxyConfig : null;

  try {
    if (S.page) {
      try {
        await S.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch(reloadErr) {
        if (S.attemptId !== myAttemptId) return;
        console.log('  ⚠️ Reload lỗi, tạo page mới...');
        try { if (S.page) await S.page.close(); } catch(_) {}
        try { if (S.ctx) await S.ctx.close(); } catch(_) {}
        const { ctx, page } = await newPage(S.browser, proxy);
        if (S.attemptId !== myAttemptId) return;
        S.ctx = ctx;
        S.page = page;
      }
    } else if (S.browser) {
      const { ctx, page } = await newPage(S.browser, proxy);
      if (S.attemptId !== myAttemptId) return;
      S.ctx = ctx;
      S.page = page;
    } else {
      S.browser = await launchBrowser(proxy);
      if (S.attemptId !== myAttemptId) return;
      const { ctx, page } = await newPage(S.browser, proxy);
      if (S.attemptId !== myAttemptId) return;
      S.ctx = ctx;
      S.page = page;
    }

    const qr = await fetchQRCode(S.page, proxy, myAttemptId);
    if (S.attemptId !== myAttemptId) return;

    if (!qr) throw new Error("Không lấy được mã QR khi refresh. Thử Bắt đầu lại.");

    S.qrImage   = qr;
    S.status    = 'ready';
    S.expiresAt = Date.now() + QR_TTL;
    S.expire = setTimeout(() => { if (S.status === 'ready') S.status = 'expired'; }, QR_TTL - 30000);
    startPoll(S.page);
    console.log('  ✅ QR mới\n');
  } catch(e) {
    if (S.attemptId !== myAttemptId) return;
    console.error('❌ /api/refresh error:', e.message);
    S.status = 'error'; S.error = e.message;
  }
});

// ─── GET /api/status ───────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({
    status:    S.status,
    expiresAt: S.expiresAt,
    qrImage:   S.qrImage  || undefined,
    cookies:   S.cookies  || undefined,
    userInfo:  S.userInfo || undefined,
    error:     S.error    || undefined,
  });
});

// ─── GET /api/screenshot ───────────────────────────────────────────
app.get('/api/screenshot', async (_req, res) => {
  if (!S.page) return res.status(400).json({ error:'Không có trang' });
  try {
    const b64 = await S.page.screenshot({ type:'png', encoding:'base64' });
    res.json({ image: `data:image/png;base64,${b64}` });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── 365OTP API ──────────────────────────────────────────────────────
// API Keys
const OTP_API_KEY = '6b3c90d2d968f47a422db7ed9555a9a7'; // 365otp
const FUNOTP_API_KEY = '4x0cb1alm0pn78ezi4kas7xu86fvrg5o'; // FunOTP
const OTISX_API_KEY = 'otis_wuxQo0pWqvtuZM9lBFMQFmmvzx4c2Etv'; // Otisx

app.get('/api/sim/services', async (_req, res) => {
  try {
    const r = await fetch(`http://365otp.com/apiv1/availableservice?apikey=${OTP_API_KEY}`);
    const data = await r.json();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sim/rent', async (req, res) => {
  const { serviceId, prefix, provider } = req.body;
  try {
    if (provider === 'otisx') {
      const url = `https://otistx.com/api/phone-rental/start`;
      const payload = { service: serviceId || 'otissim_v3', carrier: prefix || 'viettel' };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': OTISX_API_KEY },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (data.sessionId && data.phoneNumber) {
        return res.json({ status: 1, id: data.sessionId, phone: data.phoneNumber, cost: data.cost });
      }
      return res.json({ status: -1, message: data.message || 'Lỗi thuê Otisx' });
    } else if (provider === 'funotp') {
      let url = `https://funotp.com/api?action=number&service=${serviceId || 'shopee'}&apikey=${FUNOTP_API_KEY}`;
      if (prefix) url += `&network=${prefix}`; // FunOTP uses network/prefix similarly? Actually FunOTP might not support prefix, but we'll append it just in case or ignore it.
      const r = await fetch(url);
      const data = await r.json();
      if (data.ResponseCode === 0 && data.Result) {
        return res.json({ status: 1, id: data.Result.Session, phone: data.Result.Number });
      }
      return res.json({ status: -1, message: data.Message || 'Lỗi thuê FunOTP' });
    } else {
      let url = `http://365otp.com/apiv1/orderv2?apikey=${OTP_API_KEY}&serviceId=${serviceId || 270}&sendSms=true`;
      if (prefix) url += `&prefix=${prefix}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.json(data);
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sim/check', async (req, res) => {
  const { id, provider } = req.query;
  try {
    if (provider === 'otisx') {
      const url = `https://otistx.com/api/phone-rental/get-otp`;
      const payload = { sessionId: id };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': OTISX_API_KEY },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (data.status === 'completed' && data.otp) {
        return res.json({ status: 1, data: { code: data.otp } });
      } else if (data.status === 'waiting') {
        return res.json({ status: 1, data: { code: '' } }); // Đang chờ
      } else {
        return res.json({ status: -1, message: data.message || 'Đã hủy / Lỗi' });
      }
    } else if (provider === 'funotp') {
      const r = await fetch(`https://funotp.com/api?action=message&session=${id}&apikey=${FUNOTP_API_KEY}`);
      const data = await r.json();
      if (data.ResponseCode === 0 && data.Result && data.Result.OTP) {
        return res.json({ status: 1, data: { code: data.Result.OTP } });
      } else if (data.ResponseCode === 1) {
        return res.json({ status: 1, data: { code: '' } }); // Đang chờ
      } else {
        return res.json({ status: -1, message: data.Message || 'Đã hủy' });
      }
    } else {
      const r = await fetch(`http://365otp.com/apiv1/ordercheck?apikey=${OTP_API_KEY}&id=${id}`);
      const data = await r.json();
      return res.json(data);
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sim/balance', async (req, res) => {
  const { provider } = req.query;
  try {
    if (provider === 'otisx') {
      const url = `https://otistx.com/api/phone-rental/active-sessions`;
      const r = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': OTISX_API_KEY }
      });
      const data = await r.json();
      if (data.sessions) {
        return res.json({ status: 1, balance: `${data.sessions.length} sessions` });
      }
      return res.json({ status: -1, message: 'Lỗi lấy sessions' });
    } else if (provider === 'funotp') {
      const r = await fetch(`https://funotp.com/api?action=account&apikey=${FUNOTP_API_KEY}`);
      const data = await r.json();
      if (data.ResponseCode === 0 && data.Result) {
        return res.json({ status: 1, balance: data.Result.balance });
      }
      return res.json({ status: -1, message: data.Message });
    } else {
      const r = await fetch(`http://365otp.com/apiv1/getbalance?apikey=${OTP_API_KEY}`);
      const data = await r.json();
      return res.json(data);
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sim/continue', async (req, res) => {
  const { orderId, provider } = req.body;
  try {
    if (provider === 'otisx') {
      return res.json({ status: -1, message: 'Otisx chưa hỗ trợ thuê lại SIM cũ.' });
    } else if (provider === 'funotp') {
      const r = await fetch(`https://funotp.com/api?action=numberagain&session=${orderId}&apikey=${FUNOTP_API_KEY}`);
      const data = await r.json();
      if (data.ResponseCode === 0 && data.Result) {
        return res.json({ status: 1, id: data.Result.Session, phone: data.Result.Number });
      }
      return res.json({ status: -1, message: data.Message });
    } else {
      const r = await fetch(`http://365otp.com/apiv1/continueorder?apikey=${OTP_API_KEY}&orderId=${orderId}`);
      const data = await r.json();
      return res.json(data);
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Used IPs Endpoints ───────────────────────────────────────────────────────
app.get('/api/ips/used', async (req, res) => {
  try {
    const snapshot = await db.ref('used_ips').once('value');
    res.json({ status: 1, data: snapshot.val() || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ips/add', async (req, res) => {
  const { ip } = req.body;
  try {
    if (ip) {
      const time = new Date().toLocaleString('vi-VN');
      await db.ref('used_ips').push().set({ ip, time });
    }
    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ips/clear', async (req, res) => {
  try {
    await db.ref('used_ips').remove();
    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Database Endpoints (Firebase) ────────────────────────────────────────────
app.post('/api/data/save', async (req, res) => {
  const { phone, password, provider, time, note, ipProxy, simSource, simStatus, identifier, phoneId, shopeeSpcF, shopeeSpcSt, shopeeUsername, syncId } = req.body;
  try {
    const ref = db.ref('shopee_accounts');
    if (syncId) {
      await ref.child(syncId).update({ phone, password, provider, time, note, ipProxy, simSource, simStatus, identifier: identifier || '', phoneId: phoneId || '', shopeeSpcF: shopeeSpcF || '', shopeeSpcSt: shopeeSpcSt || '', shopeeUsername: shopeeUsername || '' });
    } else {
      const newEntry = ref.push();
      await newEntry.set({ phone, password, provider, time, note, ipProxy, simSource, simStatus, identifier: identifier || '', phoneId: phoneId || '', orderStatus: '', shopeeSpcF: shopeeSpcF || '', shopeeSpcSt: shopeeSpcSt || '', shopeeUsername: shopeeUsername || '' });
    }
    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/data/cleanup', async (req, res) => {
  try {
    const ref = db.ref('shopee_accounts');
    const snap = await ref.once('value');
    const data = snap.val();
    if (!data) return res.json({ status: 1, deleted: 0 });

    const seen = new Set();
    let count = 0;
    for (const key in data) {
      const item = data[key];
      const uniqueStr = [item.phoneId, item.provider, item.phone, item.password, item.identifier].join('|');
      const exactStr = [item.phone, item.time, item.provider, item.password].join('|');
      const sig = item.phoneId ? uniqueStr : exactStr;

      if (['365otp', 'viotp', 'Nhập tay'].includes(item.provider) || seen.has(sig)) {
        await ref.child(key).remove();
        count++;
      } else {
        seen.add(sig);
      }
    }
    res.json({ status: 1, deleted: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sync/status', async (req, res) => {
  const { phoneId, dataId, status } = req.body;
  try {
    let targetPhoneId = phoneId;

    // If only dataId is provided, find the associated phoneId
    if (!targetPhoneId && dataId) {
      const dataSnap = await db.ref(`shopee_accounts/${dataId}`).once('value');
      if (dataSnap.exists()) {
        targetPhoneId = dataSnap.val().phoneId;
      }
    }

    // Always update the specific dataId if provided
    if (dataId) {
      await db.ref(`shopee_accounts/${dataId}`).update({ orderStatus: status });
    }

    if (targetPhoneId) {
      // Update phone
      await db.ref(`phones/${targetPhoneId}`).update({ orderStatus: status });
      
      // Sync to all data rows having this phoneId
      const dataRowsSnap = await db.ref('shopee_accounts').orderByChild('phoneId').equalTo(targetPhoneId).once('value');
      const updates = {};
      dataRowsSnap.forEach(child => {
        updates[`${child.key}/orderStatus`] = status;
      });
      if (Object.keys(updates).length > 0) {
        await db.ref('shopee_accounts').update(updates);
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/data/all', async (req, res) => {
  try {
    const ref = db.ref('shopee_accounts');
    const snapshot = await ref.once('value');
    const data = snapshot.val();
    res.json({ status: 1, data: data || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/data/delete', async (req, res) => {
  const { id } = req.body;
  try {
    const ref = db.ref(`shopee_accounts/${id}`);
    await ref.remove();
    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Phones Endpoints (Firebase) ──────────────────────────────────────────────
app.get('/api/phones/all', async (req, res) => {
  try {
    const ref = db.ref('phones');
    const snapshot = await ref.once('value');
    const data = snapshot.val();
    res.json({ status: 1, data: data || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/phones/save', async (req, res) => {
  const { id, identifier, type, shopeePhone, shopeePassword, shopeeSpcF, shopeeSpcSt, shopeeUsername, shopeeEmail, shopeePhoneAlt, shopeeCreatedAt, shopeeSessionTime, note, ipProxy, simSource, simStatus } = req.body;
  try {
    const ref = db.ref('phones');
    if (id) {
      // Update existing
      await ref.child(id).update({
        identifier, type, shopeePhone, shopeePassword, shopeeSpcF, shopeeSpcSt, shopeeUsername, shopeeEmail, shopeePhoneAlt, shopeeCreatedAt, shopeeSessionTime, note, ipProxy, simSource, simStatus
      });
    } else {
      // Create new
      await ref.push().set({
        identifier, type, shopeePhone: '', shopeePassword: '', shopeeSpcF: '', shopeeSpcSt: '', shopeeUsername: '', shopeeEmail: '', shopeePhoneAlt: '', shopeeCreatedAt: '', shopeeSessionTime: '', note: '', ipProxy: '', simSource: '', simStatus: ''
      });
    }
    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/phones/delete', async (req, res) => {
  const { id } = req.body;
  try {
    const ref = db.ref(`phones/${id}`);
    await ref.remove();
    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/phones/complete', async (req, res) => {
  const { id } = req.body;
  try {
    const ref = db.ref(`phones/${id}`);
    const snapshot = await ref.once('value');
    const phoneData = snapshot.val();
    
    if (!phoneData) {
      return res.status(404).json({ error: 'Không tìm thấy điện thoại' });
    }

    // Save current shopee session to history
    const historyData = {
      shopeePhone: phoneData.shopeePhone || '',
      shopeePassword: phoneData.shopeePassword || '',
      shopeeSpcF: phoneData.shopeeSpcF || '',
      shopeeSpcSt: phoneData.shopeeSpcSt || '',
      shopeeUsername: phoneData.shopeeUsername || '',
      shopeeEmail: phoneData.shopeeEmail || '',
      shopeePhoneAlt: phoneData.shopeePhoneAlt || '',
      shopeeCreatedAt: phoneData.shopeeCreatedAt || '',
      shopeeSessionTime: phoneData.shopeeSessionTime || '',
      completedAt: new Date().toISOString()
    };

    // Push to history
    await ref.child('history').push().set(historyData);

    // Clear active session fields
    await ref.update({
      shopeePhone: '',
      shopeePassword: '',
      shopeeSpcF: '',
      shopeeSpcSt: '',
      shopeeUsername: '',
      shopeeEmail: '',
      shopeePhoneAlt: '',
      shopeeCreatedAt: '',
      shopeeSessionTime: ''
    });

    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────

// ─── Voucher Checking ──────────────────────────────────────────────
app.post('/api/voucher-check', async (req, res) => {
  const { vouchers, cookieStr, proxyStr } = req.body;
  if (!vouchers || !Array.isArray(vouchers) || vouchers.length === 0) {
    return res.status(400).json({ error: 'Missing vouchers array' });
  }
  if (!cookieStr) {
    return res.status(400).json({ error: 'Missing cookie string' });
  }

  // Set up streaming response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // Establish stream

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let proxyConfig = null;
  if (proxyStr) {
    const p = proxyStr.trim().split(':');
    if (p.length === 4) {
      proxyConfig = { type: 'http', host: p[0], port: p[1], user: p[2], pass: p[3] };
    } else if (p.length === 2) {
      proxyConfig = { type: 'http', host: p[0], port: p[1] };
    }
  }

  let browser = null;
  let ctx = null;
  
  try {
    sendEvent('progress', { message: 'Đang khởi động trình duyệt...' });
    browser = await launchBrowser(proxyConfig);
    ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    if (proxyConfig && proxyConfig.user && proxyConfig.pass) {
      await page.authenticate({ username: proxyConfig.user, password: proxyConfig.pass });
    }
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    

    // Parse cookies
    let spcF = '', spcSt = '';
    const cookieString = cookieStr.trim();
    if (cookieString.startsWith('SPC_F=')) {
      // SPC_F=abcd|user|pass
      spcF = cookieString.substring(6).split('|')[0];
    } else if (cookieString.startsWith('SPC_ST=')) {
      spcSt = cookieString.substring(7).split(';')[0];
    } else if (cookieString.includes('SPC_F=')) {
      const match = cookieString.match(/SPC_F=([^;]+)/);
      if (match) spcF = match[1];
    } else if (cookieString.includes('SPC_ST=')) {
      const match = cookieString.match(/SPC_ST=([^;]+)/);
      if (match) spcSt = match[1];
    } else {
      // Assume raw SPC_ST or SPC_F value if no prefix
      if (cookieString.length > 50) spcSt = cookieString;
      else spcF = cookieString;
    }

    sendEvent('progress', { message: 'Đang thiết lập cookie...' });
    const cookieObjs = [];
    if (spcF) cookieObjs.push({ name: 'SPC_F', value: spcF, domain: '.shopee.vn', path: '/' });
    if (spcSt) cookieObjs.push({ name: 'SPC_ST', value: spcSt, domain: '.shopee.vn', path: '/' });
    
    if (cookieObjs.length > 0) {
      await page.setCookie(...cookieObjs);
    }

    sendEvent('progress', { message: 'Đang truy cập ví Voucher...' });
    await page.goto('https://shopee.vn/user/voucher-wallet?lang=en', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000)); // give React extra time
    
    // Wait for the input box
    sendEvent('progress', { message: 'Chờ giao diện Shopee...' });
    try {
      await page.waitForSelector('input[placeholder*="voucher" i], input[placeholder*="Mã" i]', { timeout: 30000 });
    } catch (e) {
      let b64 = '', pageUrl = '', pageTitle = '', bodyText = '';
      try { 
        b64 = await page.screenshot({ encoding: 'base64' }); 
        pageUrl = page.url();
        pageTitle = await page.title();
        bodyText = await page.evaluate(() => document.documentElement ? document.documentElement.innerHTML.substring(0, 500).replace(/</g, '&lt;') : 'No HTML');
      } catch(err) {}
      const imgTag = b64 ? '<br><img src="data:image/png;base64,' + b64 + '" style="max-width:400px; border:1px solid #ccc; margin-top:10px;">' : '';
      throw new Error('Không tìm thấy ô nhập mã voucher. Cookie có thể đã chết hoặc giao diện thay đổi.<br><b>URL:</b> ' + pageUrl + '<br><b>Title:</b> ' + pageTitle + '<br><b>HTML:</b> <pre style="font-size:10px; max-height:100px; overflow:auto;">' + bodyText + '</pre><br>Ảnh màn hình hiện tại: ' + imgTag);
    }

    sendEvent('progress', { message: 'Bắt đầu check mã...' });
    
    for (let i = 0; i < vouchers.length; i++) {
      const vCode = vouchers[i].trim();
      if (!vCode) continue;
      
      try {
        const inputSelector = 'input[placeholder*="voucher code"], input[placeholder*="Mã Voucher"]';
        
        // Clear input and type
        await page.click(inputSelector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type(inputSelector, vCode, { delay: 30 });
        
        // Find and click redeem button
        const redeemBtnClicked = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find(b => 
            b.innerText.toLowerCase().includes('redeem') || 
            b.innerText.toLowerCase().includes('lưu') ||
            b.innerText.toLowerCase().includes('áp dụng') ||
            b.innerText.toLowerCase().includes('save')
          );
          if (btn && !btn.disabled) {
            btn.click();
            return true;
          }
          return false;
        });

        if (!redeemBtnClicked) {
          sendEvent('result', { voucher: vCode, result: 'Không bấm được nút Redeem (nút bị vô hiệu hóa hoặc không tìm thấy)' });
          continue;
        }

        // Wait for response text. It usually appears next to/below the input, or in a toast.
        // We will observe DOM mutations or wait for a specific text/toast to appear.
        let msg = '';
        try {
          msg = await page.evaluate(async () => {
            return new Promise(resolve => {
              // Wait up to 5 seconds for a message
              let ms = 0;
              const check = setInterval(() => {
                ms += 200;
                
                // 1. Check for error message directly below the input (shopee often uses a specific class, or we can just find any text node containing typical error keywords)
                // Wait for any text containing "Sorry", "invalid", "limit", "reached", "không hợp lệ", "đã dùng", "thành công", "successfully"
                const errorElements = Array.from(document.querySelectorAll('div, span, p')).filter(el => {
                  if (el.children.length > 0) return false; // Only get leaf nodes
                  const text = el.innerText.toLowerCase();
                  return text.includes('sorry') || text.includes('invalid') || 
                         text.includes('limit') || text.includes('không hợp lệ') || 
                         text.includes('đã hết') || text.includes('thành công') || 
                         text.includes('successfully') || text.includes('already');
                });
                
                if (errorElements.length > 0) {
                  // Prioritize elements that are near the input or toasts
                  const res = errorElements.map(e => e.innerText.trim()).find(t => t.length > 5);
                  if (res) {
                    clearInterval(check);
                    resolve(res);
                  }
                }
                
                if (ms > 5000) {
                  clearInterval(check);
                  resolve('Timeout: Không nhận được phản hồi từ Shopee');
                }
              }, 200);
            });
          });
        } catch (e) {
          msg = 'Lỗi khi trích xuất kết quả';
        }

        sendEvent('result', { voucher: vCode, result: msg });
        
        // Wait a bit before next voucher
        await new Promise(r => setTimeout(r, 1000));
        
      } catch (err) {
        sendEvent('result', { voucher: vCode, result: 'Lỗi: ' + err.message });
      }
    }
    
    sendEvent('done', { message: 'Hoàn tất check voucher' });

  } catch (e) {
    sendEvent('error', { message: e.message });
  } finally {
    if (page) try { await page.close(); } catch(_) {}
    if (ctx) try { await ctx.close(); } catch(_) {}
    if (browser) try { await browser.close(); } catch(_) {}
    res.end();
  }
});

// --- GoAffiliate Proxy ---
app.post('/api/goaffiliate', async (req, res) => {
  const { originalLink } = req.body;
  if (!originalLink) return res.status(400).json({ success: false, message: 'Thiếu originalLink' });
  try {
    const apiRes = await fetch('https://goaffiliate.online/api/get-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': '402622a5a09abb3a063de8fddde59e4c28af7bd44aa89e4eecd77835f963086c'
      },
      body: JSON.stringify({ originalLink })
    });
    const data = await apiRes.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(PORT, () => console.log(`\n✅ http://localhost:${PORT}\n`));
process.on('SIGINT', async () => {
  await reset();
  process.exit(0);
});
