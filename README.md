# Skippy

Cross-platform group video conferencing (up to 10 participants), Skype-style.
Electron desktop app + a small Node server.

## What it does
- **Accounts**: register with name, email and optional callsign + password (8+ chars). Log in with *any* of name / email / callsign.
- **Remembers the last login**: the app signs straight back in as the last user on startup (session token kept encrypted via the OS keystore). **Log out** clears the token, returns to the login screen with the last name prefilled, and you can log in as someone else.
- **Rooms**: type a room name to create/join it. Hard cap of 10 per room (enforced by the server).
- **Audio/video devices**: choose microphone, camera and speaker in the lobby or live during a call; choices are remembered. Mute / stop-video buttons; hot-plugged devices are picked up.
- **Chat with history**: messages and file notices are stored per room on the server (last 200 shown on join).
- **File transfer**: the paperclip sends a file (max **2 GB**) directly to everyone in the call over WebRTC data channels. Received files stream to a temp folder on disk (not memory); the Save link copies them where you choose. Files are only delivered to people present at the time; history keeps the file *name*, not the content.
- **Two-factor authentication (optional, per user)**: **🔒 Security** (lobby) turns on TOTP - scan the QR code with any authenticator app (Google/Microsoft Authenticator, Authy, 1Password…), confirm a code, and save the 10 one-time backup codes. After that, login asks for the password and then a 6-digit code (or a backup code). Auto-login on startup is unaffected (it uses the remembered session). Turning it off needs the password plus a code. A used code cannot be replayed, and 5 wrong codes cancel the login attempt. If someone loses their phone *and* backup codes, the host runs `node reset-totp.js <name or callsign>` in `server/`.
- **Direct calls**: **📞 Call someone** (lobby or in a call) lists who is online - click Call, or type a name/callsign. They get a ringing dialog (and the window pops up from the tray); Accept opens a private two-person room (with its own chat history). Rings for 45 s. You can only call people who are logged in.
- **Runs in the background**: closing the window or logging out hides Skippy to the system tray instead of quitting; click the tray icon to reopen, or use *Quit Skippy* there. While logged in it keeps its server connection, so calls still ring. Tick *Start Skippy when I sign in to this computer* (login screen or tray menu) to launch hidden at sign-in. (This is a tray app, not an OS service; logged-out users cannot receive calls.)
- **Version + updates**: the version is in the title bar and on the login screen. On startup the app asks the server for `/update.json`; if it announces a newer version a banner offers a download link. To announce a release, edit `server/update.json` (`version`, `url`, `notes`). Opt out with *Check for updates on startup*.

## Run it
1. Start the server: `Start Skippy Server.bat` (or `cd server && npm start`). Listens on port 8470, data in `server/skippy.db`.
2. Start the app: `Start Skippy.bat` (or `cd app && npm start`).
3. On the login screen, expand **Server** and set the server address (default `ws://localhost:8470`). Everyone must use the same server.

First time: `npm install` in both `server/` and `app/`, then `node app/node_modules/electron/install.js` if the Electron binary didn't download.

## Packaging
`cd app && npm run dist` builds an installer for the current OS (NSIS / dmg / AppImage+deb) via electron-builder.

## Things to know
- **Topology is a full mesh**: each participant sends video to each other participant. Fine for small groups; bitrate is lowered automatically as the room fills (800 kbps -> 400 -> 200 kbps per stream). 10 people on a weak uplink will struggle.
- **Internet use**: STUN (Google's public server) is configured by default, which handles most home NATs. Some networks need a TURN relay: add it to `iceServers` in the app's `settings.json` (in the Electron userData folder).
- **Security**: passwords are scrypt-hashed server-side. Authenticator secrets are stored in the server database (they must be readable to check codes), so the host can see them - 2FA protects against stolen passwords, not a malicious host. Over the internet, put the server behind TLS (e.g. a reverse proxy) and use `wss://` in the Server field - plain `ws://` sends the password unencrypted. Media is always DTLS-SRTP encrypted by WebRTC. There is no password reset yet.
- Direct-call rooms are private to the two users; the server rejects anyone else.
- Settings file: `%APPDATA%\skippy\settings.json` (Windows).

## Tests
`server/test.js` - server integration test (auth, 10-person cap, history). Run: `cd server && node test.js`.
