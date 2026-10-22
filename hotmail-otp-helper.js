// hotmail-otp-helper.js
// Đọc hộp thư Hotmail/Outlook qua Microsoft OAuth2 và Graph API để trích xuất mã OTP 6 số

async function fetchHotmailOAuth2Otp(account, sinceTime = null) {
  const { hotmail, password, authCookies = '', sessionId = '', restoreMail = '' } = account;

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

  // 3. Fallback Client IDs
  const clientIdsToTry = [];
  if (clientId) clientIdsToTry.push(clientId);
  const fallbackClientIds = [
    'd3590ed6-52b3-4102-aeff-aad2292ab01c', // Office / Outlook Desktop
    '08aeb3b0-eeff-4e6c-ac0b-42994b9b2e86', // Outlook Mobile
    '9e5f94bc-e8a4-4e73-b8be-63364c29d753', // Outlook Windows
    'e80dab22-c3a5-4886-b484-90fb9b00868f'  // Live SDK / Taphoammo
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

  // 4. Fetch inbox messages from Microsoft Graph API
  try {
    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=10&$select=id,subject,bodyPreview,body,receivedDateTime,sender&$orderby=receivedDateTime desc', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const graphData = await graphRes.json();
    if (!graphData.value || !Array.isArray(graphData.value)) {
      return {
        success: false,
        error: graphData.error ? graphData.error.message : 'Không truy xuất được danh sách email từ Graph API'
      };
    }

    const messages = graphData.value;
    if (messages.length === 0) {
      return {
        success: false,
        error: 'Hộp thư trống, chưa có email nào mới.'
      };
    }

    // 5. Filter latest emails and look for exact 6-digit OTP code
    for (const msg of messages) {
      // Tiêu chí lọc OTP: Chỉ lọc mail thời gian nhận từ mốc thời gian click nút Send Code cho đến hiện tại
      if (sinceTime) {
        const msgTime = new Date(msg.receivedDateTime).getTime();
        // Cho phép dung sai 30 giây lệch đồng hồ giữa server Microsoft và máy tính
        if (msgTime < (sinceTime - 30000)) {
          continue; // Bỏ qua email cũ nhận trước khi bấm Send Code!
        }
      }

      const subject = msg.subject || '';
      const preview = msg.bodyPreview || '';
      const rawBody = (msg.body && msg.body.content) ? msg.body.content : '';
      const bodyText = rawBody.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
      const combined = `${subject} \n ${preview} \n ${bodyText}`;

      // Priority 1: Keyword-based regex
      const keywordRegex = /(?:code|mã|otp|xác minh|xác thực|verification|security|is|là|pin)[^\d]{1,25}\b(\d{6})\b/i;
      const kwMatch = combined.match(keywordRegex);
      let otp = kwMatch ? kwMatch[1] : null;

      // Priority 2: 6 digits in subject
      if (!otp) {
        const subjMatch = subject.match(/\b(\d{6})\b/);
        if (subjMatch) otp = subjMatch[1];
      }

      // Priority 3: Any isolated 6 digits
      if (!otp) {
        const anyMatch = combined.match(/\b(?<!\d)(\d{6})(?!\d)\b/);
        if (anyMatch) otp = anyMatch[1];
      }

      if (otp) {
        const sender = (msg.sender && msg.sender.emailAddress) ? msg.sender.emailAddress.address : '';
        return {
          success: true,
          otp,
          subject,
          sender,
          receivedDateTime: msg.receivedDateTime,
          newRefreshToken
        };
      }
    }

    return {
      success: false,
      error: sinceTime ? 'Chưa nhận được email mã xác thực mới (sau thời điểm Send Code).' : 'Đã đọc mail mới nhất nhưng chưa tìm thấy mã xác thực 6 số.'
    };
  } catch (err) {
    return {
      success: false,
      error: 'Lỗi kết nối Graph API: ' + err.message
    };
  }
}

module.exports = {
  fetchHotmailOAuth2Otp
};
