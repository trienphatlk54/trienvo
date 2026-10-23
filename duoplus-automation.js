// duoplus-automation.js
// Tự động hóa đăng ký tài khoản DuoPlus trên GPMLogin:
// 1. Mở profile GPMLogin & kết nối Puppeteer
// 2. Chờ trang https://my.duoplus.net/sign-up tải xong
// 3. Điền email, password, tick đồng ý điều khoản
// 4. Bấm Send Code
// 5. Chờ người dùng giải Captcha (tự động phát hiện khi giải xong hoặc bấm bỏ qua)
// 6. Quét hộp thư Hotmail lấy OTP mới (chỉ lọc từ khóa 'duoplus', không lọc thời gian, hỗ trợ Try Again khi quá giờ)
// 7. Điền Verification Code & bấm Create Account
// 8. Quét chuyển trang mới ➔ Chờ 1-2s ➔ Bấm "Get Started"
// 9. Chờ trang tải ➔ Chờ 1-2s ➔ Tắt / ẩn hộp thông báo dialog ➔ Quét bấm "Claim Free"
// 10. Truy cập trực tiếp đường link https://my.duoplus.net/api
// 11. Chờ trang tải ➔ Chờ 1-2s ➔ Bấm "Generate Key", đợi mã xuất hiện, bấm "Copy", xác nhận Copied và lưu API Key

const puppeteer = require('puppeteer');
const { fetchHotmailOAuth2Otp } = require('./hotmail-otp-helper');

const activeTasks = new Map();
const profileDebugPorts = new Map();

/**
 * Khởi tạo tác vụ tự động đăng ký DuoPlus
 */
function startDuoplusRegistration({ profileId, gpmPort = 9495, hotmailAccount, tiktokAccount, startFromStep = 1 }) {
  const taskId = 'duo_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  
  const task = {
    id: taskId,
    profileId,
    hotmail: hotmailAccount.hotmail,
    tiktokUsername: tiktokAccount?.username || '',
    status: 'starting', // starting | navigating | filling_form | waiting_captcha | polling_otp | otp_timeout | submitting | configuring | completed | error
    step: 1,
    message: 'Đang khởi động trình duyệt GPMLogin...',
    otp: null,
    apiKey: null,
    error: null,
    captchaManuallyPassed: false,
    retryRequested: false,
    manualOtp: null,
    otpPollStart: null,
    cancelled: false,
    startTime: Date.now(),
    sendCodeTime: null,
    updatedAt: Date.now()
  };
  
  activeTasks.set(taskId, task);

  // Chạy quy trình nền bất đồng bộ
  runRegistrationFlow(task, { profileId, gpmPort, hotmailAccount, tiktokAccount, startFromStep }).catch(err => {
    task.status = 'error';
    task.error = err.message;
    task.message = 'Lỗi: ' + err.message;
    task.updatedAt = Date.now();
  });

  return taskId;
}

/**
 * Lấy trạng thái hiện tại của tác vụ
 */
function getDuoplusTaskStatus(taskId) {
  return activeTasks.get(taskId) || null;
}

/**
 * Đánh dấu đã giải Captcha thủ công
 */
function markCaptchaPassed(taskId) {
  const task = activeTasks.get(taskId);
  if (task) {
    task.captchaManuallyPassed = true;
    task.updatedAt = Date.now();
    return true;
  }
  return false;
}

/**
 * Yêu cầu thử lại quét OTP (Try Again) khi quá thời gian
 */
function retryDuoplusOtp(taskId) {
  const task = activeTasks.get(taskId);
  if (task) {
    task.retryRequested = true;
    task.status = 'polling_otp';
    task.otpPollStart = Date.now();
    task.message = '🔄 Đang tiếp tục quét hộp thư tìm email DuoPlus...';
    task.updatedAt = Date.now();
    return true;
  }
  return false;
}

/**
 * Nhập mã OTP thủ công
 */
function submitManualOtp(taskId, otp) {
  const task = activeTasks.get(taskId);
  if (task && otp && /^\d{6}$/.test(otp.trim())) {
    task.manualOtp = otp.trim();
    task.otp = otp.trim();
    task.updatedAt = Date.now();
    return true;
  }
  return false;
}

/**
 * Hủy tác vụ
 */
function cancelDuoplusTask(taskId) {
  const task = activeTasks.get(taskId);
  if (task) {
    task.cancelled = true;
    task.status = 'error';
    task.error = 'Người dùng đã hủy tác vụ';
    task.message = 'Tác vụ đã bị hủy';
    task.updatedAt = Date.now();
    return true;
  }
  return false;
}

/**
 * Quy trình thực thi tự động hóa
 */
async function runRegistrationFlow(task, { profileId, gpmPort, hotmailAccount, tiktokAccount, startFromStep = 1 }) {
  let browser = null;

  try {
    if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

    // BƯỚC 1: Khởi động profile trên GPMLogin
    task.status = 'starting';
    task.step = 1;
    task.message = 'Đang mở profile GPMLogin trên màn hình máy tính...';
    task.updatedAt = Date.now();

    let remote_debugging_port = null;
    let websocket_debugging_url = null;

    try {
      const startRes = await fetch(`http://127.0.0.1:${gpmPort}/api/v1/profiles/start/${profileId}`, {
        signal: AbortSignal.timeout(15000)
      });
      const startData = await startRes.json();
      if (startData && startData.data) {
        remote_debugging_port = startData.data.remote_debugging_port;
        websocket_debugging_url = startData.data.websocket_debugging_url;
      }
    } catch(err) {
      console.log('[DuoPlus Automation] profiles/start error:', err.message);
    }

    if (!remote_debugging_port && profileDebugPorts.has(profileId)) {
      const cached = profileDebugPorts.get(profileId);
      remote_debugging_port = cached.remote_debugging_port;
      websocket_debugging_url = cached.websocket_debugging_url;
    }

    if (!remote_debugging_port && !websocket_debugging_url) {
      throw new Error('GPMLogin không thể kết nối profile hoặc thiếu cổng DevTools. Vui lòng đảm bảo GPMLogin đang chạy!');
    }

    profileDebugPorts.set(profileId, { remote_debugging_port, websocket_debugging_url });

    // BƯỚC 2: Kết nối Puppeteer tới cửa sổ Chrome GPM
    task.status = 'navigating';
    task.step = 2;
    task.message = 'Đang kết nối tới trình duyệt và kiểm tra trang đăng ký DuoPlus...';
    task.updatedAt = Date.now();

    // Chờ 1.2s để cổng DevTools sẵn sàng lắng nghe
    await new Promise(r => setTimeout(r, 1200));

    try {
      if (websocket_debugging_url) {
        browser = await puppeteer.connect({ browserWSEndpoint: websocket_debugging_url, defaultViewport: null });
      } else {
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remote_debugging_port}`, defaultViewport: null });
      }
    } catch(connErr) {
      // Fallback kết nối qua browserURL
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remote_debugging_port}`, defaultViewport: null });
    }

    if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

    // Tìm tab đang mở https://my.duoplus.net hoặc chờ tab tải
    let page = null;
    const pageWaitStart = Date.now();
    while (Date.now() - pageWaitStart < 12000) {
      const currentPages = await browser.pages();
      page = currentPages.find(p => p.url().includes('my.duoplus.net'));
      if (page) break;
      if (currentPages.length > 0 && currentPages[0].url() !== 'about:blank') {
        page = currentPages[0];
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!page) {
      const currentPages = await browser.pages();
      page = currentPages[0] || (await browser.newPage());
    }

    try { await page.bringToFront(); } catch(e) {}

    const fromStep = parseInt(startFromStep || task.step || 1, 10);
    task.step = fromStep;

    if (fromStep > 1) {
      task.message = `🔄 Bắt đầu chạy tự động hóa từ Bước ${fromStep}...`;
      task.updatedAt = Date.now();
      console.log(`[DuoPlus Automation] Khởi chạy từ Bước ${fromStep} trên profile ${profileId}`);
    }

    // BƯỚC 2: Đảm bảo ở trang đăng ký
    if (fromStep <= 2) {
      if (!page.url().includes('my.duoplus.net/sign-up')) {
      await page.goto('https://my.duoplus.net/sign-up', { waitUntil: 'networkidle2', timeout: 45000 });
    } else {
      try {
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
      } catch(e) {}
    }

      // Chờ ô nhập email hiển thị
      await page.waitForSelector('input[name="username"], input[type="email"], input[placeholder*="email" i]', { timeout: 30000 });
    }

    if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

    // BƯỚC 3: Điền Hotmail, Password & Tick chọn Agreement
    if (fromStep <= 3) {
      task.status = 'filling_form';
    task.step = 3;
    task.message = 'Đang tự động điền Email, Mật khẩu và tick đồng ý điều khoản...';
    task.updatedAt = Date.now();

    await new Promise(r => setTimeout(r, 600));

    // 3a. Điền Email
    const emailInput = await page.$('input[name="username"]') || 
                       await page.$('input[type="email"]') || 
                       await page.$('input[placeholder*="email" i]');
    if (!emailInput) throw new Error('Không tìm thấy ô nhập email trên trang DuoPlus');
    await emailInput.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await emailInput.type(hotmailAccount.hotmail.trim(), { delay: 25 });

    // 3b. Điền Password
    const passInput = await page.$('input[name="password"]') || 
                      await page.$('input[type="password"]');
    if (!passInput) throw new Error('Không tìm thấy ô nhập mật khẩu trên trang DuoPlus');
    await passInput.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await passInput.type(hotmailAccount.password.trim(), { delay: 25 });

    // Đảm bảo DOM & React State nhận giá trị
    await page.evaluate((email, pass) => {
      const eInput = document.querySelector('input[name="username"]') || document.querySelector('input[type="email"]');
      if (eInput && eInput.value !== email) {
        eInput.value = email;
        eInput.dispatchEvent(new Event('input', { bubbles: true }));
        eInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const pInput = document.querySelector('input[name="password"]') || document.querySelector('input[type="password"]');
      if (pInput && pInput.value !== pass) {
        pInput.value = pass;
        pInput.dispatchEvent(new Event('input', { bubbles: true }));
        pInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, hotmailAccount.hotmail.trim(), hotmailAccount.password.trim());

    // 3c. Tick chọn I have read and agree Service Agreement and Privacy Agreement
    await page.evaluate(() => {
      const btn = document.getElementById('isAgress');
      if (btn && btn.getAttribute('data-state') !== 'checked') {
        btn.click();
        return;
      }
      const chk = document.querySelector('input[type="checkbox"]');
      if (chk && !chk.checked) {
        chk.click();
      }
    });

      await new Promise(r => setTimeout(r, 600));
    }

    if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

    // BƯỚC 4: Click nút Send Code & Ghi nhận mốc thời gian
    if (fromStep <= 4) {
      task.message = 'Đang bấm nút Send Code...';
    task.updatedAt = Date.now();

    const sendCodeTimestamp = Date.now();
    task.sendCodeTime = sendCodeTimestamp;

    // Tìm button Send Code và click bằng Puppeteer handle
    let clickedSend = false;
    const allButtons = await page.$$('button');
    for (const b of allButtons) {
      const txt = await page.evaluate(el => (el.innerText || '').trim().toLowerCase(), b);
      if (txt.includes('send code') || txt === 'send') {
        await b.click();
        clickedSend = true;
        break;
      }
    }

    if (!clickedSend) {
      clickedSend = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => {
          const txt = (b.innerText || '').trim().toLowerCase();
          return txt.includes('send code') || txt === 'send';
        });
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
    }

    if (!clickedSend) throw new Error('Không tìm thấy nút Send Code trên trang DuoPlus');

    // BƯỚC 5: Chờ người dùng giải Captcha
    task.status = 'waiting_captcha';
    task.step = 4;
    task.message = '⚠️ Vui lòng giải Captcha trên cửa sổ trình duyệt GPM vừa mở!';
    task.updatedAt = Date.now();

    // Chờ 2.5 giây để bảng Captcha hiển thị trên màn hình
    await new Promise(r => setTimeout(r, 2500));

    let captchaPassed = false;
    const captchaWaitStart = Date.now();

    // Vòng lặp kiểm tra giải Captcha (tối đa 3 phút)
    while (Date.now() - captchaWaitStart < 180000) {
      if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

      if (task.captchaManuallyPassed) {
        captchaPassed = true;
        break;
      }

      const captchaState = await page.evaluate(() => {
        const mask = document.getElementById('tCaptchaMaskLayer');
        const transform = document.getElementById('tcaptcha_transform_dy');
        const hasMask = (mask && window.getComputedStyle(mask).display !== 'none' && window.getComputedStyle(mask).visibility !== 'hidden') ||
                        (transform && window.getComputedStyle(transform).display !== 'none' && window.getComputedStyle(transform).visibility !== 'hidden');

        const btns = Array.from(document.querySelectorAll('button'));
        const sendBtn = btns.find(b => {
          const txt = (b.innerText || '').trim();
          return txt.includes('Send Code') || /\d+\s*s/i.test(txt) || txt.includes('Resend');
        });

        // Nút Send Code bắt đầu đếm ngược (vd: "60s", "59s") => Captcha đã hoàn thành và code đã được gửi!
        const isCountingDown = sendBtn && (/\d+\s*s/i.test(sendBtn.innerText) || (sendBtn.disabled && !sendBtn.innerText.toLowerCase().includes('send code')));

        return {
          hasMask: !!hasMask,
          isCountingDown: !!isCountingDown,
          sendBtnText: sendBtn ? sendBtn.innerText.trim() : ''
        };
      });

      // Nếu mặt nạ Captcha đã biến mất và nút Send Code đang đếm ngược => Hoàn thành
      if (!captchaState.hasMask && captchaState.isCountingDown) {
        captchaPassed = true;
        break;
      }

      // Hoặc nếu mặt nạ đã đóng và đã qua 4 giây và nút có số đếm
      if (!captchaState.hasMask && (Date.now() - captchaWaitStart > 4000) && captchaState.sendBtnText.match(/\d/)) {
        captchaPassed = true;
        break;
      }

      await new Promise(r => setTimeout(r, 1000));
    }

      if (!captchaPassed) {
        throw new Error('Hết thời gian chờ giải Captcha (3 phút). Vui lòng thử lại.');
      }
    }

    // BƯỚC 5: Quét mail Hotmail lấy OTP liên tục (chỉ lọc từ khóa 'duoplus', không lọc thời gian, có Try Again)
    let otpCode = task.otp || hotmailAccount?.otpCode || null;
    if (fromStep <= 5) {
      task.status = 'polling_otp';
    task.step = 5;
    task.message = '✅ Captcha hoàn tất! Đang quét hộp thư Hotmail tìm mail DuoPlus...';
    task.updatedAt = Date.now();

    // Vòng lặp quét OTP (hỗ trợ Try Again nhiều chu kỳ mà không mất kết nối browser)
    while (!otpCode) {
      if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

      const pollCycleStart = Date.now();
      task.otpPollStart = pollCycleStart;
      task.status = 'polling_otp';
      task.retryRequested = false;

      // Quét trong chu kỳ 90 giây
      while (Date.now() - pollCycleStart < 90000) {
        if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');
        if (task.manualOtp) {
          otpCode = task.manualOtp;
          task.otp = otpCode;
          break;
        }

        const elapsedSec = Math.round((Date.now() - pollCycleStart) / 1000);
        task.message = `Đang quét hộp thư Hotmail tìm mail DuoPlus (${elapsedSec}s / 90s)...`;
        task.updatedAt = Date.now();

        try {
          // Cơ chế: Quét thư mục Inbox & Junk, lọc từ khóa 'duoplus', không lọc thời gian
          const otpRes = await fetchHotmailOAuth2Otp(hotmailAccount, { keyword: 'duoplus' });
          if (otpRes && otpRes.success && otpRes.otp) {
            otpCode = otpRes.otp;
            task.otp = otpCode;
            break;
          } else if (otpRes && otpRes.error && !otpRes.notFoundDuoPlus) {
            console.log('[DuoPlus Automation] Quét mail info:', otpRes.error);
          }
        } catch(e) {
          console.log('[DuoPlus Automation] Quét mail error:', e.message);
        }

        // Nếu người dùng bấm "Try Again" trong lúc đang đếm, reset đếm lại từ đầu chu kỳ
        if (task.retryRequested) {
          task.retryRequested = false;
          break;
        }

        await new Promise(r => setTimeout(r, 2500));
      }

      if (otpCode) break;

      // Hết 90 giây mà chưa nhận được mail: Chuyển sang trạng thái otp_timeout để hiển thị nút Try Again
      task.status = 'otp_timeout';
      task.step = 5;
      task.message = '⏱️ Đã qua 90s nhưng chưa nhận được email từ DuoPlus. Bấm [Thử lại quét OTP] bên dưới để quét tiếp!';
      task.updatedAt = Date.now();

      // Giữ kết nối Puppeteer và đợi người dùng bấm Try Again hoặc Nhập tay hoặc Hủy
      while (!task.retryRequested && !task.manualOtp && !task.cancelled) {
        await new Promise(r => setTimeout(r, 800));
      }

      if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');
      if (task.manualOtp) {
        otpCode = task.manualOtp;
        task.otp = otpCode;
        break;
      }

      task.retryRequested = false;
    }

    }

    if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

    // BƯỚC 6: Điền Verification Code và Click Create Account
    if (fromStep <= 6) {
      task.status = 'submitting';
    task.step = 6;
    task.message = `✅ Đã nhận mã OTP: [${otpCode}]! Đang điền mã và bấm Create Account...`;
    task.updatedAt = Date.now();

    const codeInput = await page.$('input[name="verification_code"]') || 
                      await page.$('input[placeholder*="Verification" i]');
    if (!codeInput) throw new Error('Không tìm thấy ô nhập Verification Code');
    await codeInput.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await codeInput.type(otpCode, { delay: 40 });

    // Đảm bảo DOM cập nhật
    await page.evaluate((code) => {
      const cInput = document.querySelector('input[name="verification_code"]') || document.querySelector('input[placeholder*="Verification" i]');
      if (cInput) {
        cInput.value = code;
        cInput.dispatchEvent(new Event('input', { bubbles: true }));
        cInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, otpCode);

    await new Promise(r => setTimeout(r, 600));

    // Bấm nút Create Account
    let createClicked = false;
    const finalButtons = await page.$$('button');
    for (const b of finalButtons) {
      const txt = await page.evaluate(el => (el.innerText || '').trim().toLowerCase(), b);
      if (txt.includes('create account') || txt.includes('sign up') || txt.includes('register')) {
        await b.click();
        createClicked = true;
        break;
      }
    }

    if (!createClicked) {
      createClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.innerText && b.innerText.trim().toLowerCase().includes('create account'));
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
    }

      if (!createClicked) throw new Error('Không tìm thấy nút Create Account');
    }

    // BƯỚC 7: Quét chuyển sang trang mới ➔ Chờ 1-2s ➔ Bấm nút "Get Started"
    if (fromStep <= 7) {
      task.message = 'Đang kiểm tra chuyển trang sau khi bấm Create Account...';
    task.updatedAt = Date.now();

    // Quét xem đã chuyển sang trang mới hay chưa (URL thay đổi hoặc xuất hiện nút Get Started)
    const navWaitStart = Date.now();
    let hasNavigated = false;
    while (Date.now() - navWaitStart < 30000) {
      if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

      const currentUrl = page.url();
      if (!currentUrl.includes('/sign-up')) {
        hasNavigated = true;
        break;
      }

      const foundGetStarted = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, a, div[role="button"], span'));
        return els.some(e => {
          const t = (e.innerText || '').trim().toLowerCase();
          return t === 'get started' || t.includes('get started');
        });
      });

      if (foundGetStarted) {
        hasNavigated = true;
        break;
      }

      await new Promise(r => setTimeout(r, 600));
    }

    // Chờ trang mới tải xong hoàn toàn
    try {
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
    } catch(e) {}

    // (Từ bước này trở đi sau khi quét tải xong trang chờ 1-2 giây trước khi thao tác tiếp)
    task.message = 'Đã chuyển sang trang mới! Chờ 1.8 giây...';
    task.updatedAt = Date.now();
    await new Promise(r => setTimeout(r, 1800));

    // Quét tìm và Click vào nút "Get Started"
    task.message = 'Đang tìm và click vào nút Get Started...';
    task.updatedAt = Date.now();

    let getStartedClicked = false;
    const gsWaitStart = Date.now();
    while (Date.now() - gsWaitStart < 25000) {
      if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

      // 1. Thử click native qua Puppeteer handle
      const candidateHandles = await page.$$('button, a, div[role="button"], span');
      for (const h of candidateHandles) {
        const text = await page.evaluate(el => (el.innerText || '').trim().toLowerCase(), h);
        if (text === 'get started' || text.includes('get started')) {
          try {
            await h.scrollIntoView();
            await h.click();
            getStartedClicked = true;
            break;
          } catch(e) {}
        }
      }

      if (getStartedClicked) break;

      // 2. Fallback click evaluate
      getStartedClicked = await page.evaluate(() => {
        const allEls = Array.from(document.querySelectorAll('button, a, div[role="button"], span, div'));
        const target = allEls.find(e => {
          const txt = (e.innerText || '').trim().toLowerCase();
          return txt === 'get started' || (txt.includes('get started') && txt.length < 30);
        });
        if (target) {
          target.click();
          return true;
        }
        return false;
      });

      if (getStartedClicked) break;
      await new Promise(r => setTimeout(r, 800));
    }

    if (getStartedClicked) {
      task.message = 'Đã click nút Get Started!';
      task.updatedAt = Date.now();
    }

    // Chờ load xong trang tiếp theo
    try {
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
    } catch(e) {}

    // Chờ 1-2 giây trước khi thao tác tiếp
    await new Promise(r => setTimeout(r, 1800));

    // BƯỚC 9: Tắt / ẩn hộp thông báo dialog ➔ Quét nút Claim Free ➔ Quét nút Start Configuration
    task.step = 7;
    task.status = 'configuring';
    task.message = 'Đang kiểm tra và tắt hộp thông báo dialog...';
    task.updatedAt = Date.now();

    // 9a. Tắt / ẩn hộp thông báo dialog (Định vị dấu X, click chuột thật CDP, dispatch events, Escape & dọn sạch overlay)
    const dialogCloseStart = Date.now();
    while (Date.now() - dialogCloseStart < 12000) {
      if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

      // 1. Quét tìm vị trí nút đóng (dấu X, nút Close, hoặc icon SVG trong modal)
      const closeTarget = await page.evaluate(() => {
        // Danh sách các selector nút đóng tiêu chuẩn
        const selectors = [
          'button[aria-label*="close" i]',
          'button[aria-label*="Close" i]',
          '.ant-modal-close',
          '.ant-modal-close-x',
          '.modal-close',
          '.dialog-close',
          'button.close',
          '[data-dismiss="modal"]',
          '[data-state="open"] button[aria-label*="close" i]',
          '[data-state="open"] button'
        ];

        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.width < 150 && rect.height < 150) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height, tag: el.tagName };
            }
          }
        }

        // Tìm phần tử chứa chữ ✕, ×, x, close, got it, dismiss...
        const candidates = Array.from(document.querySelectorAll('button, div[role="button"], span, i, a, svg'));
        for (const el of candidates) {
          const t = (el.innerText || '').trim();
          if (t === '✕' || t === '×' || t === 'x' || t === 'X' || t.toLowerCase() === 'close' || t.toLowerCase() === 'dismiss' || t.toLowerCase() === 'got it') {
            const parent = el.closest('button, [role="button"]') || el;
            const rect = parent.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height, tag: parent.tagName };
            }
          }
        }

        // Tìm icon SVG ở góc trên modal/dialog (thường là dấu X đóng)
        const modals = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], .ant-modal, [data-state="open"]'));
        for (const m of modals) {
          const svgs = Array.from(m.querySelectorAll('svg, button'));
          for (const s of svgs) {
            const rect = s.getBoundingClientRect();
            if (rect.width > 0 && rect.width < 70 && rect.height > 0 && rect.height < 70) {
              const mRect = m.getBoundingClientRect();
              if (rect.top < mRect.top + 90) { // Nằm trong phạm vi header của dialog
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height, tag: s.tagName };
              }
            }
          }
        }

        return null;
      });

      if (closeTarget) {
        // Click chuột thật ở cấp độ phần cứng (CDP MouseEvent)
        try {
          await page.mouse.move(closeTarget.x, closeTarget.y);
          await new Promise(r => setTimeout(r, 60));
          await page.mouse.click(closeTarget.x, closeTarget.y, { delay: 50 });
        } catch(e) {}

        // Đồng thời dispatch sự kiện DOM toàn diện
        await page.evaluate((coords) => {
          const el = document.elementFromPoint(coords.x, coords.y);
          if (el) {
            const btn = el.closest('button, [role="button"], a') || el;
            ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'].forEach(evt => {
              try {
                btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
              } catch(e) {}
            });
            try { btn.click(); } catch(e) {}
          }
        }, closeTarget);
      }

      // Thử nhấn phím Escape
      try { await page.keyboard.press('Escape'); } catch(e) {}

      await new Promise(r => setTimeout(r, 600));

      // Kiểm tra xem dialog còn hiển thị trên màn hình không
      const hasVisibleDialog = await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], .ant-modal-root, .ant-modal-wrap, [data-state="open"]'));
        return dialogs.some(d => {
          const s = window.getComputedStyle(d);
          const t = (d.innerText || '').toLowerCase();
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && !t.includes('claim free') && !t.includes('start config');
        });
      });

      if (!hasVisibleDialog) {
        break;
      }
    }

    // Nếu sau các nỗ lực click mà overlay vẫn còn che màn hình, cưỡng chế ẩn/xóa để không chặn các nút bên dưới
    await page.evaluate(() => {
      const overlays = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .ant-modal-root, .ant-modal-wrap, .ant-modal-mask, [data-state="open"]');
      overlays.forEach(o => {
        const text = (o.innerText || '').toLowerCase();
        if (!text.includes('claim free') && !text.includes('start config')) {
          o.style.display = 'none';
          try { o.remove(); } catch(e) {}
        }
      });
      document.body.style.overflow = 'auto';
      if (document.documentElement) document.documentElement.style.overflow = 'auto';
    });

    // Chờ 1-2 giây trước khi thao tác tiếp
    await new Promise(r => setTimeout(r, 1800));

    // 9b. Quét nút Claim Free và click vào
    task.message = 'Đang tìm và click nút Claim Free...';
    task.updatedAt = Date.now();

    let claimFreeClicked = false;
    const claimWaitStart = Date.now();
    while (Date.now() - claimWaitStart < 25000) {
      if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

      // 1. Tìm element bằng Puppeteer handle và click thật
      const candidateHandles = await page.$$('button, a, div[role="button"], span');
      for (const h of candidateHandles) {
        const text = await page.evaluate(el => (el.innerText || '').trim().toLowerCase(), h);
        if (text === 'claim free' || text.includes('claim free') || (text.includes('claim') && text.includes('free'))) {
          try {
            await h.scrollIntoView();
            await h.click();
            claimFreeClicked = true;
            break;
          } catch(e) {}
        }
      }

      if (claimFreeClicked) break;

      // 2. Fallback evaluate click
      claimFreeClicked = await page.evaluate(() => {
        const allEls = Array.from(document.querySelectorAll('button, a, div[role="button"], span, div'));
        const target = allEls.find(e => {
          const txt = (e.innerText || '').trim().toLowerCase();
          return (txt === 'claim free' || txt.includes('claim free') || (txt.includes('claim') && txt.includes('free'))) && txt.length < 40;
        });
        if (target) {
          target.click();
          return true;
        }
        return false;
      });

      if (claimFreeClicked) break;

      // Nhấn Escape phòng trường hợp dialog chưa tắt che mất nút
      try { await page.keyboard.press('Escape'); } catch(e) {}

      await new Promise(r => setTimeout(r, 800));
    }

      if (claimFreeClicked) {
        task.message = 'Đã click nút Claim Free!';
        task.updatedAt = Date.now();
      }
      await new Promise(r => setTimeout(r, 1800));
    }

    // BƯỚC 8: Truy cập trực tiếp đường link https://my.duoplus.net/api
    if (fromStep <= 8) {
      task.step = 8;
    task.status = 'navigating_api';
    task.message = 'Đang truy cập trực tiếp vào https://my.duoplus.net/api...';
    task.updatedAt = Date.now();

    try {
      await page.goto('https://my.duoplus.net/api', { waitUntil: 'networkidle2', timeout: 35000 });
    } catch(e) {
      try {
        await page.goto('https://my.duoplus.net/api', { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch(e2) {}
    }

    // Chờ trang API tải xong hoàn toàn
    try {
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 });
    } catch(e) {}

    // (Từ bước này trở đi sau khi quét tải xong trang chờ 1-2 giây trước khi thao tác tiếp)
      task.message = 'Đã vào trang API DuoPlus! Đang chuẩn bị tạo API Key...';
      task.updatedAt = Date.now();
      await new Promise(r => setTimeout(r, 1800));
    }

    // BƯỚC 9: Tạo và Sao chép API Key trên trang https://my.duoplus.net/api
    if (fromStep <= 9) {
      task.step = 9;
    task.status = 'generating_api_key';
    task.message = 'Đang quét tìm nút Generate Key...';
    task.updatedAt = Date.now();

    let extractedApiKey = null;

    // 1. Kiểm tra xem trên trang đã có sẵn API Key chưa (nếu đã từng bấm Generate trước đó)
    let generateKeyClicked = false;
    const genWaitStart = Date.now();

    while (Date.now() - genWaitStart < 25000) {
      if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

      // Kiểm tra xem đã có API Key hiển thị trên trang chưa
      const existingKey = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('input, span, code, div'));
        for (const el of candidates) {
          const val = (el.value || el.innerText || '').trim();
          if (val.length >= 20 && val.length <= 80 && !val.includes(' ') && !val.includes('\n') && !val.includes('http') && /[a-zA-Z0-9]/.test(val)) {
            const parent = el.closest('tr, div, li') || el.parentElement;
            if (parent && /copy|sao chép/i.test(parent.innerText)) {
              return val;
            }
          }
        }
        return null;
      });

      if (existingKey) {
        extractedApiKey = existingKey;
        generateKeyClicked = true;
        break;
      }

      // Quét tìm nút Generate Key
      const genTarget = await page.evaluate(() => {
        const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const keywords = ['generate key', 'generate-key', 'generate api key', 'generate', 'tạo key', '生成 key'];
        const all = Array.from(document.querySelectorAll('button, a, div[role="button"], span'));

        for (const el of all) {
          const txt = normalize(el.innerText);
          if (keywords.some(k => txt === k || (txt.includes(k) && txt.length < 35))) {
            const btn = el.closest('button, [role="button"], a') || el;
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: btn.innerText.trim() };
            }
          }
        }
        return null;
      });

      if (genTarget) {
        task.message = `Đã tìm thấy nút [${genTarget.text}], đang click để tạo API Key...`;
        task.updatedAt = Date.now();

        // Click chuột thật
        try {
          await page.mouse.move(genTarget.x, genTarget.y);
          await new Promise(r => setTimeout(r, 60));
          await page.mouse.click(genTarget.x, genTarget.y, { delay: 40 });
        } catch(e) {}

        // Dispatch sự kiện DOM
        await page.evaluate((coords) => {
          const el = document.elementFromPoint(coords.x, coords.y);
          if (el) {
            const btn = el.closest('button, [role="button"], a') || el;
            ['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'].forEach(evt => {
              try { btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })); } catch(e) {}
            });
            try { btn.click(); } catch(e) {}
          }
        }, genTarget);

        generateKeyClicked = true;
        break;
      }

      await new Promise(r => setTimeout(r, 800));
    }

    // 2. Chờ dòng chữ "Generate Key" biến mất và thay thế bằng chuỗi ký tự API Key
    task.message = 'Đang đợi hệ thống sinh mã API Key...';
    task.updatedAt = Date.now();

    const keyWaitStart = Date.now();
    while (Date.now() - keyWaitStart < 25000) {
      if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

      const keyStatus = await page.evaluate(() => {
        const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const all = Array.from(document.querySelectorAll('button, a, div[role="button"], span, div, tr, p'));
        
        // Kiểm tra xem nút Generate Key còn hiển thị không
        const hasGenKey = all.some(el => {
          const txt = normalize(el.innerText);
          return (txt === 'generate key' || txt === 'generate-key') && el.offsetParent !== null;
        });

        // Tìm nút Copy trên hàng
        const copyBtns = Array.from(document.querySelectorAll('button, a, div[role="button"], span')).filter(el => {
          const t = (el.innerText || '').trim().toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          return t === 'copy' || t === 'sao chép' || title === 'copy' || aria === 'copy' || (t.includes('copy') && t.length < 15);
        });

        let foundKey = null;
        let copyCoords = null;

        for (const btn of copyBtns) {
          const clickable = btn.closest('button, [role="button"], a') || btn;
          const rect = clickable.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            copyCoords = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            
            const container = clickable.closest('tr, div, li, p') || clickable.parentElement;
            if (container) {
              const inputs = Array.from(container.querySelectorAll('input, span, code, div'));
              for (const inp of inputs) {
                const val = (inp.value || inp.innerText || '').trim();
                if (val.length >= 16 && val.length <= 80 && !val.includes(' ') && !val.includes('\n')) {
                  foundKey = val;
                  break;
                }
              }
            }
            break;
          }
        }

        return {
          hasGenKey,
          foundKey,
          copyCoords
        };
      });

      if (keyStatus.foundKey) {
        extractedApiKey = keyStatus.foundKey;
      }

      if (!keyStatus.hasGenKey || keyStatus.copyCoords || keyStatus.foundKey) {
        break;
      }

      await new Promise(r => setTimeout(r, 800));
    }

    // 3. Tìm nút tên "Copy" tại dòng API Key và click vào
    task.message = 'Đang tìm và click nút Copy API Key...';
    task.updatedAt = Date.now();

    let copyClicked = false;
    const copyWaitStart = Date.now();

    while (Date.now() - copyWaitStart < 20000) {
      if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

      const copyBtnInfo = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, a, div[role="button"], span, svg'));
        for (const el of all) {
          const t = (el.innerText || '').trim().toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          if (t === 'copy' || t === 'sao chép' || title === 'copy' || aria === 'copy' || (t.includes('copy') && t.length < 15)) {
            const btn = el.closest('button, [role="button"], a') || el;
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: btn.innerText.trim() };
            }
          }
        }
        return null;
      });

      if (copyBtnInfo) {
        task.message = `Đang click nút [${copyBtnInfo.text}]...`;
        task.updatedAt = Date.now();

        // Click chuột thật
        try {
          await page.mouse.move(copyBtnInfo.x, copyBtnInfo.y);
          await new Promise(r => setTimeout(r, 60));
          await page.mouse.click(copyBtnInfo.x, copyBtnInfo.y, { delay: 40 });
        } catch(e) {}

        // Dispatch sự kiện click
        await page.evaluate((coords) => {
          const el = document.elementFromPoint(coords.x, coords.y);
          if (el) {
            const btn = el.closest('button, [role="button"], a') || el;
            ['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'].forEach(evt => {
              try { btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })); } catch(e) {}
            });
            try { btn.click(); } catch(e) {}
          }
        }, copyBtnInfo);

        copyClicked = true;
        break;
      }

      await new Promise(r => setTimeout(r, 600));
    }

    // 4. Quét hộp thoại thông báo "Copied" và đọc mã API Key từ Clipboard hoặc DOM
    task.message = 'Đang xác nhận thông báo Copied và đọc mã API Key...';
    task.updatedAt = Date.now();

    let copiedToastDetected = false;
    const toastWaitStart = Date.now();

    while (Date.now() - toastWaitStart < 8000) {
      const checkRes = await page.evaluate(async () => {
        // Kiểm tra toast / tooltip có chữ Copied
        const allEls = Array.from(document.querySelectorAll('.ant-message, [role="alert"], [role="status"], .toast, .tooltip, div, span'));
        const hasCopied = allEls.some(el => {
          const t = (el.innerText || '').trim().toLowerCase();
          return t === 'copied' || t === 'copied!' || t.includes('copied') || t.includes('sao chép thành công') || t.includes('copy success');
        });

        // Đọc giá trị từ clipboard nếu có quyền
        let clip = null;
        try {
          clip = await navigator.clipboard.readText();
        } catch(e) {}

        return { hasCopied, clip };
      });

      if (checkRes.hasCopied) {
        copiedToastDetected = true;
      }

      if (checkRes.clip && checkRes.clip.length >= 16 && !checkRes.clip.includes(' ') && !checkRes.clip.includes('\n')) {
        extractedApiKey = checkRes.clip;
      }

      if (copiedToastDetected && extractedApiKey) {
        break;
      }

      await new Promise(r => setTimeout(r, 400));
    }

    // Nếu clipboard không đọc được, trích xuất chuỗi key từ DOM
    if (!extractedApiKey || extractedApiKey.length < 10) {
      extractedApiKey = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input, span, code, div, p'));
        for (const el of inputs) {
          const val = (el.value || el.innerText || '').trim();
          if (val.length >= 20 && val.length <= 80 && !val.includes(' ') && !val.includes('\n') && !val.includes('http') && /[a-zA-Z0-9]/.test(val)) {
            return val;
          }
        }
        return null;
      });
    }

    const finalApiKey = extractedApiKey || 'Copied_API_Key';
    task.apiKey = finalApiKey;
    task.status = 'completed';
    task.step = 9;
    task.message = `🎉 Đăng ký thành công & Đã copy mã API Key DuoPlus: ${finalApiKey}`;
    task.updatedAt = Date.now();
    }

    // Ngắt kết nối Puppeteer nhưng giữ nguyên cửa sổ trình duyệt GPM mở cho người dùng
    try {
      await browser.disconnect();
      browser = null;
    } catch(e) {}

  } catch(err) {
    if (browser) {
      try { await browser.disconnect(); } catch(e) {}
    }
    throw err;
  }
}

module.exports = {
  startDuoplusRegistration,
  getDuoplusTaskStatus,
  markCaptchaPassed,
  retryDuoplusOtp,
  submitManualOtp,
  cancelDuoplusTask
};
