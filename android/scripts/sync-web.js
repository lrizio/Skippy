'use strict';
// Copies the shared desktop renderer into android/www and applies the phone shim.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, '..', 'app', 'renderer');
const out = path.join(root, 'www');
const shim = path.join(root, 'shim');
const version = require(path.join(root, '..', 'app', 'package.json')).version;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(out, f));
for (const f of ['shim.js', 'mobile.css']) fs.copyFileSync(path.join(shim, f), path.join(out, f));
fs.writeFileSync(path.join(out, 'version.js'), `window.SKIPPY_VERSION = ${JSON.stringify(version)};\n`);
fs.copyFileSync(path.join(root, '..', 'app', 'icon.png'), path.join(out, 'icon.png'));

let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const must = (s, label) => { if (!html.includes(s)) throw new Error('index.html changed, cannot patch: ' + label); };
must('connect-src ws: wss:;', 'CSP');
html = html.replace('connect-src ws: wss:;', 'connect-src ws: wss: http: https:;');
must('<meta charset="utf-8">', 'charset');
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">');
must('<link rel="stylesheet" href="style.css">', 'css');
html = html.replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="mobile.css">\n<script src="version.js"></script>\n<script src="shim.js"></script>');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('www/ ready, Skippy', version);

// Keep the iOS project's version in step with the desktop app (build number = maj*10000 + min*100 + patch).
const pbx = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
if (fs.existsSync(pbx)) {
  const [maj, min, pat] = version.split('.').map(Number);
  const build = String(maj * 10000 + min * 100 + pat);
  let t = fs.readFileSync(pbx, 'utf8');
  t = t.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
       .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);
  fs.writeFileSync(pbx, t);
  console.log('iOS project version', version, 'build', build);
}
