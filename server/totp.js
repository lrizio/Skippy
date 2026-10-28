'use strict';
// RFC 6238 time-based one-time passwords (HMAC-SHA1, 30 s step, 6 digits) - what authenticator apps use.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

const newSecret = () => base32Encode(crypto.randomBytes(20));
const codeAt = (secret, timeMs = Date.now(), digits = 6) => hotp(base32Decode(secret), Math.floor(timeMs / STEP_MS), digits);

// Returns the matched time step (so the caller can refuse to accept it twice), or 0 for no match.
// Accepts one step either side to tolerate clock drift.
function verify(secret, code, lastStep = 0, timeMs = Date.now()) {
  const given = Buffer.from(String(code).replace(/\s/g, ''));
  const key = base32Decode(secret);
  const now = Math.floor(timeMs / STEP_MS);
  for (const d of [0, -1, 1]) {
    const step = now + d;
    if (step <= lastStep) continue;
    const want = Buffer.from(hotp(key, step));
    if (want.length === given.length && crypto.timingSafeEqual(want, given)) return step;
  }
  return 0;
}

function otpauthUri(secret, account, issuer = 'Skippy') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

module.exports = { newSecret, codeAt, verify, otpauthUri, base32Encode, base32Decode, hotp };
