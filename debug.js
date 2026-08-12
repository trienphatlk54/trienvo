// Tìm API endpoint lấy thông tin tài khoản Shopee
const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--lang=vi-VN,vi'],
    defaultViewport: { width: 1280, height: 900 },
  });

  // Dùng profile mặc định (có session login sẵn nếu user đã đăng nhập Chrome)
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36');

  // Thử các API endpoint phổ biến
  const endpoints = [
    'https://shopee.vn/api/v4/account/basic/get_account_info',
    'https://shopee.vn/api/v1/account_info',
    'https://shopee.vn/api/v2/user/account/get',
    'https://shopee.vn/api/v4/account/basic/get_basic_info',
    'https://shopee.vn/buyer/account/profile',
  ];

  // Trước tiên vào trang chủ để set cookies
  console.log('Tải trang chủ Shopee...');
  await page.goto('https://shopee.vn/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Check nếu đã đăng nhập
  const cookies = await page.cookies('https://shopee.vn');
  const spcST = cookies.find(c => c.name === 'SPC_ST');
  console.log('SPC_ST:', spcST ? spcST.value.substring(0, 30) + '...' : 'KHÔNG CÓ');

  if (!spcST) {
    console.log('\n⚠️ Chưa đăng nhập! Script này cần chạy với profile Chrome đã đăng nhập.');
    console.log('Thử fetch API để xem response format...\n');
  }

  for (const url of endpoints) {
    console.log(`\n--- ${url} ---`);
    try {
      const resp = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include' });
          const contentType = r.headers.get('content-type') || '';
          if (contentType.includes('json')) {
            const json = await r.json();
            return { status: r.status, json: JSON.stringify(json).substring(0, 500) };
          }
          const text = await r.text();
          return { status: r.status, text: text.substring(0, 300) };
        } catch(e) {
          return { error: e.message };
        }
      }, url);
      console.log('Status:', resp.status);
      if (resp.json) console.log('JSON:', resp.json);
      if (resp.text) console.log('Text:', resp.text.substring(0, 200));
      if (resp.error) console.log('Error:', resp.error);
    } catch(e) {
      console.log('Error:', e.message);
    }
  }

  // Thử navigate đến trang profile
  console.log('\n--- Navigate to /user/account/profile ---');
  try {
    await page.goto('https://shopee.vn/user/account/profile', { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: 'debug_profile_page.png' });
    console.log('Screenshot: debug_profile_page.png');
    console.log('URL:', page.url());
  } catch(e) {
    console.log('Error:', e.message);
  }

  // Intercept network requests khi load profile page
  console.log('\n--- Kiểm tra requests API từ trang profile ---');
  const apiRequests = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/') && url.includes('account')) {
      try {
        const json = await response.json();
        apiRequests.push({ url: url.substring(0, 100), data: JSON.stringify(json).substring(0, 500) });
      } catch(_) {}
    }
  });

  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
  await new Promise(r => setTimeout(r, 3000));

  if (apiRequests.length > 0) {
    console.log('API requests bắt được:');
    apiRequests.forEach(r => {
      console.log(`  URL: ${r.url}`);
      console.log(`  Data: ${r.data}\n`);
    });
  } else {
    console.log('Không bắt được API request nào.');
  }

  await browser.close();
  console.log('\nDone!');
})().catch(e => { console.error('LỖI:', e.message); process.exit(1); });
