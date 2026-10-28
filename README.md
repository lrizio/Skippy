# Skippy

Cross-platform group video conferencing (up to 10 participants), Skype-style.
Electron desktop app + a small Node server.

## What it does
- **Accounts**: register with name, email and optional callsign + password (8+ chars). Log in with *any* of name / email / callsign.
- **Remembers the last login**: the app signs straight back in as the last user on startup (session token kept encrypted via the OS keystore). **Log out** clears the token, returns to the login screen with the last name prefilled, and you can log in as someone else.
- **Rooms**: type a room name to create/join it. Hard cap of 10 per room (enforced by the server).
- **Audio/video devices**: choose microphone, camera and speaker in the lobby or live during a call; choices are remembered. Mute / stop-video buttons; hot-plugged devices are picked up.
- **Chat with history**: messages and file notices are stored per room on the server (last 200 shown on join).
- **File transfer**: the paperclip sends a file (max 200 MB) directly to everyone in the call over WebRTC data channels. Receivers get a Save link. Files are only delivered to people present at the time; history keeps the file *name*, not the content.

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
- **Security**: passwords are scrypt-hashed server-side. Over the internet, put the server behind TLS (e.g. a reverse proxy) and use `wss://` in the Server field - plain `ws://` sends the password unencrypted. Media is always DTLS-SRTP encrypted by WebRTC. There is no password reset yet.
- Settings file: `%APPDATA%\skippy\settings.json` (Windows).

## Tests
`server/test.js` - server integration test (auth, 10-person cap, history). Run: `cd server && node test.js`.
