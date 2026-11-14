'use strict';
const { app, BrowserWindow, ipcMain, session, safeStorage, shell, Tray, Menu, nativeImage, dialog, desktopCapturer, systemPreferences } = require('electron');
const fs = require('fs');
const QRCode = require('qrcode');
const path = require('path');
const recorder = require('./recorder');

const DEFAULTS = {
  serverUrl: 'ws://localhost:8470',
  lastLogin: '',
  devices: { mic: '', cam: '', spk: '' },
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  bounds: { width: 1280, height: 800 },
};

const ICON = path.join(__dirname, 'icon.png');
const IS_MAC = process.platform === 'darwin';
// Linux: let Chromium use the PipeWire/portal screen-capture path so screen sharing also works under Wayland.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
// macOS login items cannot pass arguments, so ask the OS whether we were opened at login instead.
const startHidden = process.argv.includes('--hidden') || (IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin);

let settingsFile;
let settings = { ...DEFAULTS };
let win = null;
let tray = null;
let quitting = false;

function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* first run */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { console.error(e); }
}

// The session token is encrypted with the OS keystore when available.
function readToken() {
  if (!settings.token) return '';
  try {
    if (settings.tokenEnc && safeStorage.isEncryptionAvailable())
      return safeStorage.decryptString(Buffer.from(settings.token, 'base64'));
    return settings.tokenEnc ? '' : settings.token;
  } catch { return ''; }
}
function writeToken(token) {
  if (!token) { delete settings.token; delete settings.tokenEnc; return; }
  if (safeStorage.isEncryptionAvailable()) {
    settings.token = safeStorage.encryptString(token).toString('base64');
    settings.tokenEnc = true;
  } else {
    settings.token = token;
    settings.tokenEnc = false;
  }
}

// ---- start at OS login (hidden, straight to the tray) ----
function getAutostart() { return app.getLoginItemSettings().openAtLogin; }
function setAutostart(on) {
  if (IS_MAC) app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true });
  else app.setLoginItemSettings({
    openAtLogin: !!on,
    path: process.execPath,
    args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'],
  });
  refreshTrayMenu();
}

// ---- window / tray ----
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function hideToTray() { win?.hide(); }  // 'hide' event below drops the Dock icon on macOS

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Skippy', click: showWindow },
    { type: 'checkbox', label: 'Start when I sign in to this computer', checked: getAutostart(), click: i => setAutostart(i.checked) },
    { type: 'separator' },
    { label: 'Quit Skippy', click: () => { quitting = true; app.quit(); } },
  ]));
}
function createTray() {
  // On a Mac the menu-bar icon is 18 px and the Dock icon is hidden while the window is hidden (see hideToTray).
  const sz = IS_MAC ? 18 : 16;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: sz, height: sz }));
  tray.setToolTip('Skippy');
  tray.on('click', showWindow);
  refreshTrayMenu();
}

// ---- received files are streamed to a temp folder, never held in memory ----
const incomingDir = () => path.join(app.getPath('userData'), 'incoming');
const incoming = new Map(); // fileId -> { fd, file, written }
const ID_RE = /^[0-9a-f-]{36}$/i;

function clearIncoming() {
  for (const f of incoming.values()) try { fs.closeSync(f.fd); } catch { /* ignore */ }
  incoming.clear();
  try { fs.rmSync(incomingDir(), { recursive: true, force: true }); } catch { /* ignore */ }
}

ipcMain.handle('file:open', (_e, id) => {
  if (!ID_RE.test(id)) return false;
  fs.mkdirSync(incomingDir(), { recursive: true });
  const file = path.join(incomingDir(), id);
  incoming.set(id, { fd: fs.openSync(file, 'w'), file, written: 0 });
  return true;
});
ipcMain.on('file:write', (_e, id, data) => {
  const f = incoming.get(id);
  if (!f) return;
  const buf = Buffer.from(data);
  fs.writeSync(f.fd, buf, 0, buf.length, f.written);
  f.written += buf.length;
});
ipcMain.handle('file:close', (_e, id) => {
  const f = incoming.get(id);
  if (!f) return 0;
  fs.closeSync(f.fd);
  f.fd = null;
  return f.written;
});
ipcMain.handle('file:discard', (_e, id) => {
  const f = incoming.get(id);
  if (!f) return;
  if (f.fd !== null) try { fs.closeSync(f.fd); } catch { /* ignore */ }
  try { fs.rmSync(f.file, { force: true }); } catch { /* ignore */ }
  incoming.delete(id);
});
ipcMain.handle('file:save', async (_e, id, name) => {
  const f = incoming.get(id);
  if (!f || f.fd !== null) return { ok: false, error: 'File is not available.' };
  const defaultPath = path.join(app.getPath('downloads'), path.basename(String(name)));
  const r = await dialog.showSaveDialog(win, { defaultPath });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try { await fs.promises.copyFile(f.file, r.filePath); return { ok: true, path: r.filePath }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---- settings / window IPC ----
ipcMain.handle('settings:load', () => {
  const { token, tokenEnc, ...rest } = settings;
  return { ...rest, token: readToken(), version: app.getVersion(), autostart: getAutostart() };
});
ipcMain.handle('settings:save', (_e, patch) => {
  if (patch && typeof patch === 'object') {
    if ('token' in patch) { writeToken(patch.token); delete patch.token; }
    Object.assign(settings, patch);
    saveSettings();
  }
});
ipcMain.handle('autostart:set', (_e, on) => setAutostart(on));
// Newest-version lookup: the Skippy server's /update.json wins (a host can announce their own build);
// otherwise ask the public GitHub releases.
const GITHUB_REPO = 'lrizio/Skippy';
async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Skippy', Accept: 'application/json' } });
  return r.ok ? r.json() : null;
}
ipcMain.handle('update:check', async (_e, wsUrl) => {
  try {
    const u = new URL(String(wsUrl));
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/update.json'; u.search = '';
    const j = await fetchJson(u);
    if (j && j.version) return { version: String(j.version), url: String(j.url || ''), notes: String(j.notes || '') };
  } catch { /* server unreachable or no update info: try GitHub */ }
  try {
    const j = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (j && j.tag_name) return { version: String(j.tag_name).replace(/^v/, ''), url: String(j.html_url || ''), notes: '' };
  } catch { /* offline */ }
  return null;
});
// Tailscale check: ask the local Tailscale CLI whether it is connected.
// Returns 'running' | 'stopped' | 'needs-login' | 'not-installed' | 'unknown'.
function tailscaleExe() {
  if (process.platform === 'darwin') {
    // The Mac App Store / standalone app bundles its CLI inside the app; Homebrew puts one on the PATH.
    for (const p of ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']) if (fs.existsSync(p)) return p;
    return 'tailscale';
  }
  if (process.platform !== 'win32') return 'tailscale';
  const p = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Tailscale', 'tailscale.exe');
  return fs.existsSync(p) ? p : 'tailscale';
}
function runTailscale(args) {
  return new Promise(resolve => {
    require('child_process').execFile(tailscaleExe(), args, { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ err, stdout: String(stdout || '') }));
  });
}
ipcMain.handle('tailscale:status', async () => {
  const { err, stdout } = await runTailscale(['status', '--json']);
  if (err && err.code === 'ENOENT') return 'not-installed';
  try {
    const st = JSON.parse(stdout).BackendState;
    if (st === 'Running') return 'running';
    if (st === 'NeedsLogin' || st === 'NeedsMachineAuth') return 'needs-login';
    if (st === 'NoState' || st === 'Starting') return 'starting';
    return 'stopped';
  } catch { return err ? 'unknown' : 'stopped'; }
});
ipcMain.handle('tailscale:start', async () => {
  const { err } = await runTailscale(['up']);
  return !err;
});
ipcMain.handle('qr:make', (_e, text) => QRCode.toDataURL(String(text), { margin: 1, width: 220 }));
ipcMain.on('open:external', (_e, url) => { if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url)); });
// Screen sharing: the renderer lists screens/windows, the user picks one, then getDisplayMedia is answered with that source.
let pickedSource = null;
ipcMain.handle('screen:sources', async () => {
  const srcs = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
  return srcs.map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
});
ipcMain.handle('screen:pick', (_e, id) => { pickedSource = String(id); });
ipcMain.on('win:fullscreen', (_e, on) => { if (win) win.setFullScreen(on); });
ipcMain.on('win:hide', hideToTray);
ipcMain.on('win:show', showWindow);

function createWindow() {
  win = new BrowserWindow({
    width: settings.bounds.width, height: settings.bounds.height,
    minWidth: 900, minHeight: 600,
    backgroundColor: '#0f1419',
    title: `Skippy v${app.getVersion()}`,
    icon: ICON,
    show: !startHidden,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep calls and ringing alive while hidden in the tray
    },
  });
  win.setTitle(`Skippy v${app.getVersion()}`);
  win.on('page-title-updated', e => e.preventDefault()); // keep the version in the title bar
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', e => {
    if (!win.isMaximized() && !win.isMinimized()) {
      const [width, height] = win.getSize();
      settings.bounds = { width, height };
      saveSettings();
    }
    // Closing the window keeps Skippy running in the tray (calls can still come in). Quit from the tray menu.
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
  if (IS_MAC) { // menu-bar app: Dock icon only while the window is visible
    win.on('show', () => app.dock?.show());
    win.on('hide', () => app.dock?.hide());
  }
  // Never navigate the app window away; open external links in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

// macOS asks for camera / microphone access the first time they are used, but only if the app asks for it
// explicitly; otherwise getUserMedia silently fails. Ask up front so the prompt appears at launch, not mid-call.
async function askMacPermissions() {
  try {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') await systemPreferences.askForMediaAccess('microphone');
    if (systemPreferences.getMediaAccessStatus('camera') === 'not-determined') await systemPreferences.askForMediaAccess('camera');
  } catch { /* the renderer reports a clear error if access is denied */ }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    loadSettings();
    clearIncoming();
    recorder.sweepTmp();
    session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
      const id = pickedSource; pickedSource = null;
      if (!id) return cb({});
      desktopCapturer.getSources({ types: ['screen', 'window'] })
        .then(srcs => { const s = srcs.find(x => x.id === id); cb(s ? { video: s } : {}); })
        .catch(() => cb({}));
    });
    const allowed = ['media', 'speaker-selection', 'notifications', 'display-capture'];
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.includes(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission));
    createTray();
    createWindow();
    if (IS_MAC) askMacPermissions();
    app.on('activate', showWindow);
  });
  app.on('before-quit', () => { quitting = true; clearIncoming(); });
  // Stay alive in the tray when every window is hidden/closed.
  app.on('window-all-closed', () => { /* keep running */ });
}
