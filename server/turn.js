'use strict';
// A small built-in TURN relay (RFC 5766, UDP only) so two people who cannot reach each other directly - for example two
// phones on different mobile networks - can still call: their media is relayed through this server.
// Clients get time-limited credentials from the Skippy server after they log in (TURN REST API style), so only
// logged-in users can use the relay.
//
// Settings (environment variables):
//   SKIPPY_TURN=0          turn the relay off
//   SKIPPY_TURN_PORT=3478  UDP port the relay listens on
//   SKIPPY_TURN_IP=a.b.c.d address handed to peers as the relay address. Default: this machine's Tailscale
//                          address (100.64.0.0/10) if it has one, otherwise its first LAN address. Set it to your
//                          public address if you use the server over the internet without Tailscale.
const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');

const MAGIC = 0x2112A442;
const REALM = 'skippy';
const M = { BINDING: 1, ALLOCATE: 3, REFRESH: 4, SEND: 6, DATA: 7, CREATE_PERMISSION: 8, CHANNEL_BIND: 9 };
const CLS = { REQUEST: 0, INDICATION: 1, SUCCESS: 2, ERROR: 3 };
const A = {
  MAPPED: 0x0001, USERNAME: 0x0006, INTEGRITY: 0x0008, ERROR_CODE: 0x0009, CHANNEL_NUMBER: 0x000C, LIFETIME: 0x000D,
  XOR_PEER: 0x0012, DATA: 0x0013, REALM: 0x0014, NONCE: 0x0015, XOR_RELAYED: 0x0016, REQ_TRANSPORT: 0x0019,
  XOR_MAPPED: 0x0020, SOFTWARE: 0x8022,
};
const DEFAULT_LIFETIME = 600, MAX_LIFETIME = 3600, PERMISSION_LIFETIME = 300, CHANNEL_LIFETIME = 600;
const CRED_TTL = 30 * 24 * 3600; // seconds a handed-out credential stays valid

const typeOf = (method, cls) =>
  (method & 0x000F) | ((method & 0x0070) << 1) | ((method & 0x0F80) << 2) | ((cls & 1) << 4) | ((cls & 2) << 7);
const splitType = t => ({ cls: ((t >> 4) & 1) | ((t >> 7) & 2), method: (t & 0xF) | ((t >> 1) & 0x70) | ((t >> 2) & 0xF80) });

function parse(buf) {
  if (buf.length < 20 || (buf[0] & 0xC0) !== 0 || buf.readUInt32BE(4) !== MAGIC) return null;
  const len = buf.readUInt16BE(2);
  if (len % 4 || 20 + len > buf.length) return null;
  const { cls, method } = splitType(buf.readUInt16BE(0));
  const attrs = new Map(), list = [];
  let off = 20;
  while (off + 4 <= 20 + len) {
    const type = buf.readUInt16BE(off), alen = buf.readUInt16BE(off + 2);
    if (off + 4 + alen > 20 + len) return null;
    const val = buf.subarray(off + 4, off + 4 + alen);
    if (!attrs.has(type)) attrs.set(type, val);
    list.push({ type, off });
    off += 4 + ((alen + 3) & ~3);
  }
  return { cls, method, txid: buf.subarray(8, 20), attrs, list, raw: buf, len };
}

function xorAddr(ip, port) {
  const b = Buffer.alloc(8);
  b[1] = 1; b.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const o = ip.split('.').map(Number);
  const m = Buffer.alloc(4); m.writeUInt32BE(MAGIC);
  for (let i = 0; i < 4; i++) b[4 + i] = o[i] ^ m[i];
  return b;
}
function readXorAddr(v) {
  if (!v || v.length < 8 || v[1] !== 1) return null; // IPv4 only
  const m = Buffer.alloc(4); m.writeUInt32BE(MAGIC);
  const ip = [0, 1, 2, 3].map(i => v[4 + i] ^ m[i]).join('.');
  return { ip, port: v.readUInt16BE(2) ^ (MAGIC >>> 16) };
}
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

function build(method, cls, txid, attrs, key) {
  const parts = [];
  for (const [type, val] of attrs) {
    const h = Buffer.alloc(4); h.writeUInt16BE(type, 0); h.writeUInt16BE(val.length, 2);
    parts.push(h, val, Buffer.alloc((4 - val.length % 4) % 4));
  }
  let body = Buffer.concat(parts);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(typeOf(method, cls), 0); header.writeUInt32BE(MAGIC, 4); txid.copy(header, 8);
  if (key) { // MESSAGE-INTEGRITY covers the message with the length field already counting the integrity attribute
    header.writeUInt16BE(body.length + 24, 2);
    const mac = crypto.createHmac('sha1', key).update(Buffer.concat([header, body])).digest();
    const h = Buffer.alloc(4); h.writeUInt16BE(A.INTEGRITY, 0); h.writeUInt16BE(20, 2);
    body = Buffer.concat([body, h, mac]);
  }
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}
const errAttr = (code, text) => {
  const t = Buffer.from(text), b = Buffer.alloc(4 + t.length);
  b[2] = Math.floor(code / 100); b[3] = code % 100; t.copy(b, 4);
  return [A.ERROR_CODE, b];
};

function checkIntegrity(msg, key) {
  const mi = msg.list.find(a => a.type === A.INTEGRITY);
  if (!mi) return false;
  const head = Buffer.from(msg.raw.subarray(0, mi.off));
  const copy = Buffer.concat([Buffer.from(msg.raw.subarray(0, 20)), head.subarray(20)]);
  copy.writeUInt16BE(mi.off - 20 + 24, 2); // length as if the message ended right after the integrity attribute
  const mac = crypto.createHmac('sha1', key).update(copy).digest();
  const got = msg.raw.subarray(mi.off + 4, mi.off + 24);
  return got.length === 20 && crypto.timingSafeEqual(mac, got);
}

function pickRelayIp() {
  if (process.env.SKIPPY_TURN_IP) return process.env.SKIPPY_TURN_IP;
  let lan = null;
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const [x, y] = a.address.split('.').map(Number);
    if (x === 100 && y >= 64 && y <= 127) return a.address; // Tailscale
    if (!lan) lan = a.address;
  }
  return lan || '127.0.0.1';
}

function start(log = console.log) {
  if (process.env.SKIPPY_TURN === '0') return null;
  const port = parseInt(process.env.SKIPPY_TURN_PORT || '3478', 10);
  const relayIp = pickRelayIp();
  const secret = crypto.randomBytes(32); // new every start: credentials from before a restart simply stop working
  const sock = dgram.createSocket('udp4');
  const allocs = new Map(); // "ip:port" of the client -> allocation
  const now = () => Math.floor(Date.now() / 1000);

  const nonce = () => { const t = String(now()); return `${t}-${crypto.createHmac('sha1', secret).update(t).digest('hex').slice(0, 20)}`; };
  const nonceState = n => { // 'ok' | 'stale' | 'bad'
    const [t, h] = String(n).split('-');
    if (!t || !h || crypto.createHmac('sha1', secret).update(t).digest('hex').slice(0, 20) !== h) return 'bad';
    return now() - Number(t) > 3600 ? 'stale' : 'ok';
  };
  const passwordFor = user => crypto.createHmac('sha1', secret).update(user).digest('base64');

  function credentials() {
    const username = `${now() + CRED_TTL}:skippy`;
    return { port, username, credential: passwordFor(username), ttl: CRED_TTL };
  }

  const reply = (rinfo, method, cls, txid, attrs, key) => sock.send(build(method, cls, txid, attrs, key), rinfo.port, rinfo.address);

  function dropAlloc(id) {
    const a = allocs.get(id); if (!a) return;
    try { a.sock.close(); } catch { /* already closed */ }
    allocs.delete(id);
  }

  // Authenticate a request: returns the long-term key or null after sending the 401/438 reply.
  function authenticate(msg, rinfo) {
    const challenge = (code, text) => reply(rinfo, msg.method, CLS.ERROR, msg.txid,
      [errAttr(code, text), [A.REALM, Buffer.from(REALM)], [A.NONCE, Buffer.from(nonce())]]);
    const user = msg.attrs.get(A.USERNAME), n = msg.attrs.get(A.NONCE);
    if (!user || !n || !msg.attrs.has(A.INTEGRITY)) { challenge(401, 'Unauthorized'); return null; }
    const ns = nonceState(n.toString());
    if (ns === 'bad') { challenge(401, 'Unauthorized'); return null; }
    if (ns === 'stale') { challenge(438, 'Stale Nonce'); return null; }
    const name = user.toString();
    const exp = Number(name.split(':')[0]);
    if (!(exp > now())) { challenge(401, 'Unauthorized'); return null; }
    const key = crypto.createHash('md5').update(`${name}:${REALM}:${passwordFor(name)}`).digest();
    if (!checkIntegrity(msg, key)) { challenge(401, 'Unauthorized'); return null; }
    return key;
  }

  function onRelayData(a, data, from) {
    const t = now();
    const perm = a.perms.get(from.address);
    if (!perm || perm < t) return; // peers must have been allowed first
    const ch = a.peerChannel.get(`${from.address}:${from.port}`);
    if (ch && ch.exp > t) {
      const hdr = Buffer.alloc(4); hdr.writeUInt16BE(ch.num, 0); hdr.writeUInt16BE(data.length, 2);
      sock.send(Buffer.concat([hdr, data, Buffer.alloc((4 - data.length % 4) % 4)]), a.client.port, a.client.address);
    } else {
      sock.send(build(M.DATA, CLS.INDICATION, crypto.randomBytes(12),
        [[A.XOR_PEER, xorAddr(from.address, from.port)], [A.DATA, data]]), a.client.port, a.client.address);
    }
  }

  function handle(buf, rinfo) {
    if (process.env.SKIPPY_TURN_DEBUG) { const t = buf.length >= 2 ? splitType(buf.readUInt16BE(0)) : {}; log(`TURN rx ${buf.length}B from ${rinfo.address}:${rinfo.port} method=${t.method} class=${t.cls}`); }
    const id = `${rinfo.address}:${rinfo.port}`;
    // ChannelData from the client: forward to the peer bound to that channel
    if (buf.length >= 4 && (buf[0] & 0xC0) === 0x40) {
      const a = allocs.get(id); if (!a) return;
      const num = buf.readUInt16BE(0), len = buf.readUInt16BE(2);
      const peer = a.channelPeer.get(num);
      if (peer && peer.exp > now() && 4 + len <= buf.length) a.sock.send(buf.subarray(4, 4 + len), peer.port, peer.ip);
      return;
    }
    const msg = parse(buf); if (!msg) return;
    if (msg.cls === CLS.INDICATION) {
      if (msg.method !== M.SEND) return;
      const a = allocs.get(id), peer = readXorAddr(msg.attrs.get(A.XOR_PEER)), data = msg.attrs.get(A.DATA);
      if (!a || !peer || !data) return;
      const p = a.perms.get(peer.ip);
      if (p && p >= now()) a.sock.send(data, peer.port, peer.ip);
      return;
    }
    if (msg.cls !== CLS.REQUEST) return;

    if (msg.method === M.BINDING) {
      return reply(rinfo, M.BINDING, CLS.SUCCESS, msg.txid, [[A.XOR_MAPPED, xorAddr(rinfo.address, rinfo.port)]]);
    }
    if (![M.ALLOCATE, M.REFRESH, M.CREATE_PERMISSION, M.CHANNEL_BIND].includes(msg.method)) {
      return reply(rinfo, msg.method, CLS.ERROR, msg.txid, [errAttr(400, 'Bad Request')]);
    }
    const key = authenticate(msg, rinfo); if (!key) return;
    const ok = attrs => reply(rinfo, msg.method, CLS.SUCCESS, msg.txid, attrs, key);
    const fail = (code, text) => reply(rinfo, msg.method, CLS.ERROR, msg.txid, [errAttr(code, text)], key);
    let a = allocs.get(id);

    if (msg.method === M.ALLOCATE) {
      if (a) return fail(437, 'Allocation Mismatch');
      const rt = msg.attrs.get(A.REQ_TRANSPORT);
      if (!rt || rt[0] !== 17) return fail(442, 'Unsupported Transport Protocol');
      const rs = dgram.createSocket('udp4');
      rs.on('error', () => { /* ICMP unreachable from a vanished peer etc. */ });
      rs.bind(0, () => {
        const lifetime = DEFAULT_LIFETIME;
        a = { client: { address: rinfo.address, port: rinfo.port }, sock: rs, relayPort: rs.address().port,
              exp: now() + lifetime, perms: new Map(), channelPeer: new Map(), peerChannel: new Map() };
        allocs.set(id, a);
        rs.on('message', (d, from) => onRelayData(a, d, from));
        ok([[A.XOR_RELAYED, xorAddr(relayIp, a.relayPort)], [A.LIFETIME, u32(lifetime)],
            [A.XOR_MAPPED, xorAddr(rinfo.address, rinfo.port)]]);
      });
      return;
    }
    if (!a) return fail(437, 'Allocation Mismatch');
    if (msg.method === M.REFRESH) {
      const req = msg.attrs.get(A.LIFETIME);
      const lifetime = req ? Math.min(req.readUInt32BE(0), MAX_LIFETIME) : DEFAULT_LIFETIME;
      if (lifetime === 0) { dropAlloc(id); return ok([[A.LIFETIME, u32(0)]]); }
      a.exp = now() + lifetime;
      return ok([[A.LIFETIME, u32(lifetime)]]);
    }
    if (msg.method === M.CREATE_PERMISSION) {
      let any = false;
      for (const x of msg.list) if (x.type === A.XOR_PEER) {
        const alen = msg.raw.readUInt16BE(x.off + 2);
        const peer = readXorAddr(msg.raw.subarray(x.off + 4, x.off + 4 + alen));
        if (!peer) return fail(400, 'Bad Request');
        a.perms.set(peer.ip, now() + PERMISSION_LIFETIME); any = true;
      }
      return any ? ok([]) : fail(400, 'Bad Request');
    }
    if (msg.method === M.CHANNEL_BIND) {
      const cn = msg.attrs.get(A.CHANNEL_NUMBER), peer = readXorAddr(msg.attrs.get(A.XOR_PEER));
      if (!cn || !peer) return fail(400, 'Bad Request');
      const num = cn.readUInt16BE(0);
      if (num < 0x4000 || num > 0x7FFE) return fail(400, 'Bad Request');
      const pk = `${peer.ip}:${peer.port}`, old = a.channelPeer.get(num);
      if (old && `${old.ip}:${old.port}` !== pk && old.exp > now()) return fail(400, 'Bad Request');
      const prev = a.peerChannel.get(pk);
      if (prev && prev.num !== num && prev.exp > now()) return fail(400, 'Bad Request');
      const exp = now() + CHANNEL_LIFETIME;
      a.channelPeer.set(num, { ip: peer.ip, port: peer.port, exp });
      a.peerChannel.set(pk, { num, exp });
      a.perms.set(peer.ip, now() + PERMISSION_LIFETIME);
      return ok([]);
    }
  }

  sock.on('message', (buf, rinfo) => { try { handle(buf, rinfo); } catch (e) { if (process.env.SKIPPY_TURN_DEBUG) log('TURN error: ' + e.stack); } });
  sock.on('error', e => { log(`TURN relay stopped: ${e.message}`); try { sock.close(); } catch { /* */ } });
  sock.bind(port, () => log(`TURN relay listening on UDP :${port} (relay address ${relayIp})`));
  setInterval(() => { for (const [id, a] of allocs) if (a.exp < now()) dropAlloc(id); }, 30000).unref();
  return { credentials, port, relayIp, close: () => { for (const id of [...allocs.keys()]) dropAlloc(id); sock.close(); } };
}

module.exports = { start };
