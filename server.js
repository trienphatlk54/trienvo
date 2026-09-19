
function getFormattedTime(dateInput) {
  const date = dateInput ? new Date(dateInput) : new Date();
  const d = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const DD = d.getDate().toString().padStart(2, '0');
  const MM = (d.getMonth() + 1).toString().padStart(2, '0');
  const YYYY = d.getFullYear();
  const HH = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${HH}:${mm}:${ss} ${DD}/${MM}/${YYYY}`;
}

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const proxyChain = require('proxy-chain');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');


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
  let cleanStr = raw.trim();
  // Auto-detect type from prefix, overriding dropdown
  const prefixMatch = cleanStr.match(/^(socks5|socks4|http|https):\/\//i);
  if (prefixMatch) {
    type = prefixMatch[1].toLowerCase();
    cleanStr = cleanStr.replace(/^(socks5|socks4|http|https):\/\//i, '');
  }
  const parts = cleanStr.split(':');
  if (parts.length < 2) return null;
  return {
    type,
    host: parts[0],
    port: parts[1],
    user: parts[2] || '',
    pass: parts.slice(3).join(':') || '',
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
  if (S.browser) { 
    if (S.browser.__anonymizedProxyUrl) {
      proxyChain.closeAnonymizedProxy(S.browser.__anonymizedProxyUrl, true).catch(()=>{});
    }
    try { await S.browser.close(); } catch(_){} 
    S.browser = null; 
  }
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
  let anonymizedProxyUrl = null;
  if (proxy) {
    let purl = proxyUrl(proxy);
    if (proxy.user && proxy.pass) {
      console.log('  🔄 Proxy auth detected. Using proxy-chain to anonymize...');
      try {
        const encUser = encodeURIComponent(proxy.user);
        const encPass = encodeURIComponent(proxy.pass);
        anonymizedProxyUrl = await proxyChain.anonymizeProxy(`${proxy.type}://${encUser}:${encPass}@${proxy.host}:${proxy.port}`);
        purl = anonymizedProxyUrl;
      } catch (err) {
        console.log('  ❌ Error anonymizing proxy:', err.message);
      }
    }
    args.push(`--proxy-server=${purl}`);
    console.log(`  🌐 Chrome + proxy: ${purl}`);
  } else {
    console.log('  🌐 Chrome (không proxy)');
  }
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args,
    defaultViewport: { width: 1280, height: 900 },
    protocolTimeout: 180000,
    timeout: 60000,
  });
  
  if (anonymizedProxyUrl) {
    browser.__anonymizedProxyUrl = anonymizedProxyUrl;
  }
  return browser;
}

// ─── HTTP helper for Shopee API (with proxy support) ────────────────
function createProxyAgent() {
  if (!proxyConfig || !proxyConfig.verified) return undefined;
  const p = proxyConfig;
  if (p.type.toLowerCase().includes('socks')) {
    const uri = p.user
      ? `socks5://${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass)}@${p.host}:${p.port}`
      : `socks5://${p.host}:${p.port}`;
    return new SocksProxyAgent(uri);
  } else {
    const uri = p.user
      ? `http://${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass)}@${p.host}:${p.port}`
      : `http://${p.host}:${p.port}`;
    return new HttpsProxyAgent(uri);
  }
}

function shopeeRequest(method, url, data, cookieStr = '') {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = data ? JSON.stringify(data) : '';
    const agent = createProxyAgent();
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      ...(agent ? { agent } : {}),
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
        'Referer': 'https://shopee.vn/buyer/login',
        ...(cookieStr ? { 'Cookie': cookieStr } : {}),
        ...(cookieStr && cookieStr.match(/csrftoken=([^;]+)/) ? { 'X-CSRFToken': cookieStr.match(/csrftoken=([^;]+)/)[1] } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    };
    const r = https.request(opts, (res) => {
      const setCookies = res.headers['set-cookie'] || [];
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body, setCookies }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(postData);
    r.end();
  });
}

function mergeCookies(jar, setCookieHeaders) {
  for (const header of setCookieHeaders) {
    const parts = header.split(';')[0].split('=');
    if (parts.length >= 2) jar[parts[0].trim()] = parts.slice(1).join('=').trim();
  }
}

function jarToString(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ─── Fast QR Generation via Shopee API ──────────────────────────────
async function generateQRCode() {
  console.log('  🚀 Gọi API gen_qrcode...');
  const t0 = Date.now();
  const res = await shopeeRequest('GET', 'https://shopee.vn/api/v2/authentication/gen_qrcode');
  
  if (res.status !== 200) throw new Error(`gen_qrcode HTTP ${res.status}`);
  
  const json = JSON.parse(res.body);
  if (json.error !== 0) throw new Error(`gen_qrcode error: ${json.error_msg || json.error}`);
  
  const qrId = json.data.qrcode_id;
  const qrBase64 = json.data.qrcode_base64;
  
  // Collect cookies from response
  const jar = {};
  mergeCookies(jar, res.setCookies);
  
  console.log(`  ✅ QR tạo xong trong ${Date.now() - t0}ms`);
  return { qrId, qrImage: 'data:image/png;base64,' + qrBase64, jar };
}

// ─── Background Browser for WAF Bypass ───────────────────────────────
async function prepareBrowserInBackground(jar, proxyConfig, attemptId) {
  try {
    if (S.browser) {
      if (S.browser.__anonymizedProxyUrl) proxyChain.closeAnonymizedProxy(S.browser.__anonymizedProxyUrl, true).catch(()=>{});
      try { await S.browser.close(); } catch(_){}
    }
    
    console.log('  🌐 [Background] Khởi tạo trình duyệt ngầm để lấy chữ ký WAF...');
    const proxy = proxyConfig && proxyConfig.verified ? proxyConfig : null;
    S.browser = await launchBrowser(proxy);
    if (S.attemptId !== attemptId) return;
    
    S.page = await S.browser.newPage();
    S.akamaiReady = false;
    
    await S.page.setRequestInterception(true);
    S.page.on('request', (req) => {
      if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    
    const cookieEntries = Object.entries(jar).map(([name, value]) => ({
      name, value, domain: '.shopee.vn', path: '/', secure: true, sameSite: 'None',
    }));
    if (cookieEntries.length) await S.page.setCookie(...cookieEntries);
    
    await S.page.goto('https://shopee.vn/buyer/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (S.page.isClosed()) return;
      const patched = await S.page.evaluate(() => XMLHttpRequest.prototype.send.toString().includes('[native code]') === false).catch(()=>false);
      if (patched) {
        S.akamaiReady = true;
        console.log('  ✅ [Background] Akamai WAF đã sẵn sàng.');
        break;
      }
    }
  } catch(e) {
    console.log('  ⚠️ [Background] Lỗi tải trình duyệt ngầm:', e.message);
  }
}

// ─── Poll QR Status via API ─────────────────────────────────────────
function startApiPoll(qrId, jar, attemptId) {
  clearInterval(S.poll);
  console.log('  ⏳ Bắt đầu poll trạng thái QR...');
  
  S.poll = setInterval(async () => {
    if (['success', 'error', 'idle'].includes(S.status)) { clearInterval(S.poll); return; }
    if (S.attemptId !== attemptId) { clearInterval(S.poll); return; }
    
    try {
      const cookieStr = jarToString(jar);
      const statusRes = await shopeeRequest('GET',
        `https://shopee.vn/api/v2/authentication/qrcode_status?qrcode_id=${encodeURIComponent(qrId)}`,
        null, cookieStr);
      
      mergeCookies(jar, statusRes.setCookies);
      
      if (statusRes.status !== 200) return;
      const statusJson = JSON.parse(statusRes.body);
      const qrStatus = statusJson.data?.status;
      const qrToken = statusJson.data?.qrcode_token;
      
      if (qrStatus === 'CONFIRMED' || qrStatus === 'SCANNED') {
        if (S.status === 'ready') {
          S.status = 'scanned';
          console.log('  📲 QR đã quét!');
        }
      }
      
      if (qrStatus === 'EXPIRED') {
        S.status = 'expired';
        console.log('  ⏰ QR hết hạn');
        clearInterval(S.poll);
        return;
      }
      

      // If we got a token, try to login
      if (qrToken) {
        console.log('  ?? Nh?n du?c qrcode_token, dang l?y session qua Puppeteer...');
        clearInterval(S.poll);
        
        try {
          if (!S.page) {
            console.log('  ? Tr�nh duy?t ng?m chua kh?i t?o, ch? th�m...');
            for (let i = 0; i < 30; i++) {
              await new Promise(r => setTimeout(r, 500));
              if (S.page) break;
            }
          }
          if (!S.page) throw new Error('Kh�ng th? kh?i t?o tr�nh duy?t ng?m');

          if (!S.akamaiReady) {
            console.log('  ? Tr�nh duy?t ng?m dang t?i Akamai WAF, ch? th�m...');
            for (let i = 0; i < 30; i++) {
              await new Promise(r => setTimeout(r, 500));
              if (S.akamaiReady) break;
            }
            if (!S.akamaiReady) throw new Error('Tr�nh duy?t ng?m chua t?i xong WAF (Timeout)');
          }

          // Execute XHR directly in the page
          const fakeFp = jar['SPC_F'] || '';
          const loginResult = await S.page.evaluate(async (qId, qToken, fFp) => {
            return new Promise((resolve) => {
              try {
                const csrfMatch = document.cookie.match(/csrftoken=([^;]+)/);
                const csrf = csrfMatch ? csrfMatch[1] : '';
                
                const xhr = new XMLHttpRequest();
                xhr.open('POST', '/api/v2/authentication/qrcode_login', true);
                xhr.withCredentials = true;
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.setRequestHeader('X-API-SOURCE', 'pc');
                xhr.setRequestHeader('X-Shopee-Language', 'vi');
                xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                if (csrf) xhr.setRequestHeader('X-CSRFToken', csrf);
                
                xhr.onreadystatechange = function() {
                  if (xhr.readyState === 4) {
                    resolve({ status: xhr.status, body: xhr.responseText });
                  }
                };
                xhr.onerror = function() { resolve({ error: 'XHR Network Error' }); };
                
                xhr.send(JSON.stringify({
                  qrcode_id: qId,
                  qrcode_token: qToken,
                  device_sz_fingerprint: fFp,
                  client_identifier: { security_device_fingerprint: fFp }
                }));
              } catch (e) {
                resolve({ error: e.message });
              }
            });
          }, qrId, qrToken, fakeFp);
          
          if (loginResult.error) throw new Error(loginResult.error);
          console.log('  ?? qrcode_login (XHR) status:', loginResult.status);
          if (loginResult.status !== 200) {
            throw new Error('HTTP ' + loginResult.status + ': ' + (loginResult.body ? loginResult.body.substring(0, 100) : ''));
          }
          console.log('  ?? qrcode_login response body:', loginResult.body ? loginResult.body.substring(0, 200) : 'empty');
          try {
            const bodyJson = JSON.parse(loginResult.body);
            if (bodyJson.error) {
              throw new Error('Shopee API Error: ' + bodyJson.error + (bodyJson.error_msg ? ' - ' + bodyJson.error_msg : ''));
            }
          } catch(err) {
            if (err.message.includes('Shopee API Error')) throw err;
          }
          
          // Ch? Shopee set cookie
          await new Promise(r => setTimeout(r, 1000));
          const browserCookies = await S.page.cookies('https://shopee.vn');
          const spcSt = browserCookies.find(c => c.name === 'SPC_ST');
          
          if (spcSt) {
            const keep = ['SPC_ST', 'SPC_F', 'SPC_U', 'SPC_EC', 'SPC_CDS', 'SPC_R_T_ID', 'SPC_R_T_IV'];
            S.cookies = {
              SPC_ST: spcSt.value,
              SPC_F: browserCookies.find(c => c.name === 'SPC_F')?.value || jar['SPC_F'] || '',
              all: browserCookies.filter(c => keep.includes(c.name)).map(c => ({ name: c.name, value: c.value }))
            };
            console.log('\n?? �ANG NH?P OK! SPC_ST:', spcSt.value.substring(0, 50) + '�');
            // // S.status = 'success'; moved down
            
            // L?y userInfo qua browser (th�m CSRF)
            try {
              const infoJson = await S.page.evaluate(async () => {
                const csrfMatch = document.cookie.match(/csrftoken=([^;]+)/);
                const csrf = csrfMatch ? csrfMatch[1] : '';
                const r = await fetch('/api/v4/account/basic/get_account_info', {
                  headers: csrf ? { 'X-CSRFToken': csrf, 'X-API-SOURCE': 'pc' } : { 'X-API-SOURCE': 'pc' },
                  credentials: 'include'
                });
                return await r.json();
              });
              if (infoJson.data && infoJson.error === 0) {
                const info = infoJson.data;
                S.userInfo = {
                  username: info.username || info.shopname || '',
                  email: info.email || '',
                  phone: info.phone || info.phone_number || '',
                  createdAt: info.ctime || info.created_at || null,
                  avatar: info.portrait || info.avatar || '',
                  userid: info.userid || info.user_id || '',
                  raw: info,
                };
                console.log('  ? User info OK:', S.userInfo.username);
                S.status = 'success';
          } else {
                console.warn('  ?? get_account_info (browser) l?i:', infoJson.error);
              }
            } catch (e) {
              console.warn('  ?? L?i fetch userInfo browser:', e.message);
            }
          } else {
            console.log('  ?? Kh�ng nh?n du?c SPC_ST t? XHR');
            S.status = 'error';
            S.error = '�ang nh?p th�nh c�ng nhung kh�ng l?y du?c session cookie';
          }
        } catch (loginErr) {
          console.error('  ? Login error:', loginErr.message);
          S.status = 'error';
          S.error = 'L?i l?y session: ' + loginErr.message;
        } finally {
          if (S.browser) {
            if (S.browser.__anonymizedProxyUrl) proxyChain.closeAnonymizedProxy(S.browser.__anonymizedProxyUrl, true).catch(()=>{});
            try { await S.browser.close(); } catch(_){}
            S.browser = null; S.page = null;
          }
        }
      }

    } catch (e) {
      if (!['success', 'idle'].includes(S.status)) console.warn('  ⚠️ poll:', e.message.substring(0, 80));
    }
  }, 2000);
}

// ─── Fetch User Info (kept for backward compat) ─────────────────────
async function fetchUserInfo(page) {
  // This function is now only used as fallback
  console.log('  👤 Lấy thông tin tài khoản...');
  try {
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
      return {
        username: info.username || info.shopname || '',
        email: info.email || '',
        phone: info.phone || info.phone_number || '',
        createdAt: info.ctime || info.created_at || null,
        avatar: info.portrait || info.avatar || '',
        userid: info.userid || info.user_id || '',
        raw: info,
      };
    }
  } catch(e) { console.warn('  ⚠️ fetchUserInfo error:', e.message); }
  return null;
}

// (Old startPoll removed - replaced by startApiPoll above)

// ─── POST /api/proxy/save ──────────────────────────────────────────


app.post('/api/proxy/save', async (req, res) => {
  await reset();
  const { type, raw } = req.body;
  if (!type || !raw) return res.json({ success:false, error:'Thiếu thông tin proxy' });

  const p = parseProxy(type, raw.trim());
  if (!p) return res.json({ success:false, error:'Sai định dạng. Dùng: ip:port hoặc ip:port:user:pass' });

  console.log(`\n🔒 Test proxy: ${proxyUrl(p)}${p.user ? ' (auth)' : ''}`);

  // ── Lightweight IP check using HTTP agent (no Puppeteer!) ──
  try {
    const http = require('http');
    const https = require('https');

    let agent;
    if (p.type.toLowerCase().includes('socks')) {
      const proxyUri = p.user
        ? `socks5://${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass)}@${p.host}:${p.port}`
        : `socks5://${p.host}:${p.port}`;
      agent = new SocksProxyAgent(proxyUri);
      console.log(`  🔄 SOCKS5 agent created`);
    } else {
      const proxyUri = p.user
        ? `http://${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass)}@${p.host}:${p.port}`
        : `http://${p.host}:${p.port}`;
      agent = new HttpsProxyAgent(proxyUri);
      console.log(`  🔄 HTTP agent created`);
    }

    const ipServices = [
      'https://api.ipify.org?format=text',
      'https://icanhazip.com',
      'https://checkip.amazonaws.com',
      'http://ip-api.com/line/?fields=query',
      'https://ifconfig.me/ip',
    ];

    let ip = '';
    for (const url of ipServices) {
      try {
        console.log(`  🔍 Thử ${url}...`);
        const result = await new Promise((resolve, reject) => {
          const mod = url.startsWith('https') ? https : http;
          const reqOpt = new URL(url);
          const options = {
            hostname: reqOpt.hostname,
            port: reqOpt.port || (url.startsWith('https') ? 443 : 80),
            path: reqOpt.pathname + reqOpt.search,
            method: 'GET',
            agent: agent,
            timeout: 10000,
            headers: {
              'User-Agent': 'curl/7.88.0',
              'Accept': 'text/plain',
            },
          };
          const r = mod.request(options, (response) => {
            let body = '';
            response.on('data', chunk => body += chunk);
            response.on('end', () => resolve(body.trim()));
          });
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
          r.end();
        });

        if (result && /^[\d.:a-fA-F]+$/.test(result) && result.length >= 7 && result.length <= 45) {
          ip = result;
          console.log(`  ✅ IP: ${ip}`);
          break;
        }
        console.log(`  ⚠️ Response không hợp lệ: "${result.substring(0, 60)}"`);
      } catch(e2) {
        console.log(`  ⚠️ ${url} lỗi: ${e2.message.substring(0, 80)}`);
      }
    }

    if (!ip) {
      proxyConfig = null;
      return res.json({ success:false, error:'Proxy kết nối nhưng không lấy được IP. Kiểm tra lại proxy.' });
    }

    p.verified = true;
    p.ip = ip;
    
    // Lookup IP location
    let location = '';
    let displayIp = ip;
    try {
      const locRes = await fetch(`http://ip-api.com/json/${ip}?fields=country,city`);
      const locData = await locRes.json();
      if (locData && locData.country) {
        location = `${locData.country} - ${locData.city || 'Unknown'}`;
        displayIp = `${ip} (${location})`;
        p.location = location;
      }
    } catch(e) {
      console.log('  ⚠️ Lỗi lấy vị trí IP:', e.message);
    }

    proxyConfig = p;
    console.log(`  ✅ Proxy OK! IP: ${displayIp}`);
    res.json({ success:true, ip, displayIp, proxy: proxyUrl(p) });

  } catch(e) {
    proxyConfig = null;
    const msg = e.message || '';
    let hint = '';
    if (msg.includes('SOCKS'))
      hint = ' — Proxy không hỗ trợ SOCKS5, thử chọn HTTP';
    else if (msg.includes('ECONNREFUSED'))
      hint = ' — Proxy từ chối kết nối, kiểm tra IP/port';
    else if (msg.includes('ETIMEDOUT'))
      hint = ' — Proxy không phản hồi (timeout)';
    else if (msg.includes('auth'))
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
  res.json({ success:true, status:'loading', message:'Đang tải mã QR...' });

  const proxy = proxyConfig && proxyConfig.verified ? proxyConfig : null;
  console.log(`\n🚀 PHIÊN MỚI ${proxy ? '(proxy: '+proxyUrl(proxy)+')' : '(IP thật)'}`);

  try {
    const qrData = await generateQRCode();
    if (S.attemptId !== myAttemptId) return; // Superseded
    
    S.qrImage = qrData.qrImage;
    S.status = 'ready';
    S.expiresAt = Date.now() + QR_TTL;

    S.expire = setTimeout(() => {
      if (S.status === 'ready') { S.status = 'expired'; console.log('  ⏰ QR hết hạn'); }
    }, QR_TTL - 30000);

    prepareBrowserInBackground(qrData.jar, proxyConfig, myAttemptId);
    startApiPoll(qrData.qrId, qrData.jar, myAttemptId);
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
    const qrData = await generateQRCode();
    if (S.attemptId !== myAttemptId) return; // Superseded
    
    S.qrImage = qrData.qrImage;
    S.status = 'ready';
    S.expiresAt = Date.now() + QR_TTL;

    S.expire = setTimeout(() => {
      if (S.status === 'ready') { S.status = 'expired'; console.log('  ⏰ QR hết hạn'); }
    }, QR_TTL - 30000);

    prepareBrowserInBackground(qrData.jar, proxyConfig, myAttemptId);
    startApiPoll(qrData.qrId, qrData.jar, myAttemptId);
    console.log('  ✅ QR làm mới thành công\n');
  } catch(e) {
    if (S.attemptId !== myAttemptId) return; // Ignore errors from old tasks
    console.error('❌ /api/refresh error:', e.message);
    S.status = 'error'; S.error = e.message;
    try { await reset(); } catch(_) {}
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
      const time = getFormattedTime();
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
      await newEntry.set({  phone, password, provider, time, note, ipProxy, simSource, simStatus, identifier: identifier || '', phoneId: phoneId || '', orderStatus: '', shopeeSpcF: shopeeSpcF || '', shopeeSpcSt: shopeeSpcSt || '', shopeeUsername: shopeeUsername || '' , notes: notes || '' });
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

app.post('/api/sync/notes', async (req, res) => {
  const { key, notes } = req.body;
  try {
    if (key && notes !== undefined) {
      await db.ref(`shopee_accounts/${key}`).update({ notes });
      res.json({ success: true });
    } else {
      res.json({ success: false, error: 'Missing key or notes' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/sync/status', async (req, res) => {
  const { phoneId, dataId, status, result } = req.body;
  try {
    let targetPhoneId = phoneId;

    if (!targetPhoneId && dataId) {
      const dataSnap = await db.ref(`shopee_accounts/${dataId}`).once('value');
      if (dataSnap.exists()) {
        targetPhoneId = dataSnap.val().phoneId;
      }
    }

    const payload = {};
    if (status !== undefined) payload.orderStatus = status;
    if (result !== undefined) payload.result = result;

    if (dataId && Object.keys(payload).length > 0) {
      await db.ref(`shopee_accounts/${dataId}`).update(payload);
    }

    if (targetPhoneId && Object.keys(payload).length > 0) {
      await db.ref(`phones/${targetPhoneId}`).update(payload);
      
      const dataRowsSnap = await db.ref('shopee_accounts').orderByChild('phoneId').equalTo(targetPhoneId).once('value');
      const updates = {};
      dataRowsSnap.forEach(child => {
        if (status !== undefined) updates[`${child.key}/orderStatus`] = status;
        if (result !== undefined) updates[`${child.key}/result`] = result;
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


app.get('/api/ccn/all', async (req, res) => {
  try {
    const snap = await db.ref('ccn_accounts').once('value');
    res.json({ status: 1, data: snap.val() || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// === IRS BMF NPO Lookup (thay thế Melissa - miễn phí, không bị chặn) ===
const irsBmfCache = {}; // { stateCode: { data: [...], fetchedAt: timestamp } }
const ZIP_TO_STATE = {"005":"NY","006":"PR","007":"PR","008":"PR","009":"PR","010":"MA","011":"MA","012":"MA","013":"MA","014":"MA","015":"MA","016":"MA","017":"MA","018":"MA","019":"MA","020":"MA","021":"MA","022":"MA","023":"MA","024":"MA","025":"MA","026":"MA","027":"MA","028":"RI","029":"RI","030":"NH","031":"NH","032":"NH","033":"NH","034":"NH","035":"NH","036":"NH","037":"NH","038":"NH","039":"ME","040":"ME","041":"ME","042":"ME","043":"ME","044":"ME","045":"ME","046":"ME","047":"ME","048":"ME","049":"ME","050":"VT","051":"VT","052":"VT","053":"VT","054":"VT","055":"VT","056":"VT","057":"VT","058":"VT","059":"VT","060":"CT","061":"CT","062":"CT","063":"CT","064":"CT","065":"CT","066":"CT","067":"CT","068":"CT","069":"CT","070":"NJ","071":"NJ","072":"NJ","073":"NJ","074":"NJ","075":"NJ","076":"NJ","077":"NJ","078":"NJ","079":"NJ","080":"NJ","081":"NJ","082":"NJ","083":"NJ","084":"NJ","085":"NJ","086":"NJ","087":"NJ","088":"NJ","089":"NJ","100":"NY","101":"NY","102":"NY","103":"NY","104":"NY","105":"NY","106":"NY","107":"NY","108":"NY","109":"NY","110":"NY","111":"NY","112":"NY","113":"NY","114":"NY","115":"NY","116":"NY","117":"NY","118":"NY","119":"NY","120":"NY","121":"NY","122":"NY","123":"NY","124":"NY","125":"NY","126":"NY","127":"NY","128":"NY","129":"NY","130":"NY","131":"NY","132":"NY","133":"NY","134":"NY","135":"NY","136":"NY","137":"NY","138":"NY","139":"NY","140":"NY","141":"NY","142":"NY","143":"NY","144":"NY","145":"NY","146":"NY","147":"NY","148":"NY","149":"NY","150":"PA","151":"PA","152":"PA","153":"PA","154":"PA","155":"PA","156":"PA","157":"PA","158":"PA","159":"PA","160":"PA","161":"PA","162":"PA","163":"PA","164":"PA","165":"PA","166":"PA","167":"PA","168":"PA","169":"PA","170":"PA","171":"PA","172":"PA","173":"PA","174":"PA","175":"PA","176":"PA","177":"PA","178":"PA","179":"PA","180":"PA","181":"PA","182":"PA","183":"PA","184":"PA","185":"PA","186":"PA","187":"PA","188":"PA","189":"PA","190":"PA","191":"PA","192":"PA","193":"PA","194":"PA","195":"PA","196":"PA","197":"DE","198":"DE","199":"DE","200":"DC","201":"VA","202":"DC","203":"DC","204":"DC","205":"DC","206":"MD","207":"MD","208":"MD","209":"MD","210":"MD","211":"MD","212":"MD","214":"MD","215":"MD","216":"MD","217":"MD","218":"MD","219":"MD","220":"VA","221":"VA","222":"VA","223":"VA","224":"VA","225":"VA","226":"VA","227":"VA","228":"VA","229":"VA","230":"VA","231":"VA","232":"VA","233":"VA","234":"VA","235":"VA","236":"VA","237":"VA","238":"VA","239":"VA","240":"VA","241":"VA","242":"VA","243":"VA","244":"VA","245":"VA","246":"WV","247":"WV","248":"WV","249":"WV","250":"WV","251":"WV","252":"WV","253":"WV","254":"WV","255":"WV","256":"WV","257":"WV","258":"WV","259":"WV","260":"WV","261":"WV","262":"WV","263":"WV","264":"WV","265":"WV","266":"WV","267":"WV","268":"WV","270":"NC","271":"NC","272":"NC","273":"NC","274":"NC","275":"NC","276":"NC","277":"NC","278":"NC","279":"NC","280":"NC","281":"NC","282":"NC","283":"NC","284":"NC","285":"NC","286":"NC","287":"NC","288":"NC","289":"NC","290":"SC","291":"SC","292":"SC","293":"SC","294":"SC","295":"SC","296":"SC","297":"SC","298":"SC","299":"SC","300":"GA","301":"GA","302":"GA","303":"GA","304":"GA","305":"GA","306":"GA","307":"GA","308":"GA","309":"GA","310":"GA","311":"GA","312":"GA","313":"GA","314":"GA","315":"GA","316":"GA","317":"GA","318":"GA","319":"GA","320":"FL","321":"FL","322":"FL","323":"FL","324":"FL","325":"FL","326":"FL","327":"FL","328":"FL","329":"FL","330":"FL","331":"FL","332":"FL","333":"FL","334":"FL","335":"FL","336":"FL","337":"FL","338":"FL","339":"FL","340":"AA","341":"FL","342":"FL","344":"FL","346":"FL","347":"FL","349":"FL","350":"AL","351":"AL","352":"AL","353":"AL","354":"AL","355":"AL","356":"AL","357":"AL","358":"AL","359":"AL","360":"AL","361":"AL","362":"AL","363":"AL","364":"AL","365":"AL","366":"AL","367":"AL","368":"AL","369":"AL","370":"TN","371":"TN","372":"TN","373":"TN","374":"TN","375":"TN","376":"TN","377":"TN","378":"TN","379":"TN","380":"TN","381":"TN","382":"TN","383":"TN","384":"TN","385":"TN","386":"MS","387":"MS","388":"MS","389":"MS","390":"MS","391":"MS","392":"MS","393":"MS","394":"MS","395":"MS","396":"MS","397":"MS","398":"GA","399":"GA","400":"KY","401":"KY","402":"KY","403":"KY","404":"KY","405":"KY","406":"KY","407":"KY","408":"KY","409":"KY","410":"KY","411":"KY","412":"KY","413":"KY","414":"KY","415":"KY","416":"KY","417":"KY","418":"KY","420":"KY","421":"KY","422":"KY","423":"KY","424":"KY","425":"KY","426":"KY","427":"KY","430":"OH","431":"OH","432":"OH","433":"OH","434":"OH","435":"OH","436":"OH","437":"OH","438":"OH","439":"OH","440":"OH","441":"OH","442":"OH","443":"OH","444":"OH","445":"OH","446":"OH","447":"OH","448":"OH","449":"OH","450":"OH","451":"OH","452":"OH","453":"OH","454":"OH","455":"OH","456":"OH","457":"OH","458":"OH","459":"OH","460":"IN","461":"IN","462":"IN","463":"IN","464":"IN","465":"IN","466":"IN","467":"IN","468":"IN","469":"IN","470":"IN","471":"IN","472":"IN","473":"IN","474":"IN","475":"IN","476":"IN","477":"IN","478":"IN","479":"IN","480":"MI","481":"MI","482":"MI","483":"MI","484":"MI","485":"MI","486":"MI","487":"MI","488":"MI","489":"MI","490":"MI","491":"MI","492":"MI","493":"MI","494":"MI","495":"MI","496":"MI","497":"MI","498":"MI","499":"MI","500":"IA","501":"IA","502":"IA","503":"IA","504":"IA","505":"IA","506":"IA","507":"IA","508":"IA","509":"IA","510":"IA","511":"IA","512":"IA","513":"IA","514":"IA","515":"IA","516":"IA","520":"WI","521":"WI","522":"WI","523":"WI","524":"WI","525":"WI","526":"WI","527":"WI","528":"WI","529":"WI","530":"WI","531":"WI","532":"WI","534":"WI","535":"WI","537":"WI","538":"WI","539":"WI","540":"MN","541":"MN","542":"MN","543":"MN","544":"MN","545":"MN","546":"MN","547":"MN","548":"MN","549":"MN","550":"MN","551":"MN","553":"MN","554":"MN","555":"MN","556":"MN","557":"MN","558":"MN","559":"MN","560":"SD","561":"SD","562":"SD","563":"SD","564":"SD","565":"SD","566":"SD","567":"SD","570":"SD","571":"SD","572":"SD","573":"SD","574":"SD","575":"SD","576":"SD","577":"SD","580":"ND","581":"ND","582":"ND","583":"ND","584":"ND","585":"ND","586":"ND","587":"ND","588":"ND","590":"MT","591":"MT","592":"MT","593":"MT","594":"MT","595":"MT","596":"MT","597":"MT","598":"MT","599":"MT","600":"IL","601":"IL","602":"IL","603":"IL","604":"IL","605":"IL","606":"IL","607":"IL","608":"IL","609":"IL","610":"IL","611":"IL","612":"IL","613":"IL","614":"IL","615":"IL","616":"IL","617":"IL","618":"IL","619":"IL","620":"IL","621":"IL","622":"IL","623":"IL","624":"IL","625":"IL","626":"IL","627":"IL","628":"IL","629":"IL","630":"MO","631":"MO","633":"MO","634":"MO","635":"MO","636":"MO","637":"MO","638":"MO","639":"MO","640":"KS","641":"MO","644":"MO","645":"MO","646":"MO","647":"MO","648":"MO","649":"MO","650":"MO","651":"MO","652":"MO","653":"MO","654":"MO","655":"MO","656":"MO","657":"MO","658":"MO","659":"MO","660":"KS","661":"KS","662":"KS","664":"KS","665":"KS","666":"KS","667":"KS","668":"KS","669":"KS","670":"KS","671":"KS","672":"KS","673":"KS","674":"KS","675":"KS","676":"KS","677":"KS","678":"KS","679":"KS","680":"NE","681":"NE","683":"NE","684":"NE","685":"NE","686":"NE","687":"NE","688":"NE","689":"NE","690":"NE","691":"NE","692":"NE","693":"NE","700":"LA","701":"LA","703":"LA","704":"LA","705":"LA","706":"LA","707":"LA","708":"LA","710":"LA","711":"LA","712":"LA","713":"LA","714":"LA","716":"AR","717":"AR","718":"AR","719":"AR","720":"AR","721":"AR","722":"AR","723":"AR","724":"AR","725":"AR","726":"AR","727":"AR","728":"AR","729":"AR","730":"OK","731":"OK","734":"OK","735":"OK","736":"OK","737":"OK","738":"OK","739":"OK","740":"OK","741":"OK","743":"OK","744":"OK","745":"OK","746":"OK","747":"OK","748":"OK","749":"OK","750":"TX","751":"TX","752":"TX","753":"TX","754":"TX","755":"TX","756":"TX","757":"TX","758":"TX","759":"TX","760":"TX","761":"TX","762":"TX","763":"TX","764":"TX","765":"TX","766":"TX","767":"TX","768":"TX","769":"TX","770":"TX","771":"TX","772":"TX","773":"TX","774":"TX","775":"TX","776":"TX","777":"TX","778":"TX","779":"TX","780":"TX","781":"TX","782":"TX","783":"TX","784":"TX","785":"TX","786":"TX","787":"TX","788":"TX","789":"TX","790":"TX","791":"TX","792":"TX","793":"TX","794":"TX","795":"TX","796":"TX","797":"TX","798":"TX","799":"TX","800":"CO","801":"CO","802":"CO","803":"CO","804":"CO","805":"CO","806":"CO","807":"CO","808":"CO","809":"CO","810":"CO","811":"CO","812":"CO","813":"CO","814":"CO","815":"CO","816":"CO","820":"WY","821":"WY","822":"WY","823":"WY","824":"WY","825":"WY","826":"WY","827":"WY","828":"WY","829":"WY","830":"WY","831":"WY","832":"ID","833":"ID","834":"ID","835":"ID","836":"ID","837":"ID","838":"ID","840":"UT","841":"UT","842":"UT","843":"UT","844":"UT","845":"UT","846":"UT","847":"UT","850":"AZ","851":"AZ","852":"AZ","853":"AZ","855":"AZ","856":"AZ","857":"AZ","859":"AZ","860":"AZ","863":"AZ","864":"AZ","865":"AZ","870":"NM","871":"NM","872":"NM","873":"NM","874":"NM","875":"NM","877":"NM","878":"NM","879":"NM","880":"NM","881":"NM","882":"NM","883":"NM","884":"NM","889":"NV","890":"NV","891":"NV","893":"NV","894":"NV","895":"NV","897":"NV","898":"NV","900":"CA","901":"CA","902":"CA","903":"CA","904":"CA","905":"CA","906":"CA","907":"CA","908":"CA","909":"CA","910":"CA","911":"CA","912":"CA","913":"CA","914":"CA","915":"CA","916":"CA","917":"CA","918":"CA","919":"CA","920":"CA","921":"CA","922":"CA","923":"CA","924":"CA","925":"CA","926":"CA","927":"CA","928":"CA","930":"CA","931":"CA","932":"CA","933":"CA","934":"CA","935":"CA","936":"CA","937":"CA","938":"CA","939":"CA","940":"CA","941":"CA","942":"CA","943":"CA","944":"CA","945":"CA","946":"CA","947":"CA","948":"CA","949":"CA","950":"CA","951":"CA","952":"CA","953":"CA","954":"CA","955":"CA","956":"CA","957":"CA","958":"CA","959":"CA","960":"CA","961":"CA","967":"HI","968":"HI","970":"OR","971":"OR","972":"OR","973":"OR","974":"OR","975":"OR","976":"OR","977":"OR","978":"OR","979":"OR","980":"WA","981":"WA","982":"WA","983":"WA","984":"WA","985":"WA","986":"WA","988":"WA","989":"WA","990":"WA","991":"WA","992":"WA","993":"WA","994":"WA","995":"AK","996":"AK","997":"AK","998":"AK","999":"AK"};

function getStateFromZip(zip) {
  const prefix = zip.substring(0, 3);
  return ZIP_TO_STATE[prefix] || null;
}

async function fetchIrsBmf(stateCode) {
  // Cache for 24 hours
  const cached = irsBmfCache[stateCode];
  if (cached && (Date.now() - cached.fetchedAt) < 24 * 60 * 60 * 1000) {
    console.log('[NPO] Using cached data for', stateCode, '(' + cached.data.length + ' orgs)');
    return cached.data;
  }
  const url = 'https://www.irs.gov/pub/irs-soi/eo_' + stateCode.toLowerCase() + '.csv';
  console.log('[NPO] Downloading IRS BMF CSV:', url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('IRS BMF download failed: ' + res.status);
    const text = await res.text();
    console.log('[NPO] Downloaded', (text.length / 1024 / 1024).toFixed(1), 'MB for', stateCode);
    const lines = text.split('\n');
    // Columns: EIN,NAME,ICO,STREET,CITY,STATE,ZIP,...,ASSET_AMT(23),INCOME_AMT(24),...,NTEE_CD(26),SORT_NAME
    const data = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length < 7) continue;
      data.push({
        ein: cols[0],
        name: cols[1],
        ico: cols[2],
        street: cols[3],
        city: cols[4],
        state: cols[5],
        zip: cols[6],
        assetAmt: cols[23] || '0',
        incomeAmt: cols[24] || '0',
        ntee: cols[26] || ''
      });
    }
    console.log('[NPO] Parsed', data.length, 'orgs for', stateCode);
    irsBmfCache[stateCode] = { data, fetchedAt: Date.now() };
    return data;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      throw new Error('Tải dữ liệu IRS quá chậm (timeout 30s). Thử lại!');
    }
    throw e;
  }
}

app.get('/api/npo-lookup', async (req, res) => {
  try {
    const zip = req.query.zip;
    if (!zip) return res.status(400).json({ error: 'Missing zip code' });
    
    const stateCode = getStateFromZip(zip);
    if (!stateCode) {
      return res.json({ success: false, message: 'Không xác định được State từ Zipcode ' + zip });
    }
    
    console.log('[NPO] Looking up zip', zip, '=> state', stateCode);
    const allOrgs = await fetchIrsBmf(stateCode);
    
    // Filter by exact 5-digit zip prefix
    const zip5 = zip.substring(0, 5);
    const matchingOrgs = allOrgs.filter(o => o.zip && o.zip.startsWith(zip5));
    
    if (matchingOrgs.length === 0) {
      return res.json({ success: false, message: 'Không tìm thấy NPO nào ở Zipcode ' + zip5 + ' (State: ' + stateCode + '). Thử tạo Zipcode khác!' });
    }
    
    // Ưu tiên Assets & Income = 0 hoặc trống
    const zeroOrgs = matchingOrgs.filter(o => (!o.assetAmt || o.assetAmt === '0') && (!o.incomeAmt || o.incomeAmt === '0'));
    
    let selectedOrg;
    if (zeroOrgs.length > 0) {
      selectedOrg = zeroOrgs[Math.floor(Math.random() * zeroOrgs.length)];
    } else {
      selectedOrg = matchingOrgs[Math.floor(Math.random() * matchingOrgs.length)];
    }
    
    // Format EIN as XX-XXXXXXX
    let einFormatted = selectedOrg.ein;
    if (einFormatted && einFormatted.length === 9 && !einFormatted.includes('-')) {
      einFormatted = einFormatted.substring(0, 2) + '-' + einFormatted.substring(2);
    }
    
    res.json({
      success: true,
      organization: {
        ein: einFormatted,
        name: selectedOrg.name,
        address: selectedOrg.street,
        city: selectedOrg.city,
        state: selectedOrg.state,
        zip: selectedOrg.zip,
        inCareOf: selectedOrg.ico || '',
        assets: selectedOrg.assetAmt === '0' ? '$0' : '$' + Number(selectedOrg.assetAmt).toLocaleString(),
        income: selectedOrg.incomeAmt === '0' ? '$0' : '$' + Number(selectedOrg.incomeAmt).toLocaleString()
      },
      count: matchingOrgs.length,
      zeroAssetCount: zeroOrgs.length,
      source: 'IRS BMF (' + stateCode + ')'
    });
  } catch (error) {
    console.error('NPO Fetch Error:', error);
    res.status(500).json({ error: 'Lỗi server khi tải dữ liệu IRS BMF: ' + error.message });
  }
});


app.post('/api/ccn/save', async (req, res) => {
  const {  id, email, pass, twofa, country, address, status, identity, linkedProxy, bsn, assignedCards, extraSlots , notes } = req.body;
  try {
    const ref = db.ref('ccn_accounts');
    if (id) {
      await ref.child(id).update({  email, pass, twofa, country, address, status: status || 0, identity: identity || '', linkedProxy: linkedProxy || '', bsn: bsn || null, assignedCards: assignedCards || null, extraSlots: extraSlots || 0 , notes: notes || '' });
      res.json({ status: 1, id });
    } else {
      const newEntry = ref.push();
      await newEntry.set({ email, pass, twofa, country, address, status: status || 0, identity: identity || '', linkedProxy: linkedProxy || '', bsn: bsn || null, assignedCards: assignedCards || null, extraSlots: extraSlots || 0 });
      res.json({ status: 1, id: newEntry.key });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ccn/delete', async (req, res) => {
  const { id } = req.body;
  try {
    await db.ref('ccn_accounts').child(id).remove();
    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/ccn/clear-tab', async (req, res) => {
  const { status } = req.body;
  if (status === undefined) return res.status(400).json({ error: 'Missing status' });
  try {
    const snap = await db.ref('ccn_accounts').once('value');
    const data = snap.val() || {};
    const updates = {};
    for (let key in data) {
      if (data[key].status == status) {
        updates[key] = null;
      }
    }
    await db.ref('ccn_accounts').update(updates);
    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ccn/clear', async (req, res) => {
  try {
    await db.ref('ccn_accounts').remove();
    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CCN Cards CRUD
app.get('/api/ccn-cards-notes/all', async (req, res) => {
  try {
    const snap = await db.ref('ccn_cards_notes').once('value');
    res.json({ status: 1, data: snap.val() || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ccn-cards-notes/save', async (req, res) => {
  try {
    const { bin, note } = req.body;
    await db.ref(`ccn_cards_notes/${bin}`).set(note);
    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ccn-cards/all', async (req, res) => {
  try {
    const snap = await db.ref('ccn_cards').once('value');
    res.json({ status: 1, data: snap.val() || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ccn-cards/add', async (req, res) => {
  try {
    // rawText could be single line or multiline string of cards
    const { rawText } = req.body;
    if (!rawText) return res.json({ status: 1, message: 'No data' });
    
    // Parse the text into individual card strings (split by newline, remove empty)
    const cards = rawText.split('\n').map(c => c.trim()).filter(c => c.length > 10);
    
    const ref = db.ref('ccn_cards');
    const snap = await ref.once('value');
    let currentData = snap.val() || {};
    
    let addedCount = 0;
    
    for (const card of cards) {
      // Extract the first 6 digits (BIN)
      const match = card.match(/^(\d{6})/);
      if (match) {
        const bin = match[1];
        if (!currentData[bin]) {
          currentData[bin] = [];
        }
        // Avoid exact duplicates
        if (!currentData[bin].includes(card)) {
          currentData[bin].push(card);
          addedCount++;
        }
      }
    }
    
    await ref.set(currentData);
    res.json({ status: 1, added: addedCount, data: currentData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ccn-cards/clear', async (req, res) => {
  try {
    await db.ref('ccn_cards').remove();
    res.json({ status: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ccn-cards/delete', async (req, res) => {
  try {
    const { bin, index } = req.body;
    const ref = db.ref(`ccn_cards/${bin}`);
    const snap = await ref.once('value');
    let cards = snap.val() || [];
    if (cards.length > index) {
      cards.splice(index, 1);
      if (cards.length === 0) {
        await ref.remove(); // Remove bin if empty
      } else {
        await ref.set(cards);
      }
    }
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

app.post('/api/data/delete-multi', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({error: 'Invalid format'});
  try {
    const updates = {};
    for (const id of ids) {
      updates[`shopee_accounts/${id}`] = null;
    }
    await db.ref().update(updates);
    res.json({ status: 1 });
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
    // Auth handled by proxy-chain now
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

// ─── TIKTOK ACCOUNTS API ──────────────────────────────────────────
app.get('/api/tiktok/all', async (req, res) => {
  try {
    const ref = db.ref('tiktok_accounts');
    const snap = await ref.once('value');
    res.json(snap.val() || {});
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tiktok/save', async (req, res) => {
  const { id, identifier, mail, username, password, session, status, result } = req.body;
  try {
    const ref = db.ref('tiktok_accounts');
    if (id) {
      await ref.child(id).update({ identifier, mail, username, password, session, status, result });
    } else {
      const time = getFormattedTime();
      await ref.push().set({ identifier, mail, username, password, session, status, result, time });
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/tiktok/delete', async (req, res) => {
  const { id } = req.body;
  try {
    if (id) {
      await db.ref('tiktok_accounts').child(id).remove();
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── FLOPPYDATA PROXY API ──────────────────────────────────────────

const FLOPPY_BASE_URL = 'https://api.floppydata.net';
let floppydataLocationsCache = null;

app.get('/api/floppydata/locations', async (req, res) => {
  try {
    if (floppydataLocationsCache) return res.json(floppydataLocationsCache);
    const r = await fetch(FLOPPY_BASE_URL + '/v2/proxy/rotating/locations?type=residential', {
      headers: { 'X-Api-Key': req.headers['x-floppy-api-key'] || '' }
    });
    const text = await r.text();
    try {
      const data = JSON.parse(text);
      if (!r.ok) return res.status(r.status).json(data);
      floppydataLocationsCache = data;
      res.json(data);
    } catch(e) {
      res.status(r.status).json({ error: text });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/floppydata/create-proxy', async (req, res) => {
  const { country, state } = req.body;
  if (!country) return res.status(400).json({ success: false, error: 'Thiếu country' });
  try {
    const body = {
      type: 'residential',
      country,
      protocol: 'socks5',
      rotation: 60,
      udp: false
    };
    if (state) body.state = state;

    const r = await fetch(FLOPPY_BASE_URL + '/v2/proxy/rotating/connections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': req.headers['x-floppy-api-key'] || ''
      },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch(e) {
      return res.status(r.status).json({ success: false, error: text || 'Lỗi không xác định từ API' });
    }
    if (!r.ok) return res.status(r.status).json({ success: false, error: data.message || JSON.stringify(data) });
    res.json({ success: true, ...data });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/floppydata/proxies', async (_req, res) => {
  try {
    const snap = await db.ref('floppydata-proxies').once('value');
    res.json(snap.val() || {});
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/floppydata/proxies/save', async (req, res) => {
  const { country, state, connectionString, protocol, host, port, username, password } = req.body;
  try {
    const time = getFormattedTime();
    await db.ref('floppydata-proxies').push().set({
      country, state: state || '', connectionString, protocol, host, port, username, password, time
    });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/floppydata/proxies/delete', async (req, res) => {
  const { id } = req.body;
  try {
    if (id) await db.ref('floppydata-proxies').child(id).remove();
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/floppydata/balance', async (req, res) => {
  try {
    const r = await fetch(FLOPPY_BASE_URL + '/v2/proxy/rotating/balance', {
      headers: { 'X-Api-Key': req.headers['x-floppy-api-key'] || '' }
    });


// 🐼 PANDAPROXYS API 🐼

const PANDA_API_URL = 'https://pandaproxys.com/api/v2';
const PANDA_TOKEN = 'panda645884_eebe80da9de831be996be70d86669cc864ada9f19f035ac1812286690e2bb210';
const PANDA_MERCHANT_ID = '357e7dcd-d4a0-4ada-96da-c3725d3defa6';

app.get('/api/panda/proxies', async (req, res) => {
  try {
    const url = PANDA_API_URL + '/users/proxies?sort=[{"orderBy":"createdAt","order":"desc"}]&filters={"proxy":{"ipaddress":{"categorytype":{"id":2}}}}';
    const r = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + PANDA_TOKEN,
        'x-merchant-id': PANDA_MERCHANT_ID
      }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/panda/rotate', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ status: 'error', message: 'Thiếu ID proxy' });


app.post('/api/panda/check-proxy', async (req, res) => {
  const { proxyStr } = req.body;
  if (!proxyStr) return res.status(400).json({ success: false, error: 'Thiếu proxyStr' });
  try {
    let pHost, pPort, pUser, pPass;
    const parts = proxyStr.split(':');
    if (proxyStr.startsWith('http')) {
      const u = new URL(proxyStr);
      pHost = u.hostname;
      pPort = u.port;
      pUser = decodeURIComponent(u.username || '');
      pPass = decodeURIComponent(u.password || '');
    } else if (parts.length === 4) {
      pHost = parts[0]; pPort = parts[1]; pUser = parts[2]; pPass = parts[3];
    } else {
      pHost = parts[0]; pPort = parts[1];
    }
    
    const proxyUri = pUser ? `http://${encodeURIComponent(pUser)}:${encodeURIComponent(pPass)}@${pHost}:${pPort}` : `http://${pHost}:${pPort}`;
    const agent = new HttpsProxyAgent(proxyUri);
    
    const http = require('http');
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'ip-api.com', port: 80, path: '/json/', method: 'GET',
        agent: agent, timeout: 10000,
        headers: { 'User-Agent': 'curl/7.88.0' }
      };
      const r = http.request(options, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => resolve(body));
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
      r.end();
    });
    
    const data = JSON.parse(result);
    if (data && data.status === 'success') {
      res.json({ success: true, ip: data.query, location: data.country + ' - ' + data.city });
    } else {
      res.json({ success: false, error: 'Invalid response from ip-api' });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});
  try {
    const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
    const HttpProxyAgent = require('http-proxy-agent').HttpProxyAgent;
    
    const isHttpsProxy = proxyStr.startsWith('https');
    const agent = isHttpsProxy ? new HttpsProxyAgent(proxyStr) : new HttpProxyAgent(proxyStr);
    
    const fetch = require('node-fetch');
    const response = await fetch('http://ip-api.com/json/', { agent, timeout: 10000 });
    const data = await response.json();
    
    if (data && data.status === 'success') {
      res.json({ success: true, ip: data.query, location: data.country + ' - ' + data.city });
    } else {
      res.json({ success: false, error: 'Invalid response from ip-api' });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

  try {
    const url = PANDA_API_URL + '/proxies/' + id + '/rotate';
    const r = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + PANDA_TOKEN
      }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});


    const text = await r.text();
    try {
      res.json(JSON.parse(text));
    } catch(e) {
      res.status(r.status).json({ error: text || 'Lỗi không xác định từ API' });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
