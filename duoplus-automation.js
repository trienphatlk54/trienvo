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
const { saveDuoPlusAuthCache } = require('./duoplus-chromium-helper');

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

    // BƯỚC 8: Truy cập trực tiếp đường link https://my.duoplus.net/api (tải 1 lần + thêm 3 lần nữa = tổng 4 lần)
    if (fromStep <= 8) {
      task.step = 8;
      task.status = 'navigating_api';
      task.updatedAt = Date.now();

      const totalNavigations = 4;
      for (let navCount = 1; navCount <= totalNavigations; navCount++) {
        if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

        if (navCount === 1) {
          task.message = `Đang truy cập https://my.duoplus.net/api (lần 1/${totalNavigations})...`;
        } else {
          task.message = `Đang tải lại https://my.duoplus.net/api (lần ${navCount}/${totalNavigations} - thêm ${navCount - 1}/3 lần)...`;
        }
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

        // Chờ 2 giây sau mỗi lần tải trang
        await new Promise(r => setTimeout(r, 2000));
      }

      task.message = '✅ Đã tải xong trang API 4 lần! Đang chuẩn bị quét API Key...';
      task.updatedAt = Date.now();
      await new Promise(r => setTimeout(r, 1500));
    }

    // BƯỚC 9: Tạo và Sao chép API Key trên trang https://my.duoplus.net/api
    if (fromStep <= 9) {
      task.step = 9;
      task.status = 'generating_api_key';
      task.message = 'Đang kiểm tra và trích xuất API Key DuoPlus...';
      task.updatedAt = Date.now();

      // Cấp quyền clipboard cho trang web
      try {
        const context = page.browserContext();
        await context.overridePermissions('https://my.duoplus.net', ['clipboard-read', 'clipboard-write']);
      } catch(e) {}

      // Hàm kiểm tra định dạng API Key hợp lệ
      function isValidDuoApiKey(str, maskedPrefix, maskedSuffix) {
        if (!str || typeof str !== 'string') return false;
        const s = str.trim();
        if (s.startsWith('/') || s.startsWith('\\') || s.includes('.txt') || s.includes('.png') || s.includes('http') || s.includes(' ') || s.includes('\n')) {
          return false;
        }
        if (s.length < 20 || s.length > 80) return false;
        if (maskedPrefix && !s.toLowerCase().startsWith(maskedPrefix.toLowerCase())) return false;
        if (maskedSuffix && !s.toLowerCase().endsWith(maskedSuffix.toLowerCase())) return false;
        
        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
        const isAlphanumeric = /^[0-9a-zA-Z_-]{20,80}$/.test(s);
        return isUuid || isAlphanumeric;
      }

      // Đặt hook lắng nghe navigator.clipboard.writeText ngay trên trang
      await page.evaluate(() => {
        window.__capturedDuoApiKey = null;
        if (navigator.clipboard) {
          const origWrite = navigator.clipboard.writeText;
          navigator.clipboard.writeText = function(text) {
            window.__capturedDuoApiKey = text;
            return origWrite ? origWrite.apply(this, arguments) : Promise.resolve();
          };
        }
        document.addEventListener('copy', (e) => {
          try {
            const t = window.getSelection().toString() || (e.clipboardData && e.clipboardData.getData('text'));
            if (t) window.__capturedDuoApiKey = t;
          } catch(err) {}
        });
      });

      // 1. Kiểm tra xem đã có API Key (dạng masked ddcc****8251) hiển thị trên trang chưa
      let maskedKeyInfo = await page.evaluate(() => {
        const allSpans = Array.from(document.querySelectorAll('span, div, p, td'));
        const span = allSpans.find(s => {
          const t = (s.innerText || '').trim();
          return /\b[a-zA-Z0-9]{2,8}\*{2,8}[a-zA-Z0-9]{2,8}\b/.test(t) && t.length <= 30;
        });
        if (span) {
          const m = span.innerText.trim().match(/([a-zA-Z0-9]{2,8})\*+([a-zA-Z0-9]{2,8})/);
          return {
            maskedText: span.innerText.trim(),
            prefix: m ? m[1] : '',
            suffix: m ? m[2] : ''
          };
        }
        return null;
      });

      // Nếu chưa có masked key, quét tìm nút "Generate Key" và click
      if (!maskedKeyInfo) {
        task.message = 'Đang tìm nút Generate Key...';
        task.updatedAt = Date.now();

        const genWaitStart = Date.now();
        while (Date.now() - genWaitStart < 25000) {
          if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

          // Kiểm tra lại xem masked key đã xuất hiện chưa
          maskedKeyInfo = await page.evaluate(() => {
            const allSpans = Array.from(document.querySelectorAll('span, div, p, td'));
            const span = allSpans.find(s => {
              const t = (s.innerText || '').trim();
              return /\b[a-zA-Z0-9]{2,8}\*{2,8}[a-zA-Z0-9]{2,8}\b/.test(t) && t.length <= 30;
            });
            if (span) {
              const m = span.innerText.trim().match(/([a-zA-Z0-9]{2,8})\*+([a-zA-Z0-9]{2,8})/);
              return {
                maskedText: span.innerText.trim(),
                prefix: m ? m[1] : '',
                suffix: m ? m[2] : ''
              };
            }
            return null;
          });
          if (maskedKeyInfo) break;

          const genClicked = await page.evaluate(() => {
            const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const keywords = ['generate key', 'generate-key', 'generate api key', 'generate', 'tạo key'];
            const all = Array.from(document.querySelectorAll('button, a, div[role="button"], span'));
            for (const el of all) {
              const txt = normalize(el.innerText);
              if (keywords.some(k => txt === k || (txt.includes(k) && txt.length < 35))) {
                const btn = el.closest('button, [role="button"], a') || el;
                btn.click();
                return true;
              }
            }
            return false;
          });

          if (genClicked) {
            task.message = 'Đã click nút Generate Key, đang chờ hệ thống sinh mã...';
            task.updatedAt = Date.now();
            await new Promise(r => setTimeout(r, 2000));
            break;
          }

          await new Promise(r => setTimeout(r, 800));
        }
      }

      // 2. Chờ dòng chứa API Key (ddcc****8251 + nút Copy) hiển thị
      task.message = 'Đang định vị nút Copy tại dòng API Key...';
      task.updatedAt = Date.now();

      const findKeyStart = Date.now();
      while (Date.now() - findKeyStart < 25000) {
        if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

        maskedKeyInfo = await page.evaluate(() => {
          const allSpans = Array.from(document.querySelectorAll('span, div, p, td'));
          const span = allSpans.find(s => {
            const t = (s.innerText || '').trim();
            return /\b[a-zA-Z0-9]{2,8}\*{2,8}[a-zA-Z0-9]{2,8}\b/.test(t) && t.length <= 30;
          });
          if (span) {
            const m = span.innerText.trim().match(/([a-zA-Z0-9]{2,8})\*+([a-zA-Z0-9]{2,8})/);
            return {
              maskedText: span.innerText.trim(),
              prefix: m ? m[1] : '',
              suffix: m ? m[2] : ''
            };
          }
          return null;
        });

        if (maskedKeyInfo) break;
        await new Promise(r => setTimeout(r, 800));
      }

      const maskedPrefix = maskedKeyInfo?.prefix || '';
      const maskedSuffix = maskedKeyInfo?.suffix || '';
      if (maskedKeyInfo) {
        task.message = `Đã tìm thấy API Key dạng rút gọn [${maskedKeyInfo.maskedText}], đang click nút Copy kế bên...`;
        task.updatedAt = Date.now();
      }

      // 3. Click nút "Copy" ngay cạnh chuỗi API Key
      let extractedApiKey = null;
      const copyWaitStart = Date.now();

      while (Date.now() - copyWaitStart < 25000) {
        if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

        // Định vị chính xác phần tử Copy cạnh chuỗi masked key hoặc cạnh Regenerate
        const copyTarget = await page.evaluate(() => {
          const allSpans = Array.from(document.querySelectorAll('span, div, p, td'));
          const maskedSpan = allSpans.find(s => {
            const t = (s.innerText || '').trim();
            return /\b[a-zA-Z0-9]{2,8}\*{2,8}[a-zA-Z0-9]{2,8}\b/.test(t) && t.length <= 30;
          });

          let container = null;
          if (maskedSpan) {
            container = maskedSpan.closest('.flex') || maskedSpan.parentElement;
            let p = container;
            while (p && !p.innerText.includes('Regenerat') && p !== document.body) {
              p = p.parentElement;
            }
            if (p && p !== document.body) container = p;
          } else {
            const allContainers = Array.from(document.querySelectorAll('div, tr, section'));
            container = allContainers.find(c => {
              const t = (c.innerText || '');
              return t.includes('API Key') && (t.includes('Copy') || t.includes('Regenerat'));
            });
          }

          if (!container) return null;

          const candidates = Array.from(container.querySelectorAll('span, button, a, [role="button"]'));
          const copyEl = candidates.find(c => {
            const t = (c.innerText || '').trim().toLowerCase();
            return t === 'copy' || t === 'sao chép';
          });

          if (!copyEl) return null;

          const rect = copyEl.getBoundingClientRect();
          return {
            hasRect: rect.width > 0 && rect.height > 0,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2
          };
        });

        if (copyTarget) {
          // Click chuột thật theo tọa độ
          if (copyTarget.hasRect) {
            try {
              await page.mouse.move(copyTarget.x, copyTarget.y);
              await new Promise(r => setTimeout(r, 60));
              await page.mouse.click(copyTarget.x, copyTarget.y, { delay: 40 });
            } catch(e) {}
          }

          // Đồng thời dispatch sự kiện click DOM vào đúng phần tử Copy của dòng API Key
          await page.evaluate(() => {
            const allSpans = Array.from(document.querySelectorAll('span, button, a'));
            const copyEl = allSpans.find(s => {
              const t = (s.innerText || '').trim().toLowerCase();
              const parentText = s.parentElement ? (s.parentElement.innerText || '') : '';
              const grandParentText = s.parentElement && s.parentElement.parentElement ? (s.parentElement.parentElement.innerText || '') : '';
              return (t === 'copy' || t === 'sao chép') && 
                     (parentText.includes('****') || grandParentText.includes('****') || parentText.includes('Regenerat') || grandParentText.includes('Regenerat') || grandParentText.includes('API Key'));
            });
            if (copyEl) {
              ['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'].forEach(evt => {
                try { copyEl.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })); } catch(e) {}
              });
              try { copyEl.click(); } catch(e) {}
            }
          });
        }

        // Chờ 500ms để clipboard ghi nhận
        await new Promise(r => setTimeout(r, 500));

        // Đọc kết quả từ hook hoặc clipboard
        const checkRes = await page.evaluate(async () => {
          let candidate = window.__capturedDuoApiKey || null;
          let clip = null;
          try {
            clip = await navigator.clipboard.readText();
          } catch(e) {}

          const allEls = Array.from(document.querySelectorAll('.ant-message, [role="alert"], [role="status"], .toast, .tooltip, div, span'));
          const hasCopied = allEls.some(el => {
            const t = (el.innerText || '').trim().toLowerCase();
            return t === 'copied' || t === 'copied!' || t.includes('copied') || t.includes('sao chép thành công') || t.includes('copy success');
          });

          return { candidate, clip, hasCopied };
        });

        // Kiểm tra candidate từ hook
        if (checkRes.candidate && isValidDuoApiKey(checkRes.candidate, maskedPrefix, maskedSuffix)) {
          extractedApiKey = checkRes.candidate.trim();
          break;
        }

        // Kiểm tra candidate từ clipboard
        if (checkRes.clip && isValidDuoApiKey(checkRes.clip, maskedPrefix, maskedSuffix)) {
          extractedApiKey = checkRes.clip.trim();
          break;
        }

        await new Promise(r => setTimeout(r, 800));
      }

      if (!extractedApiKey || !isValidDuoApiKey(extractedApiKey, maskedPrefix, maskedSuffix)) {
        throw new Error(`Không thể copy được API Key hợp lệ (Giá trị thu được không đúng định dạng DuoPlus API Key). Vui lòng bấm [Try Again] để thử lại.`);
      }

      task.apiKey = extractedApiKey;
      task.status = 'completed';
      task.step = 9;
      task.message = `🎉 Đăng ký thành công & Đã copy chính xác mã API Key DuoPlus: ${extractedApiKey}`;
      task.updatedAt = Date.now();
      console.log(`[DuoPlus Automation] Hoàn thành trích xuất API Key: ${extractedApiKey}`);
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
