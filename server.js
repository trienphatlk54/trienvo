const express = require('express');
const { Buffer } = require('buffer');
const http = require('http');
const net = require('net');
const { SocksClient } = require('socks');
const puppeteer = require('puppeteer');

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

// Tải proxy từ DB khi khởi động
try {
  db.ref('proxy').once('value').then(snapshot => {
    const data = snapshot.val();
    if (data && data.host) {
      proxyConfig = data;
      console.log(`\n🔒 Đã nạp cấu hình Proxy từ DB: ${data.type}://${data.host}:${data.port}`);
    }
  }).catch(e => console.error('Lỗi khi tải proxy từ DB:', e));
} catch(e) {}

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
  localProxyServer: null,
};

async function reset() {
  clearInterval(S.poll); clearTimeout(S.expire);
  if (S.localProxyServer) {
    S.localProxyServer.close();
    S.localProxyServer = null;
  }
  S.poll = S.expire = null;
  if (S.page) { try { await S.page.close(); } catch(_){} S.page = null; }
  if (S.ctx)  { try { await S.ctx.close();  } catch(_){} S.ctx  = null; }
  if (S.browser) { try { await S.browser.close(); } catch(_){} S.browser = null; }
  Object.assign(S, { status:'idle', qrImage:null, cookies:null, userInfo:null, error:null, expiresAt:null });
}

// ─── Local Proxy Bridge cho SOCKS5 ──────────────────────────────────
function startSocks5LocalProxy(proxyConfig) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Socks5 Bridge');
    });

    server.on('connect', (req, clientSocket, head) => {
      const [hostname, port] = req.url.split(':');
      
      const options = {
        proxy: {
          host: proxyConfig.host,
          port: parseInt(proxyConfig.port),
          type: 5
        },
        command: 'connect',
        destination: {
          host: hostname,
          port: parseInt(port || 443)
        }
      };

      if (proxyConfig.user) {
        options.proxy.userId = proxyConfig.user;
        options.proxy.password = proxyConfig.pass;
      }

      SocksClient.createConnection(options)
        .then(info => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          info.socket.write(head);
          info.socket.pipe(clientSocket);
          clientSocket.pipe(info.socket);
        })
        .catch(err => {
          console.error('  ⚠️ Lỗi cầu nối SOCKS5:', err.message);
          clientSocket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        });
    });

    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
    
    server.on('error', reject);
  });
}

// ─── Launch Browser (with optional proxy) ──────────────────────────
async function launchBrowser(proxy) {
  const args = [
    '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled','--lang=vi-VN,vi',
    '--disable-gpu','--disable-extensions','--disable-background-networking',
    '--disable-default-apps','--disable-sync','--no-first-run',
  ];
  if (proxy) {
    if (proxy.type === 'socks5' && proxy.user) {
      console.log(`  🌐 Khởi tạo Cầu nối SOCKS5 cục bộ cho: ${proxyUrl(proxy)}`);
      S.localProxyServer = await startSocks5LocalProxy(proxy);
      const localPort = S.localProxyServer.address().port;
      args.push(`--proxy-server=http://127.0.0.1:${localPort}`);
    } else {
      args.push(`--proxy-server=${proxyUrl(proxy)}`);
      console.log(`  🌐 Chrome + proxy: ${proxyUrl(proxy)}`);
    }
  } else {
    console.log('  🌐 Chrome (không proxy)');
  }
  return await puppeteer.launch({
    headless: 'new',
    args,
    defaultViewport: { width: 1280, height: 900 },
    protocolTimeout: 180000, // 3 phút, tránh lỗi WS endpoint timeout
  });
}

async function newPage(browser, proxy) {
  const ctx  = await browser.createBrowserContext();
  const page = await ctx.newPage();

  // Chặn image, media, font để tải nhanh, NHƯNG KHÔNG chặn stylesheet (vì React sẽ crash nếu thiếu CSS)
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

  // LUỒNG MỚI: Bắt trực tiếp ảnh QR từ API của Shopee siêu tốc
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/v2/authentication/gen_qrcode')) {
      try {
        const text = await res.text();
        const json = JSON.parse(text);
        if (json.data && json.data.qrcode_base64) {
          S.qrImage = 'data:image/png;base64,' + json.data.qrcode_base64;
          console.log('  🎉 Đã lấy ảnh QR siêu tốc qua API!');
        }
      } catch (e) {
        console.warn('  ⚠️ Lỗi đọc API QR:', e.message);
      }
    }
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9' });
  // Chỉ xác thực proxy HTTP/HTTPS. (SOCKS5 đã được xử lý qua cầu nối cục bộ)
  if (proxy && proxy.user && proxy.type !== 'socks5') {
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

// ── Hàm load trang Shopee và chờ QR ─────────────────────────────────────
async function navigateAndWaitForQR(page, proxy) {
  console.log('  🚀 Tải /buyer/login/qr ...');

  // Bước 1: Điều hướng với domcontentloaded (rất nhanh)
  await page.goto('https://shopee.vn/buyer/login/qr', {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  console.log('  ✔️ HTML loaded, đang chờ API trả về QR...');

  // Bước 2: Chờ S.qrImage được gán từ bộ bắt API (tối đa 90s)
  // KHÔNG reload giữa chừng vì sẽ huỷ mất request API đang chạy ngầm
  const maxWait = 180; // 180 * 500ms = 90 giây
  for (let i = 0; i < maxWait; i++) {
    if (S.qrImage) break;
    if (i > 0 && i % 20 === 0) { // Log mỗi 10 giây
      console.log(`  ⏳ Đang chờ API QR... (${i * 500 / 1000}s)`);
    }
    await delay(500);
  }

  if (S.qrImage) {
    console.log('  ✅ Đã nhận QR từ API!');
    return S.qrImage;
  } else {
    console.log('  ❌ Không lấy được QR qua API sau 90s');
    await logPageState(page, 'qr-fail');
    return null;
  }
}

// ── Hàm load trang Shopee và chờ QR (dùng chung cho start & refresh) ──
async function refreshQRApi(page) {
  // Shopee thường cung cấp button refresh trên trang, nhưng an toàn nhất là reload
  console.log('  🔄 Bắt đầu refresh QR...');
  S.qrImage = null; // Xóa ảnh cũ
  
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch(_) {}
  
  for (let i = 0; i < 30; i++) {
    if (S.qrImage) break;
    await delay(500);
  }
  
  return S.qrImage;
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

  console.log(`\n🔒 Đã lưu proxy mặc định: ${proxyUrl(p)}${p.user ? ' (auth)' : ''}`);

  p.verified = true;
  p.ip = p.host; // Không check live nên gán luôn host làm ip hiển thị
  proxyConfig = p;
  
  // Lưu proxy vào Firebase DB
  try {
    db.ref('proxy').set(p).catch(e => console.error('Lỗi lưu proxy vào DB:', e));
  } catch(e) {}
  
  let uri;
  if (p.type === 'socks5') {
    const rawAuth = p.user ? `${p.user}:${p.pass}@${p.host}:${p.port}` : `${p.host}:${p.port}`;
    uri = `socks://${Buffer.from(rawAuth).toString('base64')}`;
  } else {
    uri = p.user 
      ? `${p.type}://${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass)}@${p.host}:${p.port}`
      : `${p.type}://${p.host}:${p.port}`;
  }
  res.json({ 
    success:true, 
    ip: p.ip, 
    proxy: proxyUrl(p), 
    uri: uri,
    raw: p.user ? `${p.host}:${p.port}:${p.user}:${p.pass}` : `${p.host}:${p.port}`
  });
});

// ─── GET /api/proxy/status ─────────────────────────────────────────
app.get('/api/proxy/status', (_req, res) => {
  if (!proxyConfig) return res.json({ active:false });
  
  let uri = '';
  if (proxyConfig.type === 'socks5') {
    const rawAuth = proxyConfig.user ? `${proxyConfig.user}:${proxyConfig.pass}@${proxyConfig.host}:${proxyConfig.port}` : `${proxyConfig.host}:${proxyConfig.port}`;
    uri = `socks://${Buffer.from(rawAuth).toString('base64')}`;
  } else {
    uri = proxyConfig.user 
      ? `${proxyConfig.type}://${encodeURIComponent(proxyConfig.user)}:${encodeURIComponent(proxyConfig.pass)}@${proxyConfig.host}:${proxyConfig.port}`
      : `${proxyConfig.type}://${proxyConfig.host}:${proxyConfig.port}`;
  }
    
  res.json({
    active: true,
    verified: proxyConfig.verified,
    type: proxyConfig.type,
    host: proxyConfig.host,
    port: proxyConfig.port,
    hasAuth: !!proxyConfig.user,
    ip: proxyConfig.ip || '',
    uri: uri,
    raw: proxyConfig.user ? `${proxyConfig.host}:${proxyConfig.port}:${proxyConfig.user}:${proxyConfig.pass}` : `${proxyConfig.host}:${proxyConfig.port}`
  });
});


// ─── DELETE /api/proxy ─────────────────────────────────────────────
app.delete('/api/proxy', (_req, res) => {
  proxyConfig = null;
  try {
    db.ref('proxy').remove();
  } catch(e) {}
  console.log('  🗑️ Proxy đã xóa');
  res.json({ success:true });
});

// ─── POST /api/start ───────────────────────────────────────────────
app.post('/api/start', async (_req, res) => {
  try {
    await reset();
    S.status = 'loading';

    const proxy = proxyConfig && proxyConfig.verified ? proxyConfig : null;
    console.log(`\n🚀 PHIÊN MỚI ${proxy ? '(proxy: '+proxyUrl(proxy)+')' : '(IP thật)'}`);

    S.browser = await launchBrowser(proxy);
    const { ctx, page } = await newPage(S.browser, proxy);
    S.ctx = ctx;
    S.page = page;

    const qr = await navigateAndWaitForQR(S.page, proxy);
    if (!qr) throw new Error("Không lấy được mã QR từ API Shopee");
    
    S.qrImage   = qr;
    S.status    = 'ready';
    S.expiresAt = Date.now() + QR_TTL;

    S.expire = setTimeout(() => {
      if (S.status === 'ready') { S.status = 'expired'; console.log('  ⏰ QR hết hạn'); }
    }, QR_TTL - 30000);

    startPoll(S.page);
    console.log('  ✅ QR sẵn sàng\n');
    res.json({ success:true, qrImage:qr, expiresAt:S.expiresAt, usingProxy: !!proxy });
  } catch(e) {
    console.error('❌', e.message);
    S.status = 'error'; S.error = e.message;
    res.status(500).json({ success:false, error:e.message });
  }
});

// ─── POST /api/refresh ─────────────────────────────────────────────
app.post('/api/refresh', async (_req, res) => {
  if (!S.page) return res.status(400).json({ success:false, error:'Không có phiên' });
  try {
    clearTimeout(S.expire); clearInterval(S.poll);
    S.status = 'loading';
    console.log('\n🔄 Refresh QR...');
    const proxy = proxyConfig && proxyConfig.verified ? proxyConfig : null;
    const qr = await navigateAndWaitForQR(S.page, proxy);
    S.qrImage   = qr;
    S.status    = 'ready';
    S.expiresAt = Date.now() + QR_TTL;
    S.expire = setTimeout(() => { if (S.status === 'ready') S.status = 'expired'; }, QR_TTL - 30000);
    startPoll(S.page);
    console.log('  ✅ QR mới\n');
    res.json({ success:true, qrImage:qr, expiresAt:S.expiresAt });
  } catch(e) { console.error('❌', e.message); res.status(500).json({ success:false, error:e.message }); }
});

// ─── GET /api/status ───────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({
    status:    S.status,
    expiresAt: S.expiresAt,
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
    if (provider === 'funotp') {
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
    if (provider === 'funotp') {
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
    if (provider === 'funotp') {
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
    if (provider === 'funotp') {
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

// ── Database Endpoints (Firebase) ────────────────────────────────────────────
app.post('/api/data/save', async (req, res) => {
  const { phone, password, provider, time } = req.body;
  try {
    const ref = db.ref('shopee_accounts');
    const newEntry = ref.push();
    await newEntry.set({ phone, password, provider, time });
    res.json({ status: 1 });
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
  const { id, identifier, type, shopeePhone, shopeePassword, shopeeSpcF, shopeeSpcSt, shopeeUsername, shopeeEmail, shopeePhoneAlt, shopeeCreatedAt, shopeeSessionTime } = req.body;
  try {
    const ref = db.ref('phones');
    if (id) {
      // Update existing
      await ref.child(id).update({
        identifier, type, shopeePhone, shopeePassword, shopeeSpcF, shopeeSpcSt, shopeeUsername, shopeeEmail, shopeePhoneAlt, shopeeCreatedAt, shopeeSessionTime
      });
    } else {
      // Create new
      await ref.push().set({
        identifier, type, shopeePhone: '', shopeePassword: '', shopeeSpcF: '', shopeeSpcSt: '', shopeeUsername: '', shopeeEmail: '', shopeePhoneAlt: '', shopeeCreatedAt: '', shopeeSessionTime: ''
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
app.listen(PORT, () => console.log(`\n✅ http://localhost:${PORT}\n`));
process.on('SIGINT', async () => {
  await reset();
  process.exit(0);
});
