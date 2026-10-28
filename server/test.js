// Integration test: starts the server on a temp DB and exercises auth, rooms, cap, history.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const os = require('os'), path = require('path'), fs = require('fs');
const db = path.join(os.tmpdir(), 'skippy-test-' + Date.now() + '.db');
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '8493', SKIPPY_THROTTLE: '1000', SKIPPY_DB: db }, stdio: 'inherit' });
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); cleanup(1); } else console.log('ok  -', m); };
function cleanup(code) { srv.kill(); setTimeout(() => { for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(db + s); } catch {} process.exit(code); }, 300); }
function client() {
  return new Promise(res => {
    const ws = new WebSocket('ws://localhost:8493'); const q = []; let w = null;
    ws.on('message', d => { const m = JSON.parse(d); if (w) { const f = w; w = null; f(m); } else q.push(m); });
    const next = () => new Promise(r => q.length ? r(q.shift()) : (w = r));
    const until = async t => { for (;;) { const m = await next(); if (m.t === t) return m; } };
    ws.on('open', () => res({ ws, send: o => ws.send(JSON.stringify(o)), next, until }));
  });
}
(async () => {
  await new Promise(r => setTimeout(r, 800));
  const a = await client();
  a.send({ t: 'register', name: 'Alice', email: 'a@x.com', callsign: 'w1aw', password: 'short' });
  assert((await a.next()).t === 'error', 'short password rejected');
  a.send({ t: 'register', name: 'Alice', email: 'a@x.com', callsign: 'w1aw', password: 'password1' });
  const reg = await a.next(); assert(reg.t === 'authed' && reg.token, 'register -> authed');
  a.send({ t: 'register', name: 'alice', email: 'b@x.com', password: 'password1' });
  assert((await a.next()).t === 'error', 'duplicate name (case-insens.) rejected');

  const b = await client();
  b.send({ t: 'login', id: 'W1AW', password: 'wrong-pass' });
  assert((await b.next()).t === 'error', 'wrong password rejected');
  b.send({ t: 'login', id: 'w1aw', password: 'password1' });
  assert((await b.next()).t === 'authed', 'login by callsign');
  b.send({ t: 'login', id: 'a@x.com', password: 'password1' });
  assert((await b.next()).t === 'authed', 'login by email');

  const r = await client();
  r.send({ t: 'resume', token: reg.token });
  assert((await r.next()).t === 'authed', 'resume with token');
  r.send({ t: 'logout', token: reg.token }); await r.until('logged-out');
  const r2 = await client(); r2.send({ t: 'resume', token: reg.token });
  assert((await r2.next()).t === 'resume-failed', 'token dead after logout');

  a.send({ t: 'join', room: 'Net' });
  const j = await a.until('joined'); assert(j.peers.length === 0 && j.max === 10, 'alice joins room');
  a.send({ t: 'chat', text: 'hello' }); await a.until('chat');
  a.send({ t: 'file-announce', fileId: 'f1', fileName: 'x.txt', fileSize: 12 }); await a.until('chat');

  const users = [a];
  for (let i = 2; i <= 11; i++) {
    const u = await client();
    u.send({ t: 'register', name: 'User' + i, email: `u${i}@x.com`, password: 'password1' });
    await u.until('authed');
    u.send({ t: 'join', room: 'net' });
    const m = await u.next();
    if (i <= 10) { assert(m.t === 'joined', `user ${i} joined`); if (i === 10) assert(m.peers.length === 9, 'tenth sees 9 peers'); }
    else assert(m.t === 'room-full', 'eleventh refused (room-full)');
    users.push(u);
  }
  const h = users[1]; h.send({ t: 'history', room: 'net' });
  const hist = await h.until('history');
  assert(hist.history.length === 2 && hist.history[1].kind === 'file', 'history persisted (text + file)');
  cleanup(0);
})().catch(e => { console.error(e); cleanup(1); });
