const {join} = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Đặt lại thư mục cache của Puppeteer vào trong thư mục dự án để Render không bị mất file
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
