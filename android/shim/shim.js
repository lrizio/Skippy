'use strict';
// Android stand-in for the Electron preload API (window.skippy). The renderer (app.js) is shared with the desktop app.
(function () {
  window.SKIPPY_MOBILE = true;
  const cap = window.Capacitor || {};
  const PLATFORM = (cap.getPlatform && cap.getPlatform()) || 'web';
  const IOS = PLATFORM === 'ios';
  const DEVICE = IOS ? 'iPhone' : 'Android';
  if (IOS) document.documentElement.classList.add('ios'); // CSS hook: no speaker picker on iOS
  const FS = cap.Plugins && cap.Plugins.Filesystem;
  const KEY = 'skippy.settings';
  const readLS = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
  const writeLS = o => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* storage blocked */ } };

  // chat starts hidden on a phone (it is a full-screen overlay there)
  try { if (localStorage.getItem('chatOn') === null) localStorage.setItem('chatOn', '0'); } catch { /* ignore */ }

  const b64 = buf => {
    const u8 = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };

  // ---- received files: appended to a cache file, copied to a visible folder on "Save" ----
  const incoming = new Map(); // id -> { path, written, chain }
  const noop = async () => {};
  const rec = async () => { throw new Error('Recording is not available on ' + DEVICE + '.'); };

  window.skippy = {
    loadSettings: async () => {
      const s = readLS();
      return { serverUrl: '', lastLogin: '', devices: { mic: '', cam: '', spk: '' },
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], ...s,
        token: s.token || '', version: window.SKIPPY_VERSION || '0', autostart: false };
    },
    saveSettings: async patch => { if (patch && typeof patch === 'object') writeLS({ ...readLS(), ...patch }); },
    setAutostart: noop,
    // no QR on the phone you are holding: offer an "open in authenticator" link instead
    makeQr: async text => {
      setTimeout(() => {
        const host = document.getElementById('sec-secret'); if (!host) return;
        let a = document.getElementById('sec-open-auth');
        if (!a) { a = document.createElement('a'); a.id = 'sec-open-auth'; a.className = 'ghost-link'; host.insertAdjacentElement('afterend', a); }
        a.href = text; a.textContent = 'Open in my authenticator app';
      }, 0);
      return 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
    },
    // The latest GitHub release carries the files for every platform (Windows, Mac, iPhone, Linux, Android).
    checkUpdate: async wsUrl => {
      const get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return r.json(); };
      try {
        const u = new URL(/^wss?:\/\//.test(wsUrl) ? wsUrl : 'ws://' + wsUrl);
        u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'; u.pathname = '/update.json'; u.search = '';
        const j = await get(u.toString());
        if (j && j.version) return { version: String(j.version), url: String(j.url || ''), notes: String(j.notes || '') };
      } catch { /* no server update info */ }
      try {
        const j = await get('https://api.github.com/repos/lrizio/Skippy/releases/latest');
        if (j && j.tag_name) return { version: String(j.tag_name).replace(/^v/, ''), url: String(j.html_url || ''), notes: '' };
      } catch { /* offline */ }
      return null;
    },
    tailscaleStatus: async () => 'running', // cannot be detected from a web view; the banner stays off
    tailscaleStart: noop,
    openExternal: url => { if (/^https?:\/\//i.test(String(url))) window.open(String(url), '_blank'); },
    hideToTray: () => {},
    showWindow: () => {},
    setFullscreen: () => {},
    screenSources: async () => [],
    screenPick: noop,

    fileOpen: async id => {
      if (!FS) { incoming.set(id, { mem: [], written: 0 }); return true; }
      const path = 'incoming/' + id;
      await FS.writeFile({ path, data: '', directory: 'CACHE', recursive: true });
      incoming.set(id, { path, written: 0, chain: Promise.resolve() });
      return true;
    },
    fileWrite: (id, data) => {
      const f = incoming.get(id); if (!f) return;
      const len = data.byteLength;
      if (f.mem) { f.mem.push(new Uint8Array(data.slice ? data.slice(0) : data)); f.written += len; return; }
      const chunk = b64(data); f.written += len;
      f.chain = f.chain.then(() => FS.appendFile({ path: f.path, data: chunk, directory: 'CACHE' })).catch(() => { f.error = true; });
    },
    fileClose: async id => {
      const f = incoming.get(id); if (!f) return 0;
      if (f.chain) await f.chain;
      return f.error ? -1 : f.written;
    },
    fileDiscard: async id => {
      const f = incoming.get(id); if (!f) return;
      incoming.delete(id);
      if (f.chain) { try { await f.chain; await FS.deleteFile({ path: f.path, directory: 'CACHE' }); } catch { /* ignore */ } }
    },
    fileSave: async (id, name) => {
      const f = incoming.get(id); if (!f) return { ok: false, error: 'File is not available.' };
      const safe = String(name).replace(/[\\/:*?"<>|]+/g, '_') || 'file';
      if (f.mem) { // plain browser (testing only): normal download
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(f.mem)); a.download = safe; a.click();
        return { ok: true, path: 'Downloads/' + safe };
      }
      // iOS: the app's Documents folder shows up in the Files app under On My iPhone > Skippy.
      for (const [directory, label] of [['DOCUMENTS', IOS ? 'Files app > On My iPhone > Skippy' : 'Documents'], ['EXTERNAL', 'app storage']]) {
        try {
          await FS.copy({ from: f.path, directory: 'CACHE', to: 'Skippy/' + safe, toDirectory: directory });
          return { ok: true, path: label + '/Skippy/' + safe };
        } catch (e) { /* try the next location */ }
      }
      return { ok: false, error: 'Could not save the file.' };
    },

    // recording + transcripts are desktop-only
    recStart: rec, recOpen: rec, recWrite: () => {}, recClose: noop, recMeta: noop, recFinish: noop,
    recList: async () => [], recTracks: rec, recReadTrack: rec, recOpenFolder: noop, recOpenTranscript: noop,
    recSaveTranscript: noop, recEngineStatus: async () => ({ installed: false }), recEngineInstall: rec,
    onRecProgress: () => {}, recWavOpen: rec, recWavWrite: () => {}, recWavTranscribe: rec,
  };

  // first run: no server address yet, so open the Server box and ask for it
  document.addEventListener('DOMContentLoaded', () => {
    const url = document.getElementById('server-url');
    if (url) url.placeholder = 'e.g. 100.x.y.z:8470 (your Tailscale address)';
    if (!readLS().serverUrl) { const d = document.querySelector('.server-box'); if (d) d.open = true; }
  });

  // keep the screen awake while a call is on
  let lock = null;
  async function keepAwake() {
    try {
      const inCall = !document.getElementById('screen-call')?.classList.contains('hidden');
      if (inCall && !lock && navigator.wakeLock && document.visibilityState === 'visible') {
        lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; });
      } else if (!inCall && lock) { await lock.release(); lock = null; }
    } catch { lock = null; }
  }
  setInterval(keepAwake, 3000);
  document.addEventListener('visibilitychange', keepAwake);
})();
