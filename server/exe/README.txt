Skippy server (Windows, no installation needed)
===============================================
Nothing else to install - Skippy-Server.exe already contains everything it needs.

Start it:
  - "Start Skippy Server.bat"  : keep that window OPEN - closing it stops the server.
  - "Run Skippy Server in Background.bat" : runs hidden, starts when you sign in to Windows,
    restarts if it crashes. "Stop Skippy Server Background.bat" turns that off.

Port 8470 (set the PORT environment variable to change). A built-in media relay (TURN) also listens on UDP 3478 so
two phones on different networks can call each other; allow it in Windows Firewall too (SKIPPY_TURN=0 turns it off,
SKIPPY_TURN_PORT / SKIPPY_TURN_IP change it; by default it advertises this PC's Tailscale address). Accounts are kept in skippy.db next to the .exe -
back that file up. Log (background mode): server.log

Helper commands (run in a command window opened in this folder):
  Skippy-Server.exe reset-password "name or callsign or email"   one-time code (1 hour) for a forgotten password
  Skippy-Server.exe reset-totp "name or callsign"                turn off two-factor for a lost authenticator

Windows may show a SmartScreen "unknown publisher" warning the first time (the file is not code-signed):
choose More info > Run anyway. Windows Firewall will also ask whether to allow it - allow it.
To announce a new app release to clients: copy update.json.example to update.json and edit it.
Over the internet use Tailscale, or put it behind TLS and use wss:// in the app.
https://github.com/lrizio/Skippy
