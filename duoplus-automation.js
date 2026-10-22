// duoplus-automation.js
// Tự động hóa đăng ký tài khoản DuoPlus trên GPMLogin:
// 1. Mở profile GPMLogin & kết nối Puppeteer
// 2. Chờ trang https://my.duoplus.net/sign-up tải xong
// 3. Điền email, password, tick đồng ý điều khoản
// 4. Bấm Send Code
// 5. Chờ người dùng giải Captcha (tự động phát hiện khi giải xong hoặc bấm bỏ qua)
// 6. Quét hộp thư Hotmail lấy OTP mới (chỉ lọc từ khóa 'duoplus', không lọc thời gian, hỗ trợ Try Again khi quá giờ)
// 7. Điền Verification Code & bấm Create Account

const puppeteer = require('puppeteer');
const { fetchHotmailOAuth2Otp } = require('./hotmail-otp-helper');

const activeTasks = new Map();

/**
 * Khởi tạo tác vụ tự động đăng ký DuoPlus
 */
function startDuoplusRegistration({ profileId, gpmPort = 9495, hotmailAccount, tiktokAccount }) {
  const taskId = 'duo_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  
  const task = {
    id: taskId,
    profileId,
    hotmail: hotmailAccount.hotmail,
    tiktokUsername: tiktokAccount?.username || '',
    status: 'starting', // starting | navigating | filling_form | waiting_captcha | polling_otp | otp_timeout | submitting | completed | error
    step: 1,
    message: 'Đang khởi động trình duyệt GPMLogin...',
    otp: null,
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
  runRegistrationFlow(task, { profileId, gpmPort, hotmailAccount, tiktokAccount }).catch(err => {
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
async function runRegistrationFlow(task, { profileId, gpmPort, hotmailAccount, tiktokAccount }) {
  let browser = null;

  try {
    if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

    // BƯỚC 1: Khởi động profile trên GPMLogin
    task.status = 'starting';
    task.step = 1;
    task.message = 'Đang mở profile GPMLogin trên màn hình máy tính...';
    task.updatedAt = Date.now();

    const startRes = await fetch(`http://127.0.0.1:${gpmPort}/api/v1/profiles/start/${profileId}`, {
      signal: AbortSignal.timeout(15000)
    });
    const startData = await startRes.json();
    if (!startData.success && !startData.data?.remote_debugging_port) {
      throw new Error('GPMLogin không thể mở profile: ' + (startData.message || 'Thiếu cổng debugging'));
    }

    const remote_debugging_port = startData.data?.remote_debugging_port;
    const websocket_debugging_url = startData.data?.websocket_debugging_url;

    if (!remote_debugging_port && !websocket_debugging_url) {
      throw new Error('GPMLogin không trả về cổng điều khiển DevTools');
    }

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

    // Đảm bảo ở trang đăng ký
    if (!page.url().includes('my.duoplus.net/sign-up')) {
      await page.goto('https://my.duoplus.net/sign-up', { waitUntil: 'networkidle2', timeout: 45000 });
    } else {
      try {
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
      } catch(e) {}
    }

    // Chờ ô nhập email hiển thị
    await page.waitForSelector('input[name="username"], input[type="email"], input[placeholder*="email" i]', { timeout: 30000 });

    if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

    // BƯỚC 3: Điền Hotmail, Password & Tick chọn Agreement
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

    if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

    // BƯỚC 4: Click nút Send Code & Ghi nhận mốc thời gian
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

    // BƯỚC 6: Quét mail Hotmail lấy OTP liên tục (chỉ lọc từ khóa 'duoplus', không lọc thời gian, có Try Again)
    task.status = 'polling_otp';
    task.step = 5;
    task.message = '✅ Captcha hoàn tất! Đang quét hộp thư tìm email DuoPlus chứa mã OTP...';
    task.updatedAt = Date.now();

    let otpCode = null;

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
          // Cơ chế mới: Quét thư mục Inbox & Junk, lọc từ khóa 'duoplus', không lọc thời gian
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

    if (task.cancelled) throw new Error('Người dùng đã hủy tác vụ');

    // BƯỚC 7: Điền Verification Code và Click Create Account
    task.status = 'submitting';
    task.step = 6;
    task.message = `✅ Đã nhận mã OTP: [${otpCode}]! Đang điền mã và tạo tài khoản...`;
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

    // Chờ kết quả tạo tài khoản
    await new Promise(r => setTimeout(r, 4000));

    task.status = 'completed';
    task.step = 7;
    task.message = `🎉 Đăng ký tài khoản DuoPlus thành công! Mã OTP: ${otpCode}`;
    task.updatedAt = Date.now();

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
