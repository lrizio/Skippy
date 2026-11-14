'use strict';
// Call recording + offline transcription (main process).
// Each speaker is recorded as a separate Opus track in the renderer and streamed here to disk; transcription runs
// whisper.cpp locally, one track at a time, so every line of the transcript can name who said it.
const { app, ipcMain, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MODEL_NAME = 'ggml-base.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;
const RELEASES_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30';
const WIN_ASSET = /^whisper-bin-x64\.zip$/i;

const root = () => path.join(app.getPath('documents'), 'Skippy Recordings');
const engineDir = () => path.join(app.getPath('userData'), 'whisper');
const tmpDir = () => path.join(app.getPath('userData'), 'rec-tmp');
const safe = s => String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'unnamed';
const SESSION_RE = /^[^\\/:*?"<>|\x00-\x1f]+$/;

const sessions = new Map(); // dirName -> { dir, room, started, tracks: Map(trackId -> {name,file,fd,offsetMs}) }
const wavs = new Map();     // wavId -> { fd, file }

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}
function sessionDir(name) {
  if (typeof name !== 'string' || !SESSION_RE.test(name) || name === '.' || name === '..') return null;
  return path.join(root(), name);
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// ---- recording ----
ipcMain.handle('rec:start', (_e, roomName) => {
  const started = new Date();
  let name = `${safe(roomName)} ${stamp(started)}`, n = 2;
  while (fs.existsSync(path.join(root(), name))) name = `${safe(roomName)} ${stamp(started)} (${n++})`;
  const dir = path.join(root(), name);
  fs.mkdirSync(dir, { recursive: true });
  sessions.set(name, { dir, room: String(roomName), started: started.toISOString(), tracks: new Map() });
  return { name, dir };
});
ipcMain.handle('rec:open', (_e, name, trackId, speaker, offsetMs) => {
  const s = sessions.get(name); if (!s) return false;
  let base = safe(speaker), file = base + '.webm', n = 2;
  while ([...s.tracks.values()].some(t => t.file === file)) file = `${base} (${n++}).webm`;
  s.tracks.set(trackId, { name: String(speaker), file, fd: fs.openSync(path.join(s.dir, file), 'w'), offsetMs: Math.max(0, Number(offsetMs) || 0) });
  return true;
});
ipcMain.on('rec:write', (_e, name, trackId, data) => {
  const t = sessions.get(name)?.tracks.get(trackId);
  if (t && t.fd !== null) fs.writeSync(t.fd, Buffer.from(data));
});
ipcMain.handle('rec:close', (_e, name, trackId) => {
  const t = sessions.get(name)?.tracks.get(trackId);
  if (t && t.fd !== null) { try { fs.closeSync(t.fd); } catch { /* ignore */ } t.fd = null; }
});
function writeMeta(name) {
  const s = sessions.get(name); if (!s) return;
  const prev = readJson(path.join(s.dir, 'session.json')) || {};
  const meta = { room: s.room, started: s.started, ended: prev.ended, transcribed: !!prev.transcribed,
    tracks: [...s.tracks.values()].map(t => ({ speaker: t.name, file: t.file, offsetMs: t.offsetMs })) };
  fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify(meta, null, 2));
}
ipcMain.handle('rec:finish', (_e, name) => {
  const s = sessions.get(name); if (!s) return null;
  for (const t of s.tracks.values()) if (t.fd !== null) { try { fs.closeSync(t.fd); } catch { /* ignore */ } t.fd = null; }
  writeMeta(name);
  const metaFile = path.join(s.dir, 'session.json');
  const meta = readJson(metaFile); meta.ended = new Date().toISOString();
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  sessions.delete(name);
  return { name, dir: s.dir };
});
// Track start offsets can arrive after the track opens, so the metadata is rewritten on every new track.
ipcMain.handle('rec:meta', (_e, name) => { writeMeta(name); });

// ---- library ----
ipcMain.handle('rec:list', () => {
  let names = [];
  try { names = fs.readdirSync(root(), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
  return names.map(name => {
    const meta = readJson(path.join(root(), name, 'session.json'));
    if (!meta) return null;
    return { name, room: meta.room, started: meta.started, ended: meta.ended, speakers: (meta.tracks || []).map(t => t.speaker),
      transcribed: fs.existsSync(path.join(root(), name, 'Transcript.txt')) };
  }).filter(Boolean).sort((a, b) => String(b.started).localeCompare(String(a.started)));
});
ipcMain.handle('rec:tracks', (_e, name) => {
  const dir = sessionDir(name); const meta = dir && readJson(path.join(dir, 'session.json'));
  return meta ? { room: meta.room, started: meta.started, tracks: meta.tracks } : null;
});
ipcMain.handle('rec:read-track', async (_e, name, file) => {
  const dir = sessionDir(name); if (!dir || !SESSION_RE.test(String(file))) return null;
  try { return await fs.promises.readFile(path.join(dir, file)); } catch { return null; }
});
ipcMain.handle('rec:open-folder', (_e, name) => {
  const dir = name ? sessionDir(name) : root();
  if (!dir) return false;
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return true;
});
ipcMain.handle('rec:open-transcript', (_e, name) => {
  const dir = sessionDir(name); const f = dir && path.join(dir, 'Transcript.txt');
  if (!f || !fs.existsSync(f)) return false;
  shell.openPath(f);
  return true;
});
ipcMain.handle('rec:save-transcript', (_e, name, text) => {
  const dir = sessionDir(name); if (!dir) return false;
  fs.writeFileSync(path.join(dir, 'Transcript.txt'), String(text), 'utf8');
  const metaFile = path.join(dir, 'session.json'), meta = readJson(metaFile);
  if (meta) { meta.transcribed = true; fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2)); }
  return true;
});

// ---- transcription engine (whisper.cpp, downloaded once, runs offline afterwards) ----
function findExe(dir) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const r = findExe(p); if (r) return r; }
      else if (/^whisper-cli(\.exe)?$/i.test(e.name)) return p;
    }
  } catch { /* none */ }
  return null;
}
// macOS has no prebuilt whisper.cpp download, so use the Homebrew one (brew install whisper-cpp).
// Linux has no prebuilt download either: use a whisper-cli on the PATH or one you built yourself.
const SYS_EXES = process.platform === 'darwin' ? ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']
  : process.platform === 'linux' ? [...(process.env.PATH || '').split(':').filter(Boolean).map(d => path.join(d, 'whisper-cli')),
    path.join(require('os').homedir(), '.local', 'bin', 'whisper-cli'), '/usr/local/bin/whisper-cli', '/usr/bin/whisper-cli'] : [];
const engineExe = () => findExe(engineDir()) || SYS_EXES.find(p => fs.existsSync(p)) || null;
const modelFile = () => path.join(engineDir(), MODEL_NAME);
const engineReady = () => !!engineExe() && fs.existsSync(modelFile());

ipcMain.handle('rec:engine-status', () => ({ ready: engineReady(), supported: process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux', sizeMB: 190 }));

async function download(url, dest, onProgress) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Skippy' }, redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status}).`);
  const total = Number(r.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let got = 0;
  try {
    for await (const chunk of r.body) {
      if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
      got += chunk.length;
      if (total) onProgress(got / total);
    }
  } finally { await new Promise(res => out.end(res)); }
  if (total && got !== total) throw new Error('Download was cut short.');
}

ipcMain.handle('rec:engine-install', async e => {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    // Engine comes from the system (Homebrew / your own build); only the language model is downloaded here.
    if (!engineExe()) return { ok: false, error: process.platform === 'darwin'
      ? 'Install the speech engine first: open Terminal and run  brew install whisper-cpp  then try again.'
      : 'Install the speech engine first: build whisper.cpp (github.com/ggml-org/whisper.cpp) and put whisper-cli on your PATH or in ~/.local/bin, then try again.' };
    const send = (what, pct) => { try { e.sender.send('rec:progress', { what, pct }); } catch { /* window gone */ } };
    try {
      fs.mkdirSync(engineDir(), { recursive: true });
      if (!fs.existsSync(modelFile())) {
        const part = modelFile() + '.part';
        await download(MODEL_URL, part, p => send('Downloading the language model', p));
        fs.renameSync(part, modelFile());
      }
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  }
  if (process.platform !== 'win32') return { ok: false, error: 'Automatic setup is not available on this system. Put whisper-cli and ' + MODEL_NAME + ' in ' + engineDir() };
  const send = (what, pct) => { try { e.sender.send('rec:progress', { what, pct }); } catch { /* window gone */ } };
  try {
    fs.mkdirSync(engineDir(), { recursive: true });
    if (!engineExe()) {
      send('Finding the speech engine', 0);
      // The newest release often has no Windows build attached, so take the newest one that does.
      const resp = await fetch(RELEASES_API, { headers: { 'User-Agent': 'Skippy', Accept: 'application/json' } });
      if (!resp.ok) throw new Error(`Could not reach GitHub (${resp.status}). Check your internet connection.`);
      let asset = null;
      for (const rel of await resp.json()) { asset = (rel.assets || []).find(a => WIN_ASSET.test(a.name)); if (asset) break; }
      if (!asset) throw new Error('Could not find a Windows speech engine download on GitHub.');
      const zip = path.join(engineDir(), 'engine.zip');
      await download(asset.browser_download_url, zip, p => send('Downloading the speech engine', p));
      send('Unpacking the speech engine', 1);
      await new Promise((res, rej) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${engineDir().replace(/'/g, "''")}' -Force`],
        err => err ? rej(err) : res()));
      fs.rmSync(zip, { force: true });
      if (!engineExe()) throw new Error('The speech engine download did not contain whisper-cli.');
    }
    if (!fs.existsSync(modelFile())) {
      const part = modelFile() + '.part';
      await download(MODEL_URL, part, p => send('Downloading the language model', p));
      fs.renameSync(part, modelFile());
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// The renderer decodes each track to 16 kHz mono and hands it over as a WAV, in pieces.
ipcMain.handle('rec:wav-open', () => {
  fs.mkdirSync(tmpDir(), { recursive: true });
  const id = require('crypto').randomUUID(), file = path.join(tmpDir(), id + '.wav');
  wavs.set(id, { fd: fs.openSync(file, 'w'), file });
  return id;
});
ipcMain.on('rec:wav-write', (_e, id, data) => {
  const w = wavs.get(id); if (w) fs.writeSync(w.fd, Buffer.from(data));
});
ipcMain.handle('rec:wav-transcribe', (_e, id) => {
  const w = wavs.get(id); if (!w) return { ok: false, error: 'No audio.' };
  fs.closeSync(w.fd); wavs.delete(id);
  const exe = engineExe();
  if (!exe || !fs.existsSync(modelFile())) return { ok: false, error: 'Speech engine is not installed.' };
  const outBase = w.file.replace(/\.wav$/, '');
  const threads = Math.max(1, Math.min(8, require('os').cpus().length - 1));
  return new Promise(resolve => {
    const cleanup = () => { for (const f of [w.file, outBase + '.json']) fs.rmSync(f, { force: true }); };
    const p = spawn(exe, ['-m', modelFile(), '-f', w.file, '-oj', '-of', outBase, '-l', 'auto', '-np', '-t', String(threads)],
      { cwd: path.dirname(exe), windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', e => { cleanup(); resolve({ ok: false, error: e.message }); });
    p.on('close', code => {
      const j = readJson(outBase + '.json');
      cleanup();
      if (code !== 0 || !j) return resolve({ ok: false, error: `Speech engine failed (${code}). ${err.split('\n').filter(Boolean).pop() || ''}` });
      resolve({ ok: true, segments: (j.transcription || []).map(s => ({ from: s.offsets?.from ?? 0, to: s.offsets?.to ?? 0, text: String(s.text || '').trim() })).filter(s => s.text) });
    });
  });
});

function sweepTmp() { try { fs.rmSync(tmpDir(), { recursive: true, force: true }); } catch { /* ignore */ } }
module.exports = { sweepTmp };
