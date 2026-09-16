
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


app.get('/api/npo-lookup', async (req, res) => {
  try {
    const zip = req.query.zip;
    if (!zip) return res.status(400).json({ error: 'Missing zip code' });
    
    const response = await fetch('https://lookups.melissa.com/home/npo/?value=' + zip, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await response.text();
    
    const orgs = [];
    const regex = /<tr class="item"[^>]*>([\s\S]*?)<\/tr>/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const rowHtml = match[1];
      const nameMatch = rowHtml.match(/<td class="text-left capitalize">\s*<a[^>]*>([^<]+)<\/a>/);
      const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' '));
      if (nameMatch && tds.length >= 5) {
        orgs.push({
          name: nameMatch[1].trim(),
          address: tds[1],
          city: tds[2],
          state: tds[3],
          zip: tds[4],
          inCareOf: tds[5] || '',
          assets: tds[7] || '',
          income: tds[8] || ''
        });
      }
    }
    
    if (orgs.length === 0) {
      return res.json({ success: false, message: 'Không tìm thấy tổ chức nào cho Zip này' });
    }
    
    const randomOrg = orgs[Math.floor(Math.random() * orgs.length)];
    res.json({ success: true, organization: randomOrg, count: orgs.length });
  } catch (error) {
    console.error('NPO Fetch Error:', error);
    res.status(500).json({ error: 'Lỗi server khi request melissa' });
  }
});
    
    const response = await fetch('https://lookups.melissa.com/home/npo/?value=' + zip, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await response.text();
    
    // Quick regex parsing to find all organization names
    const orgs = [];
    // The HTML has <tr class="item"...> ... <td class="text-left capitalize"> <a href="...">NAME</a> </td>
    const regex = /<td class="text-left capitalize">\s*<a href="[^"]+">([^<]+)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const name = match[1].trim();
      if (name) orgs.push(name);
    }
    
    if (orgs.length === 0) {
      return res.json({ success: false, message: 'Không tìm thấy tổ chức nào cho Zip này' });
    }
    
    // Pick a random organization
    const randomOrg = orgs[Math.floor(Math.random() * orgs.length)];
    res.json({ success: true, organization: randomOrg, count: orgs.length });
  } catch (error) {
    console.error('NPO Fetch Error:', error);
    res.status(500).json({ error: 'Lỗi server khi request melissa' });
  }
});


app.post('/api/ccn/save', async (req, res) => {
  const { id, email, pass, twofa, country, address, status, identity, linkedProxy, bsn } = req.body;
  try {
    const ref = db.ref('ccn_accounts');
    if (id) {
      await ref.child(id).update({ email, pass, twofa, country, address, status: status || 0, identity: identity || '', linkedProxy: linkedProxy || '', bsn: bsn || null });
      res.json({ status: 1, id });
    } else {
      const newEntry = ref.push();
      await newEntry.set({ email, pass, twofa, country, address, status: status || 0, identity: identity || '', linkedProxy: linkedProxy || '', bsn: bsn || null });
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

app.post('/api/ccn/clear', async (req, res) => {
  try {
    await db.ref('ccn_accounts').remove();
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
