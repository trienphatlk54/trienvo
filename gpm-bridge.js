// 🌐 GPMLogin Bridge for Shopee Toolkit
// Cho phép website (chạy trên VPS hoặc Local) kết nối an toàn với GPMLogin trên máy tính cá nhân
// Tự động xử lý CORS và Chrome Private Network Access (PNA)
// Tích hợp DuoPlus Automation (Mở GPM, Tự điền form, Chờ Captcha, Quét Hotmail OTP, Hoàn tất đăng ký)

const http = require('http');
const { 
  startDuoplusRegistration, 
  getDuoplusTaskStatus, 
  markCaptchaPassed, 
  retryDuoplusOtp, 
  submitManualOtp, 
  cancelDuoplusTask 
} = require('./duoplus-automation');

const GPM_PORT = parseInt(process.env.GPM_PORT || '9495', 10);
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '9497', 10);

const server = http.createServer(async (req, res) => {
  // CORS & Private Network Access Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');

  // Preflight OPTIONS check
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Ping / Health check endpoint
  if (req.url === '/api/v1/ping' || req.url === '/ping' || req.url === '/status') {
    let gpmOnline = false;
    try {
      const pingRes = await fetch(`http://127.0.0.1:${GPM_PORT}/api/v1/profiles?page=1&per_page=1`, {
        signal: AbortSignal.timeout(2000)
      });
      gpmOnline = pingRes.ok;
    } catch(e) {
      try {
        const pingRes2 = await fetch(`http://localhost:${GPM_PORT}/api/v1/profiles?page=1&per_page=1`, {
          signal: AbortSignal.timeout(2000)
        });
        gpmOnline = pingRes2.ok;
      } catch(e2) {
        gpmOnline = false;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      bridge: true,
      bridgePort: BRIDGE_PORT,
      gpmPort: GPM_PORT,
      gpmOnline,
      message: gpmOnline ? 'GPM Bridge và GPMLogin đang hoạt động tốt!' : `GPM Bridge đang chạy nhưng GPMLogin (Port ${GPM_PORT}) chưa được bật trên máy tính.`
    }));
    return;
  }

  // DuoPlus Automation: Start Registration
  if ((req.url === '/api/v1/duoplus/start-registration' || req.url === '/api/duoplus/start-registration') && req.method === 'POST') {
    let bodyBuffer = '';
    req.on('data', chunk => { bodyBuffer += chunk; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyBuffer);
        const taskId = startDuoplusRegistration({
          profileId: body.profileId,
          gpmPort: body.gpmPort || GPM_PORT,
          hotmailAccount: body.hotmailAccount,
          tiktokAccount: body.tiktokAccount,
          startFromStep: body.startFromStep || 1
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, taskId }));
      } catch(err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // DuoPlus Automation: Task Status
  if ((req.url.startsWith('/api/v1/duoplus/task-status/') || req.url.startsWith('/api/duoplus/task-status/')) && req.method === 'GET') {
    const parts = req.url.split('/task-status/');
    const taskId = (parts[1] || '').split('?')[0];
    const task = getDuoplusTaskStatus(taskId);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Không tìm thấy tác vụ: ' + taskId }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, task }));
    return;
  }

  // DuoPlus Automation: Mark Captcha Passed manually
  if ((req.url.startsWith('/api/v1/duoplus/captcha-passed/') || req.url.startsWith('/api/duoplus/captcha-passed/')) && req.method === 'POST') {
    const parts = req.url.split('/captcha-passed/');
    const taskId = (parts[1] || '').split('?')[0];
    const ok = markCaptchaPassed(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
    return;
  }

  // DuoPlus Automation: Retry OTP (Try Again)
  if ((req.url.startsWith('/api/v1/duoplus/retry-otp/') || req.url.startsWith('/api/duoplus/retry-otp/')) && req.method === 'POST') {
    const parts = req.url.split('/retry-otp/');
    const taskId = (parts[1] || '').split('?')[0];
    const ok = retryDuoplusOtp(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
    return;
  }

  // DuoPlus Automation: Submit Manual OTP
  if ((req.url.startsWith('/api/v1/duoplus/submit-otp/') || req.url.startsWith('/api/duoplus/submit-otp/')) && req.method === 'POST') {
    const parts = req.url.split('/submit-otp/');
    const taskId = (parts[1] || '').split('?')[0];
    let bodyBuffer = '';
    req.on('data', chunk => { bodyBuffer += chunk; });
    req.on('end', () => {
      try {
        const body = JSON.parse(bodyBuffer);
        const ok = submitManualOtp(taskId, body.otp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: ok }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // DuoPlus Automation: Cancel Task
  if ((req.url.startsWith('/api/v1/duoplus/cancel-task/') || req.url.startsWith('/api/duoplus/cancel-task/')) && req.method === 'POST') {
    const parts = req.url.split('/cancel-task/');
    const taskId = (parts[1] || '').split('?')[0];
    const ok = cancelDuoplusTask(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
    return;
  }

  // DuoPlus Cloud Phone OpenAPI Proxy handlers
  if (req.url.includes('/duoplus/cloudphone/')) {
    let bodyBuffer = '';
    req.on('data', chunk => { bodyBuffer += chunk; });
    req.on('end', async () => {
      try {
        const body = bodyBuffer ? JSON.parse(bodyBuffer) : {};
        const apiKey = body.apiKey || req.headers['duoplus-api-key'] || '';
        
        let subPath = '';
        if (req.url.includes('/cloudphone/list')) subPath = '/api/v1/cloudPhone/list';
        else if (req.url.includes('/cloudphone/powerOn')) subPath = '/api/v1/cloudPhone/powerOn';
        else if (req.url.includes('/cloudphone/powerOff')) subPath = '/api/v1/cloudPhone/powerOff';
        else if (req.url.includes('/cloudphone/restart')) subPath = '/api/v1/cloudPhone/restart';
        else if (req.url.includes('/cloudphone/update')) subPath = '/api/v1/cloudPhone/update';
        else if (req.url.includes('/cloudphone/info')) subPath = '/api/v1/cloudPhone/info';

        if (!subPath) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Endpoint không tồn tại' }));
          return;
        }

        const openApiRes = await fetch('https://openapi.duoplus.net' + subPath, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'DuoPlus-API-Key': apiKey,
            'Lang': 'en'
          },
          body: JSON.stringify(body)
        });
        const openApiData = await openApiRes.json();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: openApiData.code === 200, ...openApiData }));
      } catch(err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Forward request to GPMLogin
  let bodyBuffer = '';
  req.on('data', chunk => { bodyBuffer += chunk; });
  req.on('end', async () => {
    const forwardTargets = [
      `http://127.0.0.1:${GPM_PORT}${req.url}`,
      `http://localhost:${GPM_PORT}${req.url}`
    ];

    let lastError = null;
    let gpmRes = null;

    for (const targetUrl of forwardTargets) {
      try {
        const fetchOptions = {
          method: req.method,
          headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
          signal: AbortSignal.timeout(10000)
        };
        if (req.method !== 'GET' && req.method !== 'HEAD' && bodyBuffer) {
          fetchOptions.body = bodyBuffer;
        }

        gpmRes = await fetch(targetUrl, fetchOptions);
        break;
      } catch(err) {
        lastError = err;
      }
    }

    if (!gpmRes) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: `Không thể kết nối đến GPMLogin (Port ${GPM_PORT}): ${lastError ? lastError.message : 'Unknown error'}. Hãy chắc chắn rằng GPMLogin đang chạy trên máy tính.`
      }));
      return;
    }

    try {
      const responseText = await gpmRes.text();
      res.writeHead(gpmRes.status, { 'Content-Type': gpmRes.headers.get('content-type') || 'application/json' });
      res.end(responseText);
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Lỗi đọc dữ liệu từ GPMLogin: ' + err.message }));
    }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[GPM Bridge] Cổng ${BRIDGE_PORT} đang được sử dụng (có thể bridge đã đang chạy).`);
  } else {
    console.error('[GPM Bridge] Lỗi máy chủ:', err.message);
  }
});

server.listen(BRIDGE_PORT, '0.0.0.0', () => {
  console.log('================================================================');
  console.log('   🚀 GPMLOGIN BRIDGE CHO SHOPEE TOOLKIT ĐÃ KHỞI ĐỘNG!');
  console.log(`   📡 Bridge Port: http://localhost:${BRIDGE_PORT}`);
  console.log(`   🔗 GPMLogin Port mục tiêu: http://localhost:${GPM_PORT}`);
  console.log('   ✨ Hỗ trợ kết nối trực tiếp từ Web VPS và Localhost.');
  console.log('   🤖 Tích hợp tự động hóa đăng ký DuoPlus.net (Try Again & Manual OTP)');
  console.log('================================================================');
});

// Xuất server nếu require từ server.js
module.exports = server;
