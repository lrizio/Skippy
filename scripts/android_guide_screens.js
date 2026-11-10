// Renders the phone screenshots for docs/Skippy Android Install Guide.pdf from the real Android web layer
// (android/www) in headless Edge with a phone-sized viewport and a fake camera.
//   node android/scripts/sync-web.js && node scripts/android_guide_screens.js
const { spawn } = require('child_process');
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'server/node_modules/ws'));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(ROOT, 'docs/guide-android');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skippy-adroid-guide-'));
const procs = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WWW = path.join(ROOT, 'android/www');

procs.push(spawn(process.execPath, ['server.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: '8498', SKIPPY_DB: tmp + '/db.sqlite', SKIPPY_UPDATE_FILE: tmp + '/none.json' }, stdio: 'ignore' }));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const web = http.createServer((q, r) => {
  const f = path.join(WWW, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); } });
}).listen(8497);

const launch = (port, tag, url) => procs.push(spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}/${tag}`,
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-first-run', '--window-size=412,892', url], { stdio: 'ignore' }));
const getJson = url => new Promise((res, rej) => http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
async function cdp(port) {
  let page;
  for (let i = 0; i < 60 && !page; i++) { try { page = (await getJson(`http://127.0.0.1:${port}/json`)).find(t => t.type === 'page' && /^http/.test(t.url)); } catch {} if (!page) await sleep(500); }
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r));
  let id = 0; const pend = new Map();
  ws.on('message', d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const call = (method, params) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise(res => pend.set(i, res)); };
  await call('Emulation.setDeviceMetricsOverride', { width: 412, height: 892, deviceScaleFactor: 2, mobile: true });
  const ev = async expr => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
  const shot = async name => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); console.log('shot', name); };
  return { ev, shot, close: () => ws.close() };
}

(async () => {
  try {
    await sleep(1500);
    launch(9441, 'a', 'http://localhost:8497/');
    launch(9442, 'b', 'http://127.0.0.1:8497/'); // other origin = separate storage = second person
    const A = await cdp(9441), B = await cdp(9442);
    await sleep(1500);
    await A.shot('1-login-empty.png');
    const reg = (c, n, e, cs) => c.ev(`(async()=>{const $=s=>document.querySelector(s);$('#server-url').value='ws://100.64.0.10:8470';
      document.querySelector('.server-box').open=true;
      $('#server-url').value='ws://localhost:8498';$('#tab-register').click();$('#reg-name').value=${JSON.stringify(n)};$('#reg-email').value=${JSON.stringify(e)};
      $('#reg-call').value=${JSON.stringify(cs)};$('#reg-pw').value='guide-pass-1';$('#form-register').requestSubmit();await new Promise(r=>setTimeout(r,2500));
      $('#btn-recovery-done')?.click();return 1})()`);
    await A.ev(`(async()=>{const $=s=>document.querySelector(s);$('#server-url').value='100.64.0.10:8470';document.querySelector('.server-box').open=true;return 1})()`);
    await A.shot('2-login-server.png');
    await reg(A, 'Alex', 'alex@example.com', 'W1ABC'); await reg(B, 'Sam', 'sam@example.com', 'K2XYZ');
    await sleep(1500); await A.shot('3-lobby.png');
    for (const c of [A, B]) await c.ev(`(async()=>{const $=s=>document.querySelector(s);$('#room-name').value='club night';$('#form-join').requestSubmit();await new Promise(r=>setTimeout(r,3500));return 1})()`);
    await sleep(2500); await A.shot('4-call.png');
    await B.ev(`(async()=>{const $=s=>document.querySelector(s);$('#chat-input').value='Hi Alex, can you hear me?';$('#chat-form').requestSubmit();return 1})()`);
    await sleep(800);
    await A.ev(`document.querySelector('#btn-chat').click()`); await sleep(500); await A.shot('5-chat.png');
    A.close(); B.close();
  } finally { for (const p of procs) try { p.kill(); } catch {} web.close(); setTimeout(() => process.exit(0), 500); }
})().catch(e => { console.error(e); process.exit(1); });
