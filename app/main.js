'use strict';
const { app, BrowserWindow, ipcMain, session, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  serverUrl: 'ws://localhost:8470',
  lastLogin: '',
  devices: { mic: '', cam: '', spk: '' },
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  bounds: { width: 1280, height: 800 },
};

let settingsFile;
let settings = { ...DEFAULTS };

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

ipcMain.handle('settings:load', () => {
  const { token, tokenEnc, ...rest } = settings;
  return { ...rest, token: readToken(), version: app.getVersion() };
});
ipcMain.handle('settings:save', (_e, patch) => {
  if (patch && typeof patch === 'object') {
    if ('token' in patch) { writeToken(patch.token); delete patch.token; }
    Object.assign(settings, patch);
    saveSettings();
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: settings.bounds.width, height: settings.bounds.height,
    minWidth: 900, minHeight: 600,
    backgroundColor: '#0f1419',
    title: 'Skippy',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', () => {
    if (!win.isMaximized() && !win.isMinimized()) {
      const [width, height] = win.getSize();
      settings.bounds = { width, height };
      saveSettings();
    }
  });
  // Never navigate the app window away; open external links in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

app.whenReady().then(() => {
  loadSettings();
  // Only camera/microphone/speaker-selection are needed by the renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'speaker-selection'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'speaker-selection'].includes(permission));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
