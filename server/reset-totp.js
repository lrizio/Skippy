'use strict';
// Host tool: turn off two-factor for a user who lost their authenticator and backup codes.
//   node reset-totp.js <name | callsign>
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ident = process.argv[2];
if (!ident) { console.error('Usage: node reset-totp.js <name or callsign>'); process.exit(1); }
const db = new DatabaseSync(process.env.SKIPPY_DB || path.join(require('./home'), 'skippy.db'));
const user = db.prepare('SELECT id, name FROM users WHERE name = ? OR callsign = ?').get(ident, ident.toUpperCase());
if (!user) { console.error(`No user "${ident}".`); process.exit(1); }
db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last = 0 WHERE id = ?').run(user.id);
db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(user.id);
console.log(`Two-factor authentication turned off for ${user.name}. They can enable it again from Security.`);
