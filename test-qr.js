const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('https://okkproxy.com/en/proxy-qr-code', { waitUntil: 'networkidle2' });
  
  // Wait for input to be ready
  await page.waitForSelector('input', {timeout: 10000});
  
  // Dump inputs
  const inputs = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('input'));
    return els.map(e => e.outerHTML);
  });
  console.log('Inputs:', inputs);
  
  // Fill the inputs assuming standard form
  const inputEls = await page.('input');
  if (inputEls.length >= 4) {
    await inputEls[0].type('1.2.3.4');
    await inputEls[1].type('1080');
    await inputEls[2].type('user');
    await inputEls[3].type('pass');
  }
  
  // Wait a bit for QR code to generate
  await new Promise(r => setTimeout(r, 2000));
  
  // Dump images
  const imgs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img')).map(i => i.src);
  });
  console.log('Images:', imgs);
  
  // Also let's extract the QR code content using a QR decoder library if possible, but let's just see the src first
  // Usually the src is a data URL or an API endpoint.
  // If we can get the actual text inside the QR code, that would be perfect.
  
  await page.screenshot({path: 'okkproxy.png'});
  await browser.close();
})();
