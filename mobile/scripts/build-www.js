// Builds www/ for Capacitor: the website's frontend (public/) plus the shared scoring engine,
// with config.js pointing the app at the deployed server (app.config.json, or API_BASE env var).
const fs = require('fs');
const path = require('path');

const mobile = path.join(__dirname, '..');
const repo = path.join(mobile, '..');
const www = path.join(mobile, 'www');

const apiBase = (process.env.API_BASE || require('../app.config.json').apiBase || '').replace(/\/+$/, '');
if (!/^https:\/\//.test(apiBase) && !process.env.API_BASE) {
  console.error('Set apiBase in mobile/app.config.json to the deployed server, e.g. https://your-app.onrender.com');
  process.exit(1);
}

const SKIP = new Set(['config.js', 'android.html']); // config is generated; the download page is for the website
fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(repo, 'public'), www, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
fs.copyFileSync(path.join(repo, 'lib', 'scoring.js'), path.join(www, 'scoring.js'));
fs.writeFileSync(path.join(www, 'config.js'), `window.APP_CONFIG = ${JSON.stringify({ apiBase })};\n`);

console.log(`www/ built, API: ${apiBase}`);
