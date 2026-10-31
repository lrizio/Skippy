// Integration test: starts the server on a temp DB and exercises auth, rooms, cap, history.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const totp = require('./totp');
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
  for (const x of [a, u2, u3, u4]) x.send({ t: 'leave' }); // calls made from inside a room add people to that room, so start from the lobby
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
  const ms = await u4.until('missed');
  assert(ms.calls.length === 1 && ms.calls[0].from.name === 'User3', 'unanswered call is recorded as a missed call for the callee');
  u4.send({ t: 'missed-dismiss', id: ms.calls[0].id });
  assert((await u4.until('missed')).calls.length === 0, 'missed call can be dismissed');
  const hist2 = await (async () => { a.send({ t: 'history', room: s1.room }); return a.until('history'); })();
  assert(Array.isArray(hist2.history), 'direct-room history query works');

  // ---- add someone to a call in progress ----
  a.send({ t: 'chat', text: 'secret before add' }); await a.until('chat');
  a.send({ t: 'call', to: 'User2' });
  assert((await a.until('call-failed')).msg.includes('already in this call'), 'cannot add someone who is already in the call');
  a.send({ t: 'call', to: 'User3' });
  const inc5 = await u3.until('incoming-call');
  u3.send({ t: 'call-answer', callId: inc5.callId, accept: true });
  const added = await a.until('call-added'); assert(added.with.name === 'User3', 'caller told the person was added (stays in the call)');
  const s5 = await u3.until('call-start'); assert(s5.room === s1.room, 'added person is sent to the existing room');
  u3.send({ t: 'join', room: s5.room }); const j3 = await u3.until('joined');
  assert(j3.peers.length === 2, 'third person joins the same room as both others');
  assert(!j3.history.some(m => m.text === 'secret before add'), 'added person does not see chat from before they were added');
  u3.send({ t: 'chat', text: 'hi all' });
  let got; do got = await u2.until('chat'); while (got.msg.text !== 'hi all'); // skip earlier chat lines
  assert(got.msg.text === 'hi all', 'chat reaches everyone in the extended call');
  a.send({ t: 'call', to: 'W1AW' }); // yourself
  assert((await a.until('call-failed')).msg.includes('yourself'), 'still cannot call yourself');

  // ---- rooms in use list ----
  u4.send({ t: 'join', room: 'Lounge' }); await u4.until('joined');
  let lp; for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 50)); lp = await a.until('presence'); if (lp.rooms.some(r => r.name === 'lounge')) break; }
  assert(lp.rooms.some(r => r.name === 'lounge' && r.count === 1), 'presence lists a named room with its head count');
  assert(!lp.rooms.some(r => r.name.startsWith('@')), 'private direct-call rooms are never listed');
  u4.send({ t: 'leave' });
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 50)); lp = await a.until('presence'); if (!lp.rooms.some(r => r.name === 'lounge')) break; }
  assert(!lp.rooms.some(r => r.name === 'lounge'), 'empty room disappears from the list');

  // ---- two-factor (TOTP) ----
  // RFC 6238 test vector: secret "12345678901234567890", T=59s -> 94287082 (8 digits) -> 287082 (6 digits)
  const rfcSecret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert(totp.codeAt(rfcSecret, 59000, 8) === '94287082' && totp.codeAt(rfcSecret, 59000) === '287082', 'TOTP matches RFC 6238 test vector');
  const t = await client();
  t.send({ t: 'register', name: 'Tina', email: 't@x.com', password: 'password1' });
  const tAuth = await t.until('authed'); assert(tAuth.totp === false, 'new account has 2FA off');
  t.send({ t: 'totp-setup' });
  const setup = await t.until('totp-setup'); assert(/^[A-Z2-7]{32}$/.test(setup.secret) && setup.uri.startsWith('otpauth://totp/Skippy:Tina'), 'setup returns secret + otpauth URI');
  t.send({ t: 'totp-enable', code: '000000' });
  assert((await t.until('error')).msg.includes('does not match'), 'wrong code does not enable 2FA');
  t.send({ t: 'totp-enable', code: totp.codeAt(setup.secret) });
  const en = await t.until('totp-enabled'); assert(en.backupCodes.length === 10, '2FA enabled, 10 backup codes issued');

  const t2 = await client();
  t2.send({ t: 'login', id: 'tina', password: 'password1' });
  assert((await t2.next()).t === 'totp-required', 'password login now asks for a code (no session yet)');
  t2.send({ t: 'join', room: 'x' });
  assert((await t2.next()).t === 'error', 'cannot do anything before the code');
  t2.send({ t: 'login-totp', code: '123456' });
  assert((await t2.next()).msg.includes('not valid'), 'wrong code rejected');
  // the code just used at enable-time must not be accepted again (replay protection)
  t2.send({ t: 'login-totp', code: totp.codeAt(setup.secret) });
  assert((await t2.next()).t === 'error', 'a code already used cannot be replayed');
  // a code from the next time step is within the allowed drift window and has not been used yet
  t2.send({ t: 'login-totp', code: totp.codeAt(setup.secret, Date.now() + 30000) });
  const ok2 = await t2.next(); assert(ok2.t === 'authed' && ok2.totp === true, 'valid next-step code logs in');

  const t3 = await client();
  t3.send({ t: 'login', id: 'Tina', password: 'password1' }); await t3.next();
  t3.send({ t: 'login-totp', code: en.backupCodes[0] });
  assert((await t3.next()).t === 'authed', 'backup code logs in');
  const t4 = await client();
  t4.send({ t: 'login', id: 'Tina', password: 'password1' }); await t4.next();
  t4.send({ t: 'login-totp', code: en.backupCodes[0] });
  assert((await t4.next()).t === 'error', 'backup code works only once');
  t4.send({ t: 'login', id: 'Tina', password: 'password1' }); await t4.next();
  for (let i = 0; i < 5; i++) { t4.send({ t: 'login-totp', code: '111111' }); await t4.next(); }
  t4.send({ t: 'login-totp', code: totp.codeAt(setup.secret, Date.now() + 60000) });
  assert((await t4.next()).t === 'totp-expired', 'five wrong codes cancel the login attempt');

  t.send({ t: 'totp-disable', password: 'wrong', code: en.backupCodes[1] });
  assert((await t.until('error')).msg.includes('wrong'), 'disable needs the password');
  t.send({ t: 'totp-disable', password: 'password1', code: en.backupCodes[1] });
  await t.until('totp-disabled');
  const t5 = await client(); t5.send({ t: 'login', id: 'Tina', password: 'password1' });
  assert((await t5.next()).t === 'authed', '2FA off again -> password alone logs in');

  // ---- password recovery ----
  const key = tAuth.recoveryKey; assert(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/.test(key), 'new account is issued a recovery key');
  const f = await client();
  f.send({ t: 'reset-password', id: 'Tina', code: 'AAAA-BBBB-CCCC-DDDD', password: 'newpass99' });
  assert((await f.next()).msg.includes('not valid'), 'wrong recovery key rejected');
  f.send({ t: 'reset-password', id: 'nobody', code: key, password: 'newpass99' });
  assert((await f.next()).msg.includes('not valid'), 'unknown account gives the same message');
  f.send({ t: 'reset-password', id: 'Tina', code: key, password: 'short' });
  assert((await f.next()).msg.includes('8 characters'), 'new password must be 8+ characters');
  const tToken = tAuth.token;
  f.send({ t: 'reset-password', id: 'tina', code: key.toLowerCase().replace(/-/g, ' '), password: 'newpass99' });
  const rr = await f.next(); assert(rr.t === 'password-reset' && rr.recoveryKey && rr.recoveryKey !== key, 'recovery key resets the password and issues a new key');
  assert((await f.next()).t === 'authed', 'reset logs the user in');
  const g = await client(); g.send({ t: 'login', id: 'Tina', password: 'password1' });
  assert((await g.next()).t === 'error', 'old password no longer works');
  g.send({ t: 'login', id: 'Tina', password: 'newpass99' });
  assert((await g.next()).t === 'authed', 'new password works');
  const g2 = await client(); g2.send({ t: 'resume', token: tToken });
  assert((await g2.next()).t === 'resume-failed', 'reset signs out other sessions');
  const g3 = await client();
  g3.send({ t: 'reset-password', id: 'Tina', code: key, password: 'another99' });
  assert((await g3.next()).t === 'error', 'a recovery key works only once');

  // host-issued one-time code
  const out = require('child_process').execFileSync(process.execPath, ['reset-password.js', 'tina'], { env: { ...process.env, SKIPPY_DB: db } }).toString();
  const hostCode = /([A-Z2-9]{4}-[A-Z2-9]{4})\s/.exec(out)[1];
  g3.send({ t: 'reset-password', id: 'Tina', code: hostCode, password: 'hostset99' });
  assert((await g3.next()).t === 'password-reset', 'host-issued code resets the password');
  const g4 = await client();
  g4.send({ t: 'reset-password', id: 'Tina', code: hostCode, password: 'again1234' });
  assert((await g4.next()).t === 'error', 'host code works only once');
  // an expired host code is refused
  const { DatabaseSync } = require('node:sqlite'); const dbx = new DatabaseSync(db);
  const out2 = require('child_process').execFileSync(process.execPath, ['reset-password.js', 'tina@nowhere'.replace('tina@nowhere', 't@x.com')], { env: { ...process.env, SKIPPY_DB: db } }).toString();
  const code2 = /([A-Z2-9]{4}-[A-Z2-9]{4})\s/.exec(out2)[1];
  dbx.prepare('UPDATE users SET reset_expires = ? WHERE name = ?').run(Date.now() - 1000, 'Tina'); dbx.close();
  g4.send({ t: 'reset-password', id: 'Tina', code: code2, password: 'again1234' });
  assert((await g4.next()).t === 'error', 'expired host code refused');

  // existing accounts can make a recovery key from Security (needs the password)
  const hh = await client(); hh.send({ t: 'login', id: 'Tina', password: 'hostset99' }); await hh.until('authed');
  hh.send({ t: 'recovery-new', password: 'nope' });
  assert((await hh.until('error')).msg.includes('wrong'), 'new recovery key needs the password');
  hh.send({ t: 'recovery-new', password: 'hostset99' });
  const nk = await hh.until('recovery-new'); assert(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/.test(nk.recoveryKey), 'new recovery key issued');
  cleanup(0);
})().catch(e => { console.error(e); cleanup(1); });
