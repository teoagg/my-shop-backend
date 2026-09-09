const path = require('node:path');
const { createStrapi } = require('@strapi/strapi');
process.chdir(__dirname);
createStrapi({ appDir: __dirname, distDir: path.join(__dirname, 'dist') }).start();
