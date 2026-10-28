// Integration test: starts the server on a temp DB and exercises auth, rooms, cap, history.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const os = require('os'), path = require('path'), fs = require('fs');
const db = path.join(os.tmpdir(), 'skippy-test-' + Date.now() + '.db');
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '8494', SKIPPY_THROTTLE: '1000', SKIPPY_CALL_TIMEOUT: '1500', SKIPPY_DB: db }, stdio: 'inherit' });
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); cleanup(1); } else console.log('ok  -', m); };
function cleanup(code) { srv.kill(); setTimeout(() => { for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(db + s); } catch {} process.exit(code); }, 300); }
function client() {
  return new Promise(res => {
    const ws = new WebSocket('ws://localhost:8494'); const q = []; let w = null; let lastPresence = null; let pw = null;
    ws.on('message', d => {
      const m = JSON.parse(d);
      if (m.t === 'presence') { lastPresence = m; if (pw) { const f = pw; pw = null; f(m); } return; } // kept apart from the main queue
      if (w) { const f = w; w = null; f(m); } else q.push(m);
    });
    const next = () => new Promise(r => q.length ? r(q.shift()) : (w = r));
    const until = async t => {
      if (t === 'presence') return lastPresence || new Promise(r => (pw = r));
      for (;;) { const m = await next(); if (m.t === t) return m; }
    };
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

  // ---- direct calls ----
  const u2 = users[1], u3 = users[2], u4 = users[3];
  const pres = await u2.until('presence'); assert(pres.users.length >= 1, 'presence broadcasts online users');
  a.send({ t: 'call', to: 'user2' });
  const calling = await a.until('calling'); assert(calling.to.name === 'User2', 'caller gets "calling" (lookup by name, case-insens.)');
  const inc = await u2.until('incoming-call'); assert(inc.from.name === 'Alice', 'callee rings even while in another room');
  u2.send({ t: 'call-answer', callId: inc.callId, accept: true });
  const s1 = await a.until('call-start'), s2 = await u2.until('call-start');
  assert(s1.room === s2.room && s1.room.startsWith('@') && s1.with.name === 'User2' && s2.with.name === 'Alice', 'accept -> both get same private room');
  a.send({ t: 'join', room: s1.room }); await a.until('joined');
  u2.send({ t: 'join', room: s1.room }); const j2 = await u2.until('joined');
  assert(j2.peers.length === 1, 'both in the direct room');
  u3.send({ t: 'join', room: s1.room });
  assert((await u3.until('error')).msg.includes('private'), 'third user cannot enter a private call room');

  u3.send({ t: 'call', to: 'W1AW' });
  const inc3 = await a.until('incoming-call'); assert(inc3.from.name === 'User3', 'call by callsign reaches Alice');
  a.send({ t: 'call-answer', callId: inc3.callId, accept: false });
  assert((await u3.until('call-failed')).msg.includes('declined'), 'decline reported to caller');

  u3.send({ t: 'call', to: 'Nobody' });
  assert((await u3.until('call-failed')).msg.includes('No user'), 'unknown user rejected');
  const off = await client(); off.send({ t: 'register', name: 'Offline', email: 'o@x.com', password: 'password1' });
  await off.until('authed'); off.send({ t: 'logout', token: '' }); await off.until('logged-out');
  u3.send({ t: 'call', to: 'Offline' });
  assert((await u3.until('call-failed')).msg.includes('not online'), 'logged-out user cannot be called');

  u3.send({ t: 'call', to: 'User4' });
  await u4.until('incoming-call');
  assert((await u3.until('call-failed')).msg.includes('did not answer'), 'unanswered call times out');
  assert((await u4.until('call-cancelled')) !== null, 'callee ring cancelled on timeout');
  const hist2 = await (async () => { a.send({ t: 'history', room: s1.room }); return a.until('history'); })();
  assert(Array.isArray(hist2.history), 'direct-room history query works');
  cleanup(0);
})().catch(e => { console.error(e); cleanup(1); });
