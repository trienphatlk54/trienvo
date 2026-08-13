const fs = require('fs');
let content = fs.readFileSync('public/index.html', 'utf8');

// Replace saveProxy
content = content.replace(
/async function saveProxy\(\) \{[\s\S]*?\$\('btnSaveProxy'\)\.disabled = false;\s*\}/,
`async function saveProxy() {
  const isCreate = document.getElementById('tab-shopee') && document.getElementById('tab-shopee').classList.contains('active');
  const suf = isCreate ? '_create' : '';

  const type = $('proxyType' + suf).value;
  const raw  = $('proxyInput' + suf).value.trim();
  if (!raw) return toast('Nhập chuỗi proxy: ip:port:user:pass', 'warning');

  const msg = $('proxyStatusMsg' + suf);
  const badge = $('proxyBadge' + suf);
  msg.style.display = 'inline-flex';
  msg.className = 'proxy-status-msg loading';
  msg.textContent = '⏳ Đang kiểm tra proxy...';
  $('btnSaveProxy' + suf).disabled = true;

  try {
    const res  = await fetch('/api/proxy/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, raw }),
    });
    const data = await res.json();

    if (data.success) {
      msg.className = 'proxy-status-msg ok';
      msg.innerHTML = \`✅ Kết nối OK - IP: <strong>\${data.ip}</strong>\`;
      badge.className = 'badge badge-ok';
      badge.textContent = 'Đang dùng';
      $('proxyInfo' + suf).style.display = 'flex';
      $('proxyIp' + suf).textContent = data.ip;
      $('btnClearProxy' + suf).style.display = 'inline-flex';
      $('proxyInput' + suf).disabled = true;
      $('proxyType' + suf).disabled = true;
      
      if (window.usedIpsSet && window.usedIpsSet.has(data.ip)) {
        toast('⚠️ Cảnh báo: IP ' + data.ip + ' đã được trích xuất/sử dụng trước đó!', 'error', 6000);
      } else {
        toast('✅ Proxy hoạt động! IP: ' + data.ip, 'success');
        fetch('/api/ips/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip: data.ip })
        });
        if (window.usedIpsSet) window.usedIpsSet.add(data.ip);
      }
    } else {
      msg.className = 'proxy-status-msg err';
      msg.textContent = '❌ ' + (data.error || 'Proxy không hoạt động');
      badge.className = 'badge badge-err';
      badge.textContent = 'Lỗi';
      $('proxyInfo' + suf).style.display = 'none';
      toast('❌ Proxy lỗi: ' + (data.error || ''), 'error', 5000);
    }
  } catch(e) {
    msg.className = 'proxy-status-msg err';
    msg.textContent = '❌ Lỗi kết nối server';
    toast('❌ Lỗi: ' + e.message, 'error');
  }
  $('btnSaveProxy' + suf).disabled = false;
}`);

// Replace clearProxy
content = content.replace(
/function clearProxy\(\) \{[\s\S]*?toast\('.*?Đã xóa proxy', 'info'\);\s*\}/,
`function clearProxy() {
  const isCreate = document.getElementById('tab-shopee') && document.getElementById('tab-shopee').classList.contains('active');
  const suf = isCreate ? '_create' : '';

  fetch('/api/proxy', { method: 'DELETE' });
  $('proxyStatusMsg' + suf).style.display = 'none';
  $('proxyBadge' + suf).className = 'badge badge-off';
  $('proxyBadge' + suf).textContent = 'Chưa cấu hình';
  $('proxyInfo' + suf).style.display = 'none';
  $('btnClearProxy' + suf).style.display = 'none';
  $('proxyInput' + suf).disabled = false;
  $('proxyInput' + suf).value = '';
  $('proxyType' + suf).disabled = false;
  toast('🗑 Đã xóa proxy', 'info');
}`);

fs.writeFileSync('public/index.html', content, 'utf8');
console.log('Fixed index.html saveProxy');
