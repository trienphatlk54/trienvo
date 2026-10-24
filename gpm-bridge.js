// 🌐 GPMLogin Bridge for Shopee Toolkit
// Cho phép website (chạy trên VPS hoặc Local) kết nối an toàn với GPMLogin trên máy tính cá nhân
// Tự động xử lý CORS và Chrome Private Network Access (PNA)
// Tự động phục hồi kết nối khi tắt/mở lại GPMLogin, không bao giờ trả lỗi 502 Bad Gateway

const http = require('http');
const {
  launchDuoPlusDirectChromium,
  ensureGpmRunningAndRequest,
  triggerSystemAlarmBeep
} = require('./duoplus-chromium-helper');
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

  // Ping / Health check endpoint (Tự động kiểm tra và đánh thức GPMLogin nếu vừa tắt/mở lại)
  if (req.url === '/api/v1/ping' || req.url === '/ping' || req.url === '/status') {
    let gpmOnline = false;
    try {
      const gpmRes = await ensureGpmRunningAndRequest({
        port: GPM_PORT,
        urlPath: '/api/v1/profiles?page=1&per_page=1',
        method: 'GET',
        maxRetries: 3
      });
      gpmOnline = gpmRes && gpmRes.status >= 200 && gpmRes.status < 400;
    } catch (e) {
      gpmOnline = false;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      bridge: true,
      bridgePort: BRIDGE_PORT,
      gpmPort: GPM_PORT,
      gpmOnline,
      message: gpmOnline ? 'GPM Bridge và GPMLogin đang hoạt động tốt!' : `GPM Bridge đang chạy, đang đợi GPMLogin (Port ${GPM_PORT}) sẵn sàng...`
    }));
    return;
  }

  // DuoPlus Timer Alarm Beep (Phát âm thanh cảnh báo hệ thống khi đạt 8/10 phút)
  if (req.url.includes('/duoplus/alarm-beep')) {
    triggerSystemAlarmBeep();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
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

  // DuoPlus Direct Chromium Launcher (Mở trực tiếp trình duyệt điều khiển Cloud Phone không qua Proxy GPM)
  if (req.url.includes('/duoplus/open-chromium') && req.method === 'POST') {
    let bodyBuffer = '';
    req.on('data', chunk => { bodyBuffer += chunk; });
    req.on('end', async () => {
      try {
        const body = bodyBuffer ? JSON.parse(bodyBuffer) : {};
        const result = await launchDuoPlusDirectChromium(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // DuoPlus OpenAPI: IP Check
  if (req.url.includes('/duoplus/my-ip')) {
    try {
      const ipRes = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
      const ipData = await ipRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ip: ipData.ip }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ip: '127.0.0.1' }));
    }
    return;
  }

  // DuoPlus Cloud Phone & Proxy OpenAPI Proxy handlers
  if (req.url.includes('/duoplus/cloudphone/') || req.url.includes('/duoplus/proxy/') || req.url.includes('/duoplus/mobile/')) {
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
        else if (req.url.includes('/cloudphone/initProxy')) subPath = '/api/v1/cloudPhone/initProxy';
        else if (req.url.includes('/cloudphone/proxySwitch')) subPath = '/api/v1/cloudPhone/proxySwitch';
        else if (req.url.includes('/cloudphone/newPhone')) subPath = '/api/v1/cloudPhone/newPhone';
        else if (req.url.includes('/proxy/add')) subPath = '/api/v1/proxy/add';
        else if (req.url.includes('/proxy/check')) subPath = '/api/v1/proxy/check';
        else if (req.url.includes('/proxy/list')) subPath = '/api/v1/proxy/list';
        else if (req.url.includes('/proxy/update')) subPath = '/api/v1/proxy/update';
        else if (req.url.includes('/mobile/modelList')) subPath = '/api/v1/mobile/modelList';

        if (!subPath) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Forward request to GPMLogin (với Auto-Recover & Connection: close, không bao giờ trả 502 Bad Gateway)
  let bodyBuffer = '';
  req.on('data', chunk => { bodyBuffer += chunk; });
  req.on('end', async () => {
    try {
      const gpmRes = await ensureGpmRunningAndRequest({
        port: GPM_PORT,
        urlPath: req.url,
        method: req.method,
        bodyBuffer,
        maxRetries: 8
      });
      res.writeHead(200, { 'Content-Type': gpmRes.contentType || 'application/json' });
      res.end(gpmRes.text);
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: `GPMLogin (Port ${GPM_PORT}) đang khởi động lại, vui lòng thử lại sau vài giây.`
      }));
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
  console.log('   ✨ Hỗ trợ kết nối trực tiếp từ Web VPS và Localhost (Auto-Recover GPM).');
  console.log('   🤖 Tích hợp tự động hóa đăng ký DuoPlus.net (Try Again & Manual OTP)');
  console.log('================================================================');
});

// Xuất server nếu require từ server.js
module.exports = server;

// Hỗ trợ nhận lệnh từ VPS (http://103.56.161.214:3000) khi Chrome chặn Private Network Access tới localhost:9497
const VPS_BASE_URL = process.env.VPS_URL || 'http://103.56.161.214:3000';
if (!global.__gpmVpsRpcPollerStarted) {
  global.__gpmVpsRpcPollerStarted = true;
  setInterval(async () => {
    try {
      const r = await fetch(`${VPS_BASE_URL}/api/gpm-rpc/poll`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return;
      const data = await r.json();
      if (data && data.hasTask && data.reqId) {
        const p = data.params || {};
        try {
          let result = null;
          if (data.action === 'gpm_request') {
            const gpmRes = await ensureGpmRunningAndRequest({
              port: parseInt(p.port, 10) || GPM_PORT,
              urlPath: p.urlPath,
              method: p.method || 'GET',
              bodyBuffer: p.bodyBuffer || null,
              maxRetries: p.maxRetries || 8
            });
            result = JSON.parse(gpmRes.text || '{}');
          } else if (data.action === 'duoplus_start_registration') {
            const taskId = startDuoplusRegistration({
              profileId: p.profileId,
              gpmPort: p.gpmPort || GPM_PORT,
              hotmailAccount: p.hotmailAccount,
              tiktokAccount: p.tiktokAccount,
              startFromStep: p.startFromStep || 1
            });
            result = { success: true, taskId };
          } else if (data.action === 'duoplus_task_status') {
            const task = getDuoplusTaskStatus(p.taskId);
            result = task ? { success: true, task } : { success: false, error: 'Không tìm thấy tác vụ' };
          } else if (data.action === 'duoplus_captcha_passed') {
            result = { success: markCaptchaPassed(p.taskId) };
          } else if (data.action === 'duoplus_retry_otp') {
            result = { success: retryDuoplusOtp(p.taskId) };
          } else if (data.action === 'duoplus_submit_otp') {
            result = { success: submitManualOtp(p.taskId, p.otp) };
          } else if (data.action === 'duoplus_cancel_task') {
            result = { success: cancelDuoplusTask(p.taskId) };
          } else if (data.action === 'duoplus_open_chromium') {
            result = await launchDuoPlusDirectChromium(p);
          } else if (data.action === 'duoplus_alarm_beep') {
            triggerSystemAlarmBeep();
            result = { success: true };
          }
          await fetch(`${VPS_BASE_URL}/api/gpm-rpc/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reqId: data.reqId, result }),
            signal: AbortSignal.timeout(8000)
          });
        } catch (err) {
          await fetch(`${VPS_BASE_URL}/api/gpm-rpc/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reqId: data.reqId, error: err.message || String(err) }),
            signal: AbortSignal.timeout(8000)
          }).catch(() => {});
        }
      }
    } catch (e) {}
  }, 1500);
}
