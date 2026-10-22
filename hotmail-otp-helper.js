// hotmail-otp-helper.js
// Đọc hộp thư Hotmail/Outlook qua Microsoft OAuth2 và Graph API để trích xuất mã OTP 6 số
// Cơ chế mới: Quét thư mục Inbox & JunkEmail, lọc email chứa từ khóa 'duoplus', không lọc thời gian

async function fetchHotmailOAuth2Otp(account, options = {}) {
  const { hotmail, password, authCookies = '', sessionId = '', restoreMail = '' } = account;

  // Xử lý tham số options / keyword (mặc định là 'duoplus' cho quy trình đăng ký DuoPlus)
  let keyword = 'duoplus';
  if (typeof options === 'string') {
    keyword = options.trim();
  } else if (options && typeof options === 'object') {
    if (options.keyword !== undefined) {
      keyword = String(options.keyword).trim();
    }
  }

  // 1. Extract Client ID (GUID)
  const guidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  let clientId = '';
  const matchGuid = (sessionId.match(guidRegex) || authCookies.match(guidRegex));
  if (matchGuid) {
    clientId = matchGuid[0];
  }

  // 2. Extract Refresh Token
  let refreshToken = '';
  if (authCookies.includes('refresh_token=')) {
    const m = authCookies.match(/refresh_token=([^&;\s]+)/);
    if (m) refreshToken = decodeURIComponent(m[1]);
  } else if (sessionId.includes('refresh_token=')) {
    const m = sessionId.match(/refresh_token=([^&;\s]+)/);
    if (m) refreshToken = decodeURIComponent(m[1]);
  } else {
    // Check candidate strings by length
    const candidates = [authCookies.trim(), sessionId.trim(), password.trim()].filter(s => s && s.length >= 30 && !guidRegex.test(s) && !s.includes('@'));
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.length - a.length);
      refreshToken = candidates[0];
    }
  }

  // 3. Fallback Client IDs phổ biến cho Outlook OAuth2
  const clientIdsToTry = [];
  if (clientId) clientIdsToTry.push(clientId);
  const fallbackClientIds = [
    'd3590ed6-52b3-4102-aeff-aad2292ab01c', // Office / Outlook Desktop
    '08aeb3b0-eeff-4e6c-ac0b-42994b9b2e86', // Outlook Mobile
    '9e5f94bc-e8a4-4e73-b8be-63364c29d753', // Outlook Windows
    'e80dab22-c3a5-4886-b484-90fb9b00868f', // Live SDK / Taphoammo
    '27922004-5251-4030-b22d-91ecd9a37ea4', // Outlook Web App
    '00000002-0000-0ff1-ce00-000000000000'  // Office 365 Exchange Online
  ];
  fallbackClientIds.forEach(id => {
    if (!clientIdsToTry.includes(id)) clientIdsToTry.push(id);
  });

  let accessToken = '';
  let newRefreshToken = '';
  let lastError = '';

  if (refreshToken) {
    for (const cId of clientIdsToTry) {
      const scopesToTry = [
        'https://graph.microsoft.com/.default offline_access',
        'https://graph.microsoft.com/Mail.Read offline_access',
        'offline_access'
      ];

      for (const scope of scopesToTry) {
        try {
          const bodyParams = new URLSearchParams();
          bodyParams.append('client_id', cId);
          bodyParams.append('grant_type', 'refresh_token');
          bodyParams.append('refresh_token', refreshToken);
          if (scope) bodyParams.append('scope', scope);

          const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: bodyParams.toString()
          });

          const tokenData = await tokenRes.json();
          if (tokenData.access_token) {
            accessToken = tokenData.access_token;
            if (tokenData.refresh_token) newRefreshToken = tokenData.refresh_token;
            break;
          } else {
            lastError = tokenData.error_description || tokenData.error || 'Token error';
          }
        } catch (err) {
          lastError = err.message;
        }
      }

      if (accessToken) break;
    }
  }

  // Check if authCookies or sessionId is already an access token (Bearer or JWT)
  if (!accessToken) {
    if (authCookies.startsWith('ey') || authCookies.startsWith('Ew')) {
      accessToken = authCookies.trim();
    } else if (sessionId.startsWith('ey') || sessionId.startsWith('Ew')) {
      accessToken = sessionId.trim();
    }
  }

  if (!accessToken) {
    return {
      success: false,
      error: lastError ? ('Lỗi OAuth2: ' + lastError) : 'Không tìm thấy Refresh Token hoặc đổi Access Token thất bại.'
    };
  }

  // 4. Fetch messages from Microsoft Graph API
  // Quét cả /me/messages (toàn bộ hộp thư) và /junkemail (Thư rác - phòng trường hợp DuoPlus bị lọc vào Spam)
  let messages = [];

  // 4a. Thử /me/messages (Bao gồm cả Inbox và các thư mục khác, sắp xếp theo thời gian mới nhất)
  try {
    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=20&$select=id,subject,bodyPreview,body,receivedDateTime,sender&$orderby=receivedDateTime desc', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const graphData = await graphRes.json();
    if (graphData && graphData.value && Array.isArray(graphData.value)) {
      messages = graphData.value;
    }
  } catch(e) {}

  // 4b. Dự phòng: /mailFolders/inbox/messages nếu /me/messages không trả về danh sách
  if (messages.length === 0) {
    try {
      const inboxRes = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=15&$select=id,subject,bodyPreview,body,receivedDateTime,sender&$orderby=receivedDateTime desc', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      const inboxData = await inboxRes.json();
      if (inboxData && inboxData.value && Array.isArray(inboxData.value)) {
        messages = inboxData.value;
      }
    } catch(e) {}
  }

  // 4c. Lấy thêm từ Junk Email (Thư rác) để tránh sót mail DuoPlus bị chuyển vào thư rác
  let junkMessages = [];
  try {
    const junkRes = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages?$top=10&$select=id,subject,bodyPreview,body,receivedDateTime,sender&$orderby=receivedDateTime desc', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const junkData = await junkRes.json();
    if (junkData && junkData.value && Array.isArray(junkData.value)) {
      junkMessages = junkData.value;
    }
  } catch(e) {}

  // Gộp tất cả email (Inbox + Junk) và sắp xếp mới nhất lên trước
  const allMessagesToCheck = [...messages, ...junkMessages].sort((a, b) => {
    return new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0);
  });

  if (allMessagesToCheck.length === 0) {
    return {
      success: false,
      notFoundDuoPlus: true,
      error: 'Hộp thư trống, chưa có email nào.'
    };
  }

  // 5. Quét tìm email chứa từ khóa (mặc định: 'duoplus') và trích xuất mã OTP 6 số
  let foundTargetEmail = false;

  for (const msg of allMessagesToCheck) {
    const subject = msg.subject || '';
    const preview = msg.bodyPreview || '';
    const rawBody = (msg.body && msg.body.content) ? msg.body.content : '';

    // Làm sạch HTML: loại bỏ thẻ style, script và các thẻ HTML
    const cleanBody = rawBody
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ');

    const senderAddress = (msg.sender && msg.sender.emailAddress && msg.sender.emailAddress.address) ? msg.sender.emailAddress.address.toLowerCase() : '';
    const senderName = (msg.sender && msg.sender.emailAddress && msg.sender.emailAddress.name) ? msg.sender.emailAddress.name.toLowerCase() : '';
    const subjectLower = subject.toLowerCase();
    const previewLower = preview.toLowerCase();
    const bodyLower = cleanBody.toLowerCase();

    // Kiểm tra từ khóa
    if (keyword) {
      const kw = keyword.toLowerCase();
      const isMatch = 
        senderAddress.includes(kw) ||
        senderName.includes(kw) ||
        subjectLower.includes(kw) ||
        previewLower.includes(kw) ||
        bodyLower.includes(kw) ||
        (kw === 'duoplus' && (
          senderAddress.includes('duo') ||
          senderName.includes('duo') ||
          subjectLower.includes('duo plus') ||
          subjectLower.includes('duo-plus') ||
          previewLower.includes('duo plus') ||
          previewLower.includes('duo-plus') ||
          bodyLower.includes('duo plus') ||
          bodyLower.includes('duo-plus')
        ));

      if (!isMatch) {
        // Email này không chứa từ khóa => Bỏ qua và quét email tiếp theo
        continue;
      }
    }

    foundTargetEmail = true;

    // Đã tìm thấy email mục tiêu! Trích xuất mã OTP 6 chữ số:
    const textToScan = `${subject} \n ${preview} \n ${cleanBody}`;

    let otp = null;

    // Ưu tiên 1: Cụm từ chứa từ khóa xác thực kèm 6 số (Code: 123456, Verification code is 123456, etc.)
    const keywordRegex = /(?:code|mã|otp|xác minh|xác thực|verification|verify|security|is|là|pin)[^\d]{0,40}\b(\d{6})\b/i;
    const kwMatch = textToScan.match(keywordRegex);
    if (kwMatch) {
      otp = kwMatch[1];
    }

    // Ưu tiên 2: 6 chữ số trong Tiêu đề (Subject)
    if (!otp) {
      const subjMatch = subject.match(/\b(\d{6})\b/);
      if (subjMatch) otp = subjMatch[1];
    }

    // Ưu tiên 3: 6 chữ số trong Preview
    if (!otp) {
      const prevMatch = preview.match(/\b(\d{6})\b/);
      if (prevMatch) otp = prevMatch[1];
    }

    // Ưu tiên 4: 6 chữ số độc lập trong nội dung text
    if (!otp) {
      const all6Digits = cleanBody.match(/\b(?<!\d)(\d{6})(?!\d)\b/g);
      if (all6Digits && all6Digits.length > 0) {
        const nonYear = all6Digits.filter(d => d !== '2025' && d !== '2026' && d !== '2024');
        otp = nonYear.length > 0 ? nonYear[0] : all6Digits[0];
      }
    }

    // Ưu tiên 5: Dạng số có dấu cách hoặc gạch nối (ví dụ: 123 456 hoặc 123-456)
    if (!otp) {
      const sepMatch = textToScan.match(/(?:code|mã|otp|verification)[^\d]{0,25}\b(\d{3})[-\s](\d{3})\b/i);
      if (sepMatch) {
        otp = sepMatch[1] + sepMatch[2];
      }
    }

    if (otp) {
      return {
        success: true,
        otp,
        subject,
        sender: senderAddress || senderName,
        receivedDateTime: msg.receivedDateTime,
        newRefreshToken
      };
    }
  }

  if (foundTargetEmail) {
    return {
      success: false,
      foundTargetEmail: true,
      error: `Đã tìm thấy email từ ${keyword || 'dịch vụ'} nhưng chưa trích xuất được mã OTP 6 số.`
    };
  }

  return {
    success: false,
    notFoundDuoPlus: true,
    error: `Chưa thấy email từ ${keyword || 'dịch vụ'} trong hộp thư. Đang tiếp tục quét...`
  };
}

module.exports = {
  fetchHotmailOAuth2Otp
};
