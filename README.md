# Skippy

Group video calls for up to 10 people - audio, video, chat with history, file transfer and direct calls.
Desktop app for Windows (installer provided), macOS and Linux (build from source), plus a small server you run for your group.

## Download and install

1. **Install the app** - download `Skippy-Setup-<version>.exe` from the [latest release](https://github.com/lrizio/Skippy/releases/latest) and run it.
   Windows SmartScreen will say "unknown publisher" because the installer isn't code-signed: click *More info -> Run anyway*.
2. **Get a server** - one person per group runs the Skippy server (everyone else just connects to it):
   - **Windows, easiest:** download `Skippy-Server-Windows-<version>.zip` from the release, unzip it and double-click `Start Skippy Server.bat` (or `Run Skippy Server in Background.bat` to run it hidden). No Node.js needed - `Skippy-Server.exe` has everything inside. Same SmartScreen note as above.
   - **Any OS (or if you prefer Node):**
   - Install [Node.js 22.13 or newer](https://nodejs.org/) (24+ recommended).
   - Download `Skippy-Server-<version>.zip` from the same release, unzip it, and in that folder run:
     ```
     npm install
     node server.js
     ```
     (on Windows you can then use `Start Skippy Server.bat`). It listens on port 8470 and keeps its data in `skippy.db`.
   - **Keep that window open** - closing it stops the server. To avoid that trap, double-click `Run Skippy Server in Background.bat` instead: it runs the server hidden, starts it whenever you sign in to Windows and restarts it if it crashes (log in `server.log`). `Stop Skippy Server Background.bat` undoes it.
   - Everyone must be able to reach that machine: same LAN, a VPN such as Tailscale, or port 8470 forwarded on the router.
3. **First run** - start Skippy, open **Server** on the login screen, enter the server address (`ws://<host-ip>:8470`), choose **Create account**, log in, pick your camera/microphone and join a room.

Full instructions with screenshots: **[Skippy User Guide (PDF)](docs/Skippy%20User%20Guide.pdf)**, also attached to each release.

macOS/Linux: build the app yourself (`cd app && npm install && npm run dist` on that OS).

## What it does
- **Accounts**: register with name, email and optional callsign + password (8+ chars). Log in with *any* of name / email / callsign.
- **Remembers the last login**: the app signs straight back in as the last user on startup (session token kept encrypted via the OS keystore). **Log out** clears the token, returns to the login screen with the last name prefilled, and you can log in as someone else.
- **Rooms**: type a room name to create/join it. Hard cap of 10 per room (enforced by the server).
- **Audio/video devices**: choose microphone, camera and speaker in the lobby or live during a call; choices are remembered. Mute / stop-video buttons; hot-plugged devices are picked up.
- **Clickable links**: web addresses in chat open in the default browser.
- **Chat with history**: messages and file notices are stored per room on the server (last 200 shown on join).
- **File transfer**: the paperclip sends a file (max **2 GB**) directly to everyone in the call over WebRTC data channels. Received files stream to a temp folder on disk (not memory); the Save link copies them where you choose. Files are only delivered to people present at the time; history keeps the file *name*, not the content.
- **Two-factor authentication (optional, per user)**: **🔒 Security** (lobby) turns on TOTP - scan the QR code with any authenticator app (Google/Microsoft Authenticator, Authy, 1Password…), confirm a code, and save the 10 one-time backup codes. After that, login asks for the password and then a 6-digit code (or a backup code). Auto-login on startup is unaffected (it uses the remembered session). Turning it off needs the password plus a code. A used code cannot be replayed, and 5 wrong codes cancel the login attempt. If someone loses their phone *and* backup codes, the host runs `node reset-totp.js <name or callsign>` in `server/`.
- **Password recovery**: every new account is shown a one-time **recovery key** (save it in a password manager). On the login screen, **Forgot password?** takes your name plus that key and lets you choose a new password (other devices are signed out and you get a fresh key; two-factor still applies). If the key is lost, the server owner runs `node reset-password.js <name>` in the server folder to print a one-time code (valid 1 hour) that works the same way. Accounts that pre-date this can make a key under **Security**.
- **Mute and call clock**: calls start with your microphone on (a lobby option makes them start muted), every video window shows a microphone / muted symbol, the control strip sits at the top of the call screen, and a clock in the header shows how long you have been connected.
- **Screen sharing**: "Share screen" lets you pick a screen or window to show everyone instead of your camera.
- **Free-floating video windows**: drag any window to move it (put one participant above another) and drag its edges or corners to resize it; "Reset layout" tiles them again, double-click fills the call area. The chat can be hidden or resized, and all call controls sit in the title bar.
- **Full screen**: a button on every video window (shared screens too); Esc to leave. Your own tile shows a placeholder while you share, so Skippy never mirrors itself.
- **Clean installs**: the Windows installer closes any running Skippy and removes the previous version first.
- **Who is online**: the lobby lists everyone logged in, with a Call button each. In a call, the title bar is right-justified with a large call timer just before the buttons.
- **Rooms in use / Add someone**: the lobby lists every named room that has people in it (click to join; private direct calls are never listed). Inside a call, **➕ Add someone** rings a person and brings them into the call you are already in (up to 10); people added to a private call only see chat from after they joined.
- **Direct messages**: **💬 Messages** (lobby or call screen, or the *Message* button next to anyone online) sends a text to one person without a call. Messages are stored on the server; if the person is offline they find them (with an unread badge) at next login, and online people get a chime and a desktop notification. Opening a conversation marks it read. Chat typed inside a direct call is the same conversation.
- **Direct calls**: **📞 Call someone** (lobby or in a call) lists who is online - click Call, or type a name/callsign. They get a ringing dialog (and the window pops up from the tray); Accept opens a private two-person room (with its own chat history). Rings for 45 s. You can only call people who are logged in.
- **Missed calls**: calls you didn't answer (rang out, caller hung up first, or you were offline) are kept on the server and listed under **Missed calls** on the lobby screen with the caller and time. **Call back** rings them, ✕ dismisses one, **Clear all** empties the list (last 50 are kept).
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
- **Security**: passwords are scrypt-hashed server-side. Authenticator secrets are stored in the server database (they must be readable to check codes), so the host can see them - 2FA protects against stolen passwords, not a malicious host. Over the internet, put the server behind TLS (e.g. a reverse proxy) and use `wss://` in the Server field - plain `ws://` sends the password unencrypted. Media is always DTLS-SRTP encrypted by WebRTC.
- Direct-call rooms are private to the two users; the server rejects anyone else.
- Settings file: `%APPDATA%\skippy\settings.json` (Windows).

## Tests
`server/test.js` - server integration test (auth, 10-person cap, history). Run: `cd server && node test.js`.
