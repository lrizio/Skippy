// Renders the screenshots used in docs/Skippy User Guide.pdf from the real app (two instances, fake camera).
//   node scripts/guide_screens.js        (needs: npm install in app/ and server/)
const { spawn } = require('child_process');
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'server/node_modules/ws'));
const totp = require(path.join(ROOT, 'server/totp.js'));
const ELECTRON = path.join(ROOT, 'app/node_modules/electron/dist/electron.exe');
const OUT = path.join(ROOT, 'docs/guide');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skippy-guide-'));
const procs = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

procs.push(spawn(process.execPath, ['server.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, SKIPPY_DB: tmp + '/db.sqlite', SKIPPY_UPDATE_FILE: tmp + '/none.json' }, stdio: 'ignore' }));
const launch = (port, tag) => procs.push(spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}/${tag}`,
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--window-size=1280,800'], { cwd: path.join(ROOT, 'app'), stdio: 'ignore' }));
const getJson = url => new Promise((res, rej) => http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
async function cdp(port) {
  let page;
  for (let i = 0; i < 40 && !page; i++) { try { page = (await getJson(`http://127.0.0.1:${port}/json`)).find(t => t.type === 'page'); } catch {} if (!page) await sleep(500); }
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r));
  let id = 0; const pend = new Map();
  ws.on('message', d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const call = (method, params) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise(res => pend.set(i, res)); };
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const ev = async expr => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
  const shot = async name => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); console.log('shot', name); };
  return { ev, shot, close: () => ws.close() };
}
const submit = sel => `document.querySelector('${sel}').requestSubmit()`;
const setv = (sel, v) => `document.querySelector('${sel}').value=${JSON.stringify(v)}`;
const click = sel => `document.querySelector('${sel}').click()`;

(async () => {
  await sleep(1000);
  launch(9341, 'a');
  const A = await cdp(9341); await sleep(2000);
  await A.shot('login.png');
  await A.ev(click('#tab-register')); await sleep(300);
  await A.ev([setv('#reg-name', 'Alice'), setv('#reg-email', 'alice@example.com'), setv('#reg-call', 'W1AW'), setv('#reg-pw', 'correct horse')].join(';'));
  await A.shot('register.png');
  await A.ev(submit('#form-register')); await sleep(2500);
  launch(9342, 'b'); await sleep(3500);
  const B = await cdp(9342); await sleep(1000);
  await B.ev(click('#tab-register')); await sleep(300);
  await B.ev([setv('#reg-name', 'Bob'), setv('#reg-email', 'bob@example.com'), setv('#reg-call', 'K2XYZ'), setv('#reg-pw', 'battery staple'), submit('#form-register')].join(';'));
  await sleep(2500);

  await A.shot('lobby.png');
  await A.ev(click('#btn-call-lobby')); await sleep(500);
  await A.shot('people.png');
  await A.ev(`document.querySelector('#people-list .person button').click()`); await sleep(1200);
  await A.shot('calling.png'); await B.shot('incoming.png');
  await B.ev(click('#btn-decline')); await sleep(800);

  // a group room with chat and a file
  for (const X of [A, B]) await X.ev(setv('#room-name', 'weeknight-net') + ';' + submit('#form-join'));
  await sleep(4000);
  await A.ev(setv('#chat-input', 'Evening all - can everyone hear me?') + ';' + submit('#chat-form')); await sleep(400);
  await B.ev(setv('#chat-input', 'Loud and clear, Alice.') + ';' + submit('#chat-form')); await sleep(400);
  await A.ev(`window.__t = new File([new Uint8Array(2.4*1024*1024)], 'net-checkin-log.txt')`);
  await A.ev(`(()=>{const dt=new DataTransfer(); dt.items.add(window.__t); const i=document.querySelector('#file-input'); i.files=dt.files; i.dispatchEvent(new Event('change'));})()`);
  await sleep(3000);
  await A.shot('call.png');

  // two-factor setup
  await A.ev(click('#btn-leave')); await sleep(1500);
  await A.ev(click('#btn-security')); await sleep(300);
  await A.shot('security-off.png');
  await A.ev(click('#btn-sec-start')); await sleep(1000);
  const secret = (await A.ev(`document.querySelector('#sec-secret').textContent`)).replace(/\s/g, '');
  await A.shot('security-setup.png');
  await A.ev(setv('#sec-code', totp.codeAt(secret)) + ';' + submit('#form-sec-enable')); await sleep(800);
  await A.shot('security-codes.png');
  A.close(); B.close();
})().catch(e => { console.error('ERR', e); process.exitCode = 1; }).finally(() => { setTimeout(() => { procs.forEach(p => { try { p.kill(); } catch {} }); process.exit(process.exitCode || 0); }, 500); });
