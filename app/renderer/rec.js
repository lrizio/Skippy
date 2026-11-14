'use strict';
// Call recording + transcription UI. Loaded after app.js and shares its globals (me, room, peers, localStream, api, $, toast, showModal).
// Every speaker is recorded as their own track, so the transcript can say who said what.

let recSession = null;          // folder name while recording
let recStartTs = 0;
const recTracks = new Map();    // key ('me' | 'peer:<id>') -> { rec, trackId, chain }
let recSeq = 0;
let recBusy = false;            // a transcription is running

const recOn = () => !!recSession;

function recAddTrack(key, speaker, track) {
  if (!recSession || recTracks.has(key) || !track || track.readyState !== 'live') return;
  const session = recSession, trackId = ++recSeq, offset = Date.now() - recStartTs;
  let rec;
  try {
    rec = new MediaRecorder(new MediaStream([track]), { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
  } catch { toast(`Could not record ${speaker}.`); return; }
  const t = { rec, trackId, chain: api.recOpen(session, trackId, speaker, offset).then(() => api.recMeta(session)) };
  recTracks.set(key, t);
  rec.ondataavailable = ev => {
    if (!ev.data.size) return;
    t.chain = t.chain.then(() => ev.data.arrayBuffer()).then(buf => api.recWrite(session, trackId, buf));
  };
  rec.onstop = () => { t.chain = t.chain.then(() => api.recClose(session, trackId)); };
  rec.start(1000);
}

function recStopTrack(key) {
  const t = recTracks.get(key); if (!t) return Promise.resolve();
  recTracks.delete(key);
  try { if (t.rec.state !== 'inactive') t.rec.stop(); } catch { /* already stopped */ }
  return new Promise(res => setTimeout(() => t.chain.then(res, res), 100));
}

function recPeerAudio(p) { // called when a participant's audio arrives
  const tr = p.stream.getAudioTracks()[0];
  if (tr) recAddTrack('peer:' + p.user.id, p.user.name, tr);
}
function recDropPeer(id) { recStopTrack('peer:' + id); }
function recSwapLocal() { // the microphone was changed: carry on with the new one
  if (!recSession) return;
  recStopTrack('me').then(() => recAddTrack('me', me.name, localStream?.getAudioTracks()[0]));
}

function recAnnounce() { for (const p of peers.values()) sendState(p); }

function updateRecBadge() {
  const who = [...peers.values()].filter(p => p.rec).map(p => p.user.name);
  if (recOn()) who.unshift('you');
  const b = $('#rec-badge');
  b.classList.toggle('hidden', !who.length);
  b.title = who.length ? `Being recorded by ${who.join(', ')}` : '';
  const btn = $('#btn-rec');
  btn.textContent = recOn() ? 'Stop recording' : 'Record';
  btn.classList.toggle('off', recOn());
}

async function recStart() {
  if (recOn() || !room) return;
  const s = await api.recStart(room);
  recSession = s.name; recStartTs = Date.now();
  recAddTrack('me', me.name, localStream?.getAudioTracks()[0]);
  for (const p of peers.values()) recPeerAudio(p);
  recAnnounce(); updateRecBadge();
  toast('Recording started. Everyone in the call can see the REC indicator.');
}

async function recStop(openList) {
  if (!recOn()) return;
  const name = recSession;
  await Promise.all([...recTracks.keys()].map(recStopTrack));
  recSession = null;
  await api.recFinish(name);
  recAnnounce(); updateRecBadge();
  if (openList) { toast('Recording saved.'); openRecordings(name); }
}

$('#btn-rec').onclick = () => { if (recOn()) recStop(true); else recStart(); };
window.addEventListener('beforeunload', () => { if (recOn()) recStop(false); });

// ---------- transcription ----------
function fmtClock(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// Decode a recorded track to 16 kHz mono (what the speech engine wants) and hand it to the main process as a WAV.
async function sendWav(buf) {
  const audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(buf);
  const n = audio.length, chans = [...Array(audio.numberOfChannels).keys()].map(i => audio.getChannelData(i));
  const pcm = new Int16Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let v = 0; for (const c of chans) v += c[i];
    v /= chans.length;
    peak = Math.max(peak, Math.abs(v));
    pcm[i] = Math.max(-1, Math.min(1, v)) * 32767;
  }
  if (peak < 0.005) return null; // nobody spoke on this track
  const head = new DataView(new ArrayBuffer(44)), str = (o, s) => { for (let i = 0; i < s.length; i++) head.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); head.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE'); str(12, 'fmt ');
  head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
  head.setUint32(24, 16000, true); head.setUint32(28, 32000, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
  str(36, 'data'); head.setUint32(40, pcm.byteLength, true);
  const id = await api.recWavOpen();
  api.recWavWrite(id, head.buffer);
  const bytes = new Uint8Array(pcm.buffer);
  for (let o = 0; o < bytes.length; o += 1 << 20) api.recWavWrite(id, bytes.slice(o, o + (1 << 20)).buffer);
  return id;
}

function buildTranscript(info, lines) {
  lines.sort((a, b) => a.t - b.t);
  const merged = []; // join a speaker's consecutive remarks into one paragraph
  for (const l of lines) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === l.speaker && l.t - last.end < 4000) { last.text += ' ' + l.text; last.end = l.end; }
    else merged.push({ ...l });
  }
  const speakers = [...new Set(info.tracks.map(t => t.speaker))];
  const head = [`Skippy call transcript`, `Room: ${info.room}`, `Started: ${new Date(info.started).toLocaleString()}`,
    `Speakers: ${speakers.join(', ')}`, `Times are from the start of the recording.`, ''];
  return head.concat(merged.map(m => `[${fmtClock(m.t)}] ${m.speaker}: ${m.text}`)).join('\r\n') + '\r\n';
}

async function ensureEngine(setStatus) {
  const st = await api.recEngineStatus();
  if (st.ready) return true;
  if (!st.supported) { alert('Speech engine setup is only automatic on Windows and macOS. See the user guide.'); return false; }
  if (!confirm(`Transcription runs on this computer, so nothing is sent to anyone.\n\nIt needs a one-time download of about ${st.sizeMB} MB (the speech engine and its language model, from GitHub and Hugging Face).\n\nDownload now?`)) return false;
  api.onRecProgress(p => setStatus(`${p.what}${p.pct > 0 && p.pct < 1 ? ' ' + Math.round(p.pct * 100) + '%' : ''}…`));
  const r = await api.recEngineInstall();
  if (!r.ok) { alert('Setup failed: ' + r.error); return false; }
  return true;
}

async function transcribeSession(name, setStatus) {
  if (recBusy) return false;
  recBusy = true;
  try {
    if (!await ensureEngine(setStatus)) return false;
    const info = await api.recTracks(name);
    if (!info) throw new Error('Recording not found.');
    const lines = [];
    for (let i = 0; i < info.tracks.length; i++) {
      const t = info.tracks[i];
      setStatus(`Listening to ${t.speaker} (${i + 1} of ${info.tracks.length})…`);
      const raw = await api.recReadTrack(name, t.file);
      if (!raw || !raw.byteLength) continue;
      let wav;
      try { wav = await sendWav(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)); }
      catch { continue; } // an empty or damaged track
      if (!wav) continue;
      const r = await api.recWavTranscribe(wav);
      if (!r.ok) throw new Error(r.error);
      for (const s of r.segments) {
        if (/^[\[(].*[\])]$/.test(s.text)) continue; // [BLANK_AUDIO], (music) and similar
        lines.push({ t: t.offsetMs + s.from, end: t.offsetMs + s.to, speaker: t.speaker, text: s.text });
      }
    }
    await api.recSaveTranscript(name, buildTranscript(info, lines));
    return true;
  } catch (e) { alert('Transcription failed: ' + e.message); return false; }
  finally { recBusy = false; }
}

// ---------- recordings list ----------
async function openRecordings(highlight) {
  showModal('recordings', true);
  await renderRecordings(highlight);
}
async function renderRecordings(highlight) {
  const box = $('#rec-list');
  const list = await api.recList();
  box.innerHTML = '';
  if (!list.length) box.innerHTML = '<p class="muted">No recordings yet. Press Record during a call.</p>';
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'person rec-row' + (r.name === highlight ? ' fresh' : '');
    const when = new Date(r.started);
    const info = document.createElement('div');
    info.className = 'who-msg';
    info.innerHTML = '<b></b><span class="last"></span><span class="last rec-status"></span>';
    info.querySelector('b').textContent = r.room;
    info.querySelectorAll('.last')[0].textContent = `${when.toLocaleString()} · ${r.speakers.join(', ') || 'no audio'}`;
    const status = info.querySelector('.rec-status');
    status.textContent = r.transcribed ? 'Transcribed' : 'Not transcribed yet';
    const btns = document.createElement('div');
    btns.className = 'btns';
    const mk = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost'; b.textContent = label; b.onclick = fn; btns.appendChild(b); return b; };
    const tbtn = mk(r.transcribed ? 'Redo text' : 'Make text', async () => {
      tbtn.disabled = true;
      const ok = await transcribeSession(r.name, s => { status.textContent = s; });
      await renderRecordings(r.name);
      if (ok) api.recOpenTranscript(r.name);
    });
    if (r.transcribed) mk('Read', () => api.recOpenTranscript(r.name));
    mk('Folder', () => api.recOpenFolder(r.name));
    row.append(info, btns);
    box.appendChild(row);
  }
}
$('#btn-recordings').onclick = () => openRecordings();
$('#btn-rec-close').onclick = () => showModal('recordings', false);
$('#btn-rec-folder').onclick = () => api.recOpenFolder();
