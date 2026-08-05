const express = require('express');
const puppeteer = require('puppeteer');
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
};

async function reset() {
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
  });
}

async function newPage(browser, proxy) {
  const ctx  = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9' });
  if (proxy && proxy.user) {
    await page.authenticate({ username: proxy.user, password: proxy.pass });
  }
  return { ctx, page };
}

// ─── Capture QR ────────────────────────────────────────────────────
async function captureQR(page) {
  console.log('  📸 Tìm QR...');
  const qrDataUrl = await page.evaluate(() => {
    for (const el of document.querySelectorAll('div')) {
      const r  = el.getBoundingClientRect();
      const bg = getComputedStyle(el).backgroundImage;
      if (r.width >= 120 && r.width <= 300 && Math.abs(r.width - r.height) < 10
          && bg.includes('data:image')) {
        const m = bg.match(/url\("?(data:image[^")\s]+)"?\)/);
        return m ? m[1] : null;
      }
    }
    return null;
  });
  if (qrDataUrl) { console.log('  ✅ QR từ background-image'); return qrDataUrl; }

  const el = await page.evaluateHandle(() => {
    let best = null, bestA = 0;
    for (const e of document.querySelectorAll('div')) {
      const r = e.getBoundingClientRect();
      if (r.y >= 150 && r.y <= 500 && r.width >= 120 && r.width <= 300
          && Math.abs(r.width - r.height) < 20 && r.width * r.height > bestA
          && e.children.length <= 1) { best = e; bestA = r.width * r.height; }
    }
    return best;
  });
  if (el.asElement()) {
    const b64 = await el.asElement().screenshot({ type:'png', encoding:'base64' });
    console.log('  ✅ QR từ element screenshot');
    return `data:image/png;base64,${b64}`;
  }

  console.log('  🔄 Fallback: clip');
  const b64 = await page.screenshot({ type:'png', encoding:'base64', clip:{ x:840,y:210,width:240,height:240 } });
  return `data:image/png;base64,${b64}`;
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
        S.status = 'success';
        console.log('\n🎉 ĐĂNG NHẬP OK! SPC_ST:', ST.value.substring(0,50) + '…');
        try { S.userInfo = await fetchUserInfo(page); } catch(e) { console.warn('  ⚠️', e.message); }
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

    // Thử nhiều dịch vụ IP (httpbin không ổn định)
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
        await page.goto(svc.url, { waitUntil: 'networkidle2', timeout: 12000 });
        const body = await page.evaluate(() => document.body.innerText);
        const parsed = svc.parse(body);
        // Kiểm tra IP hợp lệ (IPv4 hoặc IPv6)
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
  try {
    await reset();
    S.status = 'loading';

    const proxy = proxyConfig && proxyConfig.verified ? proxyConfig : null;
    console.log(`\n🚀 PHIÊN MỚI ${proxy ? '(proxy: '+proxyUrl(proxy)+')' : '(IP thật)'}`);

    S.browser = await launchBrowser(proxy);
    const { ctx, page } = await newPage(S.browser, proxy);
    S.ctx = ctx;
    S.page = page;

    console.log('  📄 Tải /buyer/login/qr ...');
    // domcontentloaded thay vì networkidle2 vì proxy chậm sẽ timeout
    await S.page.goto('https://shopee.vn/buyer/login/qr', { waitUntil:'domcontentloaded', timeout:90000 });
    // Chờ thêm để QR render (proxy chậm cần nhiều thời gian hơn)
    await delay(proxy ? 10000 : 6000);
    console.log('  ⏳ Đang chờ QR render...');
    // Chờ thêm cho background-image QR load
    try {
      await S.page.waitForFunction(() => {
        for (const el of document.querySelectorAll('div')) {
          const bg = getComputedStyle(el).backgroundImage;
          if (bg.includes('data:image')) return true;
        }
        return false;
      }, { timeout: 20000 });
    } catch(_) { console.log('  ⚠️ QR waitForFunction timeout, thử chụp anyway'); }

    const qr = await captureQR(S.page);
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
    await S.page.goto('https://shopee.vn/buyer/login/qr', { waitUntil:'domcontentloaded', timeout:90000 });
    await delay(8000);
    try {
      await S.page.waitForFunction(() => {
        for (const el of document.querySelectorAll('div')) {
          if (getComputedStyle(el).backgroundImage.includes('data:image')) return true;
        }
        return false;
      }, { timeout: 20000 });
    } catch(_) {}
    const qr = await captureQR(S.page);
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

// ─── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`\n✅ http://localhost:${PORT}\n`));
process.on('SIGINT', async () => {
  await reset();
  process.exit(0);
});
