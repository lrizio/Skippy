'use strict';
// Host tool: issue a one-time password reset code for a user who forgot their password and lost their recovery key.
//   node reset-password.js <name | callsign | email>
// Give the printed code to the user (phone, message...). They choose "Forgot password?" in Skippy, enter their
// name and this code, and pick a new password. The code works once and expires after one hour.
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ident = process.argv[2];
if (!ident) { console.error('Usage: node reset-password.js <name, callsign or email>'); process.exit(1); }
const db = new DatabaseSync(process.env.SKIPPY_DB || path.join(__dirname, 'skippy.db'));
const user = db.prepare('SELECT id, name FROM users WHERE name = ? OR callsign = ? OR email = ?').get(ident, ident.toUpperCase(), ident);
if (!user) { console.error(`No user "${ident}".`); process.exit(1); }

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let raw = '';
for (const b of crypto.randomBytes(8)) raw += ALPHABET[b % 32];
const hash = crypto.createHash('sha256').update(raw).digest('hex');
db.prepare('UPDATE users SET reset_hash = ?, reset_expires = ? WHERE id = ?').run(hash, Date.now() + 3600_000, user.id);
console.log(`One-time reset code for ${user.name} (valid for 1 hour):\n\n    ${raw.slice(0, 4)}-${raw.slice(4)}\n`);
console.log('They enter their name and this code under "Forgot password?" on the Skippy login screen.');
