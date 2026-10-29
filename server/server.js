'use strict';
// Skippy server: accounts, session tokens, room signaling (max 10 per room) and chat history.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {
  console.error(`This Node.js (${process.version}) has no built-in SQLite. Skippy's server needs Node.js 22.13 or newer.`);
  console.error('On Node 22.5-22.12 you can instead start it with:  node --experimental-sqlite server.js');
  process.exit(1);
}
const { WebSocketServer } = require('ws');
const totp = require('./totp');

const PORT = parseInt(process.env.PORT || '8470', 10);
const DB_PATH = process.env.SKIPPY_DB || path.join(__dirname, 'skippy.db');
const MAX_PARTICIPANTS = 10;
const HISTORY_LIMIT = 200;
const MAX_CHAT_LEN = 4000;

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    callsign TEXT COLLATE NOCASE,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_callsign ON users(callsign) WHERE callsign IS NOT NULL;
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT,
    file_name TEXT,
    file_size INTEGER
  );
  CREATE INDEX IF NOT EXISTS messages_room ON messages(room, id);
`);

// two-factor columns / table (added after v1.1, so migrate older databases in place)
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'totp_secret'))
  db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT;
           ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
           ALTER TABLE users ADD COLUMN totp_last INTEGER NOT NULL DEFAULT 0;`);
db.exec('CREATE TABLE IF NOT EXISTS backup_codes (user_id INTEGER NOT NULL, code_hash TEXT NOT NULL, PRIMARY KEY (user_id, code_hash))');

const q = {
  setTotp: db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_last = ? WHERE id = ?'),
  clearTotp: db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last = 0 WHERE id = ?'),
  setTotpLast: db.prepare('UPDATE users SET totp_last = ? WHERE id = ?'),
  insBackup: db.prepare('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)'),
  delBackups: db.prepare('DELETE FROM backup_codes WHERE user_id = ?'),
  useBackup: db.prepare('DELETE FROM backup_codes WHERE user_id = ? AND code_hash = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE name = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userByCall: db.prepare('SELECT * FROM users WHERE callsign = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insUser: db.prepare('INSERT INTO users (name,email,callsign,salt,hash,created) VALUES (?,?,?,?,?,?)'),
  insSession: db.prepare('INSERT INTO sessions (token_hash,user_id,created) VALUES (?,?,?)'),
  sessionUser: db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  insMsg: db.prepare('INSERT INTO messages (room,user_id,name,ts,kind,text,file_name,file_size) VALUES (?,?,?,?,?,?,?,?)'),
  history: db.prepare('SELECT * FROM (SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'),
  recentRooms: db.prepare(
    "SELECT room, MAX(id) AS last FROM messages WHERE room NOT LIKE '@%' AND room IN (SELECT DISTINCT room FROM messages WHERE user_id = ?) GROUP BY room ORDER BY last DESC LIMIT 12"
  ),
};

// ---- password / token helpers ----
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function newToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.insSession.run(sha256(token), userId, Date.now());
  return token;
}
function safeEqual(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- second factor: an authenticator code, or a one-time backup code ----
const backupHash = code => sha256(String(code).toLowerCase().replace(/[^a-z0-9]/g, ''));
function checkSecondFactor(user, code) {
  code = String(code || '');
  if (/^\s*\d{3}\s?\d{3}\s*$/.test(code) && user.totp_secret) {
    const step = totp.verify(user.totp_secret, code, user.totp_last);
    if (step) { q.setTotpLast.run(step, user.id); return true; } // a code can only be used once
    return false;
  }
  return Number(q.useBackup.run(user.id, backupHash(code)).changes) > 0;
}
function newBackupCodes(userId) {
  q.delBackups.run(userId);
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const raw = crypto.randomBytes(5).toString('hex');
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5));
    q.insBackup.run(userId, backupHash(raw));
  }
  return codes;
}

// ---- login throttling (per IP) ----
const THROTTLE_MAX = parseInt(process.env.SKIPPY_THROTTLE || '10', 10);
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter(t => now - t < 60_000);
  attempts.set(ip, a);
  return a.length >= THROTTLE_MAX;
}
function noteAttempt(ip) { attempts.get(ip)?.push(Date.now()) ?? attempts.set(ip, [Date.now()]); }

// ---- state ----
const rooms = new Map(); // roomName -> Map(userId -> client)
const online = new Map(); // userId -> Set(client): everyone currently logged in
const calls = new Map();  // callId -> { from, fromConn, toId, timer }
const CALL_TIMEOUT_MS = parseInt(process.env.SKIPPY_CALL_TIMEOUT || '45000', 10);

// Direct calls happen in a private two-person room named after the pair of user ids.
const dmRoom = (a, b) => `@${Math.min(a, b)}-${Math.max(a, b)}`;
function dmAllowed(room, userId) {
  const m = /^@(\d+)-(\d+)$/.exec(room);
  return !!m && (Number(m[1]) === userId || Number(m[2]) === userId);
}

function broadcastPresence() {
  const users = [...online.values()].map(set => publicUser([...set][0].user));
  for (const set of online.values()) for (const c of set) send(c, { t: 'presence', users });
}
function goOnline(c) {
  if (!online.has(c.user.id)) online.set(c.user.id, new Set());
  online.get(c.user.id).add(c);
  broadcastPresence();
}
function goOffline(c) {
  if (!c.user) return;
  const set = online.get(c.user.id);
  if (set) { set.delete(c); if (!set.size) online.delete(c.user.id); }
  // drop any calls this connection was part of
  for (const [id, call] of [...calls]) {
    if (call.fromConn === c) finishCall(id, null, { t: 'call-cancelled', callId: id });
    else if (call.toId === c.user.id && !online.has(c.user.id))
      finishCall(id, { t: 'call-failed', msg: `${c.user.name} went offline.` }, null);
  }
  broadcastPresence();
}
function finishCall(id, callerMsg, calleeMsg) {
  const call = calls.get(id); if (!call) return;
  clearTimeout(call.timer); calls.delete(id);
  if (callerMsg) send(call.fromConn, callerMsg);
  if (calleeMsg) for (const t of online.get(call.toId) || []) send(t, calleeMsg);
}

function publicUser(u) { return { id: u.id, name: u.name, callsign: u.callsign || '' }; }
function send(c, obj) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); }
function normRoom(r) { return String(r || '').trim().slice(0, 60).toLowerCase(); }
function msgOut(m) {
  return { id: m.id, room: m.room, userId: m.user_id, name: m.name, ts: m.ts, kind: m.kind,
           text: m.text, fileName: m.file_name, fileSize: m.file_size };
}

function leaveRoom(c) {
  if (!c.room) return;
  const members = rooms.get(c.room);
  if (members && members.get(c.user.id) === c) {
    members.delete(c.user.id);
    for (const p of members.values()) send(p, { t: 'peer-left', id: c.user.id });
    if (members.size === 0) rooms.delete(c.room);
  }
  c.room = null;
}

function sendAuthed(c, user, token) {
  if (c.user) goOffline(c);
  c.user = user;
  send(c, { t: 'authed', user: publicUser(user), totp: !!user.totp_enabled, token, rooms: q.recentRooms.all(user.id).map(r => r.room) });
  goOnline(c);
}

function findUserForLogin(id) {
  return q.userByName.get(id) || q.userByEmail.get(id) || q.userByCall.get(id);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function handle(c, m) {
  switch (m.t) {
    case 'register': {
      if (throttled(c.ip)) return send(c, { t: 'error', msg: 'Too many attempts, wait a minute.' });
      const name = String(m.name || '').trim();
      const email = String(m.email || '').trim();
      const callsign = String(m.callsign || '').trim().toUpperCase() || null;
      const password = String(m.password || '');
      if (name.length < 2 || name.length > 40) return send(c, { t: 'error', msg: 'Name must be 2-40 characters.' });
      if (!EMAIL_RE.test(email)) return send(c, { t: 'error', msg: 'Enter a valid email address.' });
      if (callsign && !/^[A-Z0-9/]{3,12}$/.test(callsign)) return send(c, { t: 'error', msg: 'Callsign looks invalid.' });
      if (password.length < 8) return send(c, { t: 'error', msg: 'Password must be at least 8 characters.' });
      if (q.userByName.get(name) || q.userByEmail.get(email) || (callsign && q.userByCall.get(callsign)))
        return send(c, { t: 'error', msg: 'That name, email or callsign is already registered.' });
      noteAttempt(c.ip);
      const salt = crypto.randomBytes(16).toString('hex');
      const info = q.insUser.run(name, email, callsign, salt, hashPassword(password, salt), Date.now());
      const user = q.userById.get(Number(info.lastInsertRowid));
      return sendAuthed(c, user, newToken(user.id));
    }
    case 'login': {
      if (throttled(c.ip)) return send(c, { t: 'error', msg: 'Too many attempts, wait a minute.' });
      const user = findUserForLogin(String(m.id || '').trim());
      const password = String(m.password || '');
      if (!user || !safeEqual(user.hash, hashPassword(password, user.salt))) {
        noteAttempt(c.ip); // only failures count toward the throttle
        return send(c, { t: 'error', msg: 'Invalid login or password.' });
      }
      if (user.totp_enabled) {
        c.pendingTotp = { userId: user.id, expires: Date.now() + 5 * 60_000, fails: 0 };
        return send(c, { t: 'totp-required' });
      }
      return sendAuthed(c, user, newToken(user.id));
    }
    case 'login-totp': {
      if (throttled(c.ip)) return send(c, { t: 'error', msg: 'Too many attempts, wait a minute.' });
      const pend = c.pendingTotp;
      if (!pend || pend.expires < Date.now()) { c.pendingTotp = null; return send(c, { t: 'totp-expired' }); }
      const user = q.userById.get(pend.userId);
      if (user && checkSecondFactor(user, m.code)) { c.pendingTotp = null; return sendAuthed(c, user, newToken(user.id)); }
      noteAttempt(c.ip);
      if (++pend.fails >= 5) { c.pendingTotp = null; return send(c, { t: 'totp-expired' }); }
      return send(c, { t: 'error', msg: 'That code is not valid.' });
    }
    case 'resume': {
      const row = q.sessionUser.get(sha256(String(m.token || '')));
      const user = row && q.userById.get(row.user_id);
      if (!user) return send(c, { t: 'resume-failed' });
      return sendAuthed(c, user, String(m.token));
    }
  }

  if (!c.user) return send(c, { t: 'error', msg: 'Not logged in.' });

  switch (m.t) {
    case 'logout':
      leaveRoom(c);
      if (m.token) q.delSession.run(sha256(String(m.token)));
      goOffline(c);
      c.user = null;
      return send(c, { t: 'logged-out' });
    case 'join': {
      const room = normRoom(m.room);
      if (!room) return send(c, { t: 'error', msg: 'Enter a room name.' });
      if (room.startsWith('@') && !dmAllowed(room, c.user.id))
        return send(c, { t: 'error', msg: 'That is a private call room.' });
      leaveRoom(c);
      let members = rooms.get(room);
      if (!members) rooms.set(room, members = new Map());
      const existing = members.get(c.user.id);
      if (existing && existing !== c) { // same account joining from a second window: replace the old one
        leaveRoom(existing);
        send(existing, { t: 'kicked', msg: 'You joined this room from another window.' });
        members = rooms.get(room) || new Map();
        rooms.set(room, members);
      }
      if (members.size >= MAX_PARTICIPANTS)
        return send(c, { t: 'room-full', room, max: MAX_PARTICIPANTS });
      const peers = [...members.values()].map(p => publicUser(p.user));
      members.set(c.user.id, c);
      c.room = room;
      send(c, { t: 'joined', room, me: publicUser(c.user), peers, max: MAX_PARTICIPANTS,
                history: q.history.all(room, HISTORY_LIMIT).map(msgOut) });
      for (const p of members.values()) if (p !== c) send(p, { t: 'peer-joined', peer: publicUser(c.user) });
      return;
    }
    case 'leave': return leaveRoom(c);
    case 'totp-setup': {
      if (q.userById.get(c.user.id).totp_enabled) return send(c, { t: 'error', msg: 'Two-factor is already on.' });
      c.pendingSecret = totp.newSecret();
      return send(c, { t: 'totp-setup', secret: c.pendingSecret, uri: totp.otpauthUri(c.pendingSecret, c.user.name) });
    }
    case 'totp-enable': {
      if (!c.pendingSecret) return send(c, { t: 'error', msg: 'Start the setup again.' });
      if (throttled(c.ip)) return send(c, { t: 'error', msg: 'Too many attempts, wait a minute.' });
      const step = totp.verify(c.pendingSecret, m.code);
      if (!step) { noteAttempt(c.ip); return send(c, { t: 'error', msg: 'That code does not match - check your authenticator and try again.' }); }
      q.setTotp.run(c.pendingSecret, step, c.user.id);
      c.pendingSecret = null;
      return send(c, { t: 'totp-enabled', backupCodes: newBackupCodes(c.user.id) });
    }
    case 'totp-disable': {
      if (throttled(c.ip)) return send(c, { t: 'error', msg: 'Too many attempts, wait a minute.' });
      const user = q.userById.get(c.user.id);
      if (!user.totp_enabled) return send(c, { t: 'totp-disabled' });
      if (!safeEqual(user.hash, hashPassword(String(m.password || ''), user.salt)) || !checkSecondFactor(user, m.code)) {
        noteAttempt(c.ip);
        return send(c, { t: 'error', msg: 'Password or code is wrong.' });
      }
      q.clearTotp.run(user.id); q.delBackups.run(user.id);
      return send(c, { t: 'totp-disabled' });
    }
    case 'call': {
      const ident = String(m.to ?? '').trim();
      const target = typeof m.to === 'number' ? q.userById.get(m.to)
        : (q.userByName.get(ident) || q.userByCall.get(ident.toUpperCase()));
      if (!target) return send(c, { t: 'call-failed', msg: 'No user with that name or callsign.' });
      if (target.id === c.user.id) return send(c, { t: 'call-failed', msg: "You can't call yourself." });
      const conns = online.get(target.id);
      if (!conns || !conns.size) return send(c, { t: 'call-failed', msg: `${target.name} is not online.` });
      for (const x of calls.values()) if (x.fromConn === c) return send(c, { t: 'call-failed', msg: 'You are already calling someone.' });
      const callId = crypto.randomUUID();
      const timer = setTimeout(() => finishCall(callId,
        { t: 'call-failed', msg: `${target.name} did not answer.` }, { t: 'call-cancelled', callId }), CALL_TIMEOUT_MS);
      calls.set(callId, { from: c.user, fromConn: c, toId: target.id, timer });
      send(c, { t: 'calling', callId, to: publicUser(target) });
      for (const t of conns) send(t, { t: 'incoming-call', callId, from: publicUser(c.user) });
      return;
    }
    case 'call-cancel': {
      const call = calls.get(m.callId);
      if (call && call.fromConn === c) finishCall(m.callId, null, { t: 'call-cancelled', callId: m.callId });
      return;
    }
    case 'call-answer': {
      const call = calls.get(m.callId);
      if (!call || call.toId !== c.user.id) return;
      if (!m.accept) return finishCall(m.callId, { t: 'call-failed', msg: `${c.user.name} declined the call.` }, { t: 'call-cancelled', callId: m.callId });
      const room = dmRoom(call.from.id, c.user.id);
      clearTimeout(call.timer); calls.delete(m.callId);
      send(call.fromConn, { t: 'call-start', room, with: publicUser(c.user) });
      send(c, { t: 'call-start', room, with: publicUser(call.from) });
      for (const t of online.get(c.user.id) || []) if (t !== c) send(t, { t: 'call-cancelled', callId: m.callId });
      return;
    }
    case 'history': {
      const room = normRoom(m.room);
      return send(c, { t: 'history', room, history: q.history.all(room, HISTORY_LIMIT).map(msgOut) });
    }
    case 'chat':
    case 'file-announce': {
      if (!c.room) return;
      const isFile = m.t === 'file-announce';
      const text = isFile ? null : String(m.text || '').slice(0, MAX_CHAT_LEN);
      if (!isFile && !text.trim()) return;
      const ts = Date.now();
      const fileName = isFile ? String(m.fileName || '').slice(0, 200) : null;
      const fileSize = isFile ? Math.max(0, Number(m.fileSize) || 0) : null;
      const info = q.insMsg.run(c.room, c.user.id, c.user.name, ts, isFile ? 'file' : 'text', text, fileName, fileSize);
      const out = { t: 'chat', msg: { id: Number(info.lastInsertRowid), room: c.room, userId: c.user.id,
        name: c.user.name, ts, kind: isFile ? 'file' : 'text', text, fileName, fileSize,
        fileId: isFile ? String(m.fileId || '') : undefined } };
      for (const p of rooms.get(c.room).values()) send(p, out);
      return;
    }
    case 'signal': {
      if (!c.room) return;
      const target = rooms.get(c.room)?.get(Number(m.to));
      if (target) send(target, { t: 'signal', from: c.user.id, data: m.data });
      return;
    }
  }
}

// GET /update.json tells clients the newest app version. Edit update.json next to this file to announce a release:
// { "version": "1.2.0", "url": "https://where-to-download", "notes": "what changed" }
const UPDATE_FILE = process.env.SKIPPY_UPDATE_FILE || path.join(__dirname, 'update.json');
const server = http.createServer((req, res) => {
  if (req.url === '/update.json') {
    try {
      const body = fs.readFileSync(UPDATE_FILE, 'utf8');
      JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('No update information\n');
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Skippy server\n');
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
wss.on('error', () => {}); // listen errors are reported by server.on('error') below

wss.on('connection', (ws, req) => {
  const c = { ws, user: null, room: null, ip: req.socket.remoteAddress };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(c, m); } catch (e) { console.error('handler error', e); send(c, { t: 'error', msg: 'Server error.' }); }
  });
  ws.on('close', () => { leaveRoom(c); goOffline(c); });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20_000);

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use - the Skippy server is probably already running (maybe hidden in the background).`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, () => console.log(`Skippy server listening on :${PORT} (db: ${DB_PATH})`));
