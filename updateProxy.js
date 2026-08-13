const fs = require('fs');
let content = fs.readFileSync('server.js', 'utf8');

// Update reset()
content = content.replace(
/async function reset\(\) \{[\s\S]*?Object\.assign\(S, \{ status:'idle'.*?\);\s*\}/,
`async function reset() {
  clearInterval(S.poll); clearTimeout(S.expire);
  S.poll = S.expire = null;
  if (S.page) { try { await S.page.close(); } catch(_){} S.page = null; }
  if (S.ctx)  { try { await S.ctx.close();  } catch(_){} S.ctx  = null; }
  if (S.browser) { 
    try { await S.browser.close(); } catch(_){} 
    if (S.browser.anonymizedProxyUrl) {
      proxyChain.closeAnonymizedProxy(S.browser.anonymizedProxyUrl, true).catch(()=>{});
    }
    S.browser = null; 
  }
  Object.assign(S, { status:'idle', qrImage:null, cookies:null, userInfo:null, error:null, expiresAt:null });
}`);

// Update launchBrowser()
content = content.replace(
/async function launchBrowser\(proxy\) \{[\s\S]*?protocolTimeout: 180000,.*?\n\s*\}\);?\s*\}/,
`async function launchBrowser(proxy) {
  const args = [
    '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled','--lang=vi-VN,vi',
    '--disable-gpu','--disable-extensions','--disable-background-networking',
    '--disable-default-apps','--disable-sync','--no-first-run',
  ];
  let anonymizedProxyUrl = null;
  
  if (proxy) {
    let finalProxyUrl = proxyUrl(proxy);
    // Use proxy-chain for HTTP proxies with authentication to ensure Puppeteer compatibility
    if (proxy.user && proxy.type === 'http') {
      try {
        anonymizedProxyUrl = await proxyChain.anonymizeProxy(\`\${proxy.type}://\${proxy.user}:\${proxy.pass}@\${proxy.host}:\${proxy.port}\`);
        finalProxyUrl = anonymizedProxyUrl;
        console.log(\`  🌐 Proxy-chain anonymized: \${finalProxyUrl}\`);
      } catch (err) {
        console.error(\`  ❌ Proxy-chain error: \${err.message}\`);
      }
    }
    args.push(\`--proxy-server=\${finalProxyUrl}\`);
    console.log(\`  🌐 Chrome + proxy: \${finalProxyUrl}\`);
  } else {
    console.log('  🌐 Chrome (không proxy)');
  }
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args,
    defaultViewport: { width: 1280, height: 900 },
    protocolTimeout: 180000,
  });
  browser.anonymizedProxyUrl = anonymizedProxyUrl;
  return browser;
}`);

// Also update the test browser in /api/proxy/save to close anonymized proxy
content = content.replace(
/await testBrowser\.close\(\);\s*testBrowser = null;/,
`await testBrowser.close();
    if (testBrowser.anonymizedProxyUrl) {
      await proxyChain.closeAnonymizedProxy(testBrowser.anonymizedProxyUrl, true).catch(()=>{});
    }
    testBrowser = null;`
);

fs.writeFileSync('server.js', content, 'utf8');
console.log('Updated server.js');
