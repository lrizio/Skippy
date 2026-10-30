'use strict';
// Entry point of the packaged Skippy-Server.exe:
//   Skippy-Server.exe                              run the server
//   Skippy-Server.exe reset-password <name>        print a one-time password reset code
//   Skippy-Server.exe reset-totp <name>            turn off two-factor for a user
const cmd = process.argv[2];
if (cmd === 'reset-password' || cmd === 'reset-totp') {
  process.argv.splice(2, 1); // leave the user name as argv[2], as the standalone scripts expect
  if (cmd === 'reset-password') require('./reset-password.js'); else require('./reset-totp.js');
} else {
  require('./server.js');
}
