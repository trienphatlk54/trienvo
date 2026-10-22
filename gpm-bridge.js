// 🌐 GPMLogin Bridge for Shopee Toolkit
// Cho phép website (chạy trên VPS hoặc Local) kết nối an toàn với GPMLogin trên máy tính cá nhân
// Tự động xử lý CORS và Chrome Private Network Access (PNA)

const http = require('http');

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
  console.log('================================================================');
});

// Xuất server nếu require từ server.js
module.exports = server;
