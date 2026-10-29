'use strict';
// Skippy renderer: auth, devices, WebRTC mesh (max 10), chat with history, file transfer over data channels.

const $ = s => document.querySelector(s);
const api = window.skippy;

const CHUNK = 64 * 1024;
const MAX_FILE = 2 * 1024 * 1024 * 1024; // 2 GB; received files stream to disk, not memory

let S = null;                 // persisted settings (from main process)
let ws = null;
let me = null;                // {id,name,callsign}
let token = '';
let pendingLogin = '';        // what the user typed, remembered as "last login"
let room = null;              // current room name when in a call
let wantedRoom = null;        // room to rejoin after a reconnect
let loggedIn = false;
let reconnectTimer = null;
let online = [];              // users currently logged in (for direct calls)
let dmWith = null;            // the other person in a direct call
let incomingCall = null, outgoingCall = null;

let localStream = null;
let micOn = true, camOn = true;
const roster = new Map();     // id -> user
const peers = new Map();      // id -> peer state
const files = new Map();      // fileId -> transfer state (blobs live only in memory)

// ---------- small helpers ----------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}
const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(1) + ' GB';
const fmtTime = ts => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const uuid = () => crypto.randomUUID();

// ---------- websocket ----------
function wsSend(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

function connect() {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === 1) return resolve();
    let url = ($('#server-url').value || S.serverUrl).trim();
    if (!/^wss?:\/\//.test(url)) url = 'ws://' + url;
    let sock;
    try { sock = new WebSocket(url); } catch { return reject(new Error('Bad server address.')); }
    const timer = setTimeout(() => { sock.close(); reject(new Error('Could not reach the server.')); }, 6000);
    sock.onopen = () => { clearTimeout(timer); ws = sock; resolve(); };
    sock.onerror = () => { clearTimeout(timer); reject(new Error('Could not reach the server.')); };
    sock.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } onServer(m); };
    sock.onclose = () => { if (ws === sock) { ws = null; onDisconnected(); } };
  });
}

function onDisconnected() {
  if (!loggedIn) return;
  $('#conn-banner').classList.remove('hidden');
  // The server dropped us from the room, so tear down media and rebuild after reconnect.
  if (room) wantedRoom = room;
  clearCallUi();
  closeAllPeers();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(reconnect, 3000);
}
async function reconnect() {
  try { await connect(); wsSend({ t: 'resume', token }); }
  catch { reconnectTimer = setTimeout(reconnect, 3000); }
}

// ---------- server messages ----------
function onServer(m) {
  switch (m.t) {
    case 'authed': return onAuthed(m);
    case 'resume-failed':
      token = ''; api.saveSettings({ token: '' });
      if (loggedIn) { loggedIn = false; hardLeave(); toast('Session expired, please log in again.'); }
      return showLogin();
    case 'logged-out': return;
    case 'error':
      if (!loggedIn) $('#login-error').textContent = m.msg; else if (!$('#modal-security').classList.contains('hidden')) $('#sec-error').textContent = m.msg; else toast(m.msg);
      if (!room) $('#join-error').textContent = m.msg;
      return;
    case 'room-full':
      wantedRoom = null;
      $('#join-error').textContent = `Room "${m.room}" is full (${m.max} participants max).`;
      return;
    case 'joined': return onJoined(m);
    case 'history': if (m.room === room) renderHistory(m.history); return;
    case 'peer-joined': roster.set(m.peer.id, m.peer); sysMsg(`${m.peer.name} joined`); makePeer(m.peer); updateCount(); return;
    case 'peer-left': {
      const u = roster.get(m.id); roster.delete(m.id);
      if (u) sysMsg(`${u.name} left`);
      closePeer(m.id); updateCount(); return;
    }
    case 'chat': if (m.msg.room === room) addMessage(m.msg, true); return;
    case 'signal': return onSignal(m.from, m.data);
    case 'password-reset': toast('Password changed.'); showRecoveryKey(m.recoveryKey, 'Your password is changed and every other device is signed out. This is your new recovery key - the old one no longer works.'); return;
    case 'recovery-new': $('#form-recovery').reset(); me.hasRecovery = true; showRecoveryKey(m.recoveryKey); return;
    case 'totp-required': $('#login-error').textContent = ''; showTotpStage(true); return;
    case 'totp-expired': showTotpStage(false); $('#login-error').textContent = 'Login timed out - please log in again.'; return;
    case 'totp-setup': return onTotpSetup(m);
    case 'totp-enabled': me.totp = true; showSec('codes'); $('#sec-codes-list').textContent = m.backupCodes.join('\n'); return;
    case 'totp-disabled': me.totp = false; $('#sec-error').textContent = ''; showSec('off'); toast('Two-factor authentication is off.'); return;
    case 'presence': online = m.users; renderPeople(); return;
    case 'calling': outgoingCall = m; $('#calling-title').textContent = `Calling ${m.to.name}…`; showModal('calling', true); ring('out'); return;
    case 'call-failed':
      outgoingCall = null; showModal('calling', false); stopRing();
      $('#call-error').textContent = m.msg; toast(m.msg); return;
    case 'incoming-call': return onIncomingCall(m);
    case 'call-cancelled':
      if (incomingCall?.callId === m.callId) { incomingCall = null; showModal('incoming', false); stopRing(); }
      return;
    case 'call-start': return startDirect(m);
    case 'kicked': wantedRoom = null; hardLeave(); toast(m.msg); showLobby(); return;
  }
}

async function onAuthed(m) {
  const wasLoggedIn = loggedIn;
  me = m.user; me.totp = !!m.totp; token = m.token; loggedIn = true;
  showTotpStage(false);
  $('#conn-banner').classList.add('hidden');
  const patch = { token };
  if (pendingLogin) { patch.lastLogin = pendingLogin; S.lastLogin = pendingLogin; pendingLogin = ''; }
  api.saveSettings({ ...patch, serverUrl: ($('#server-url').value || S.serverUrl).trim() });
  $('#who-lobby').textContent = $('#who-call').textContent = me.name + (me.callsign ? ` (${me.callsign})` : '');
  renderRecent(m.rooms || []);
  $('#login-error').textContent = '';
  $('#form-login').reset(); $('#form-register').reset(); $('#form-reset').reset();
  me.hasRecovery = !!m.hasRecovery;
  if (m.recoveryKey) showRecoveryKey(m.recoveryKey); // brand-new account
  else if (!me.hasRecovery) setTimeout(() => toast('Tip: open Security to make a recovery key in case you forget your password.'), 1500);
  if (wantedRoom) { // reconnect case: go straight back into the call
    wsSend({ t: 'join', room: wantedRoom });
    return;
  }
  if (!wasLoggedIn || !room) { await showLobby(); }
}

// ---------- login / register UI ----------
function showLogin() {
  stopLocal();
  showTotpStage(false);
  setTab(true);
  $('#login-id').value = S.lastLogin || '';
  $('#login-pw').value = '';
  show('screen-login');
  (S.lastLogin ? $('#login-pw') : $('#login-id')).focus();
}
function setTab(login) {
  $('#tab-login').classList.toggle('active', login);
  $('#tab-register').classList.toggle('active', !login);
  $('#form-reset').classList.add('hidden');
  $('#form-login').classList.toggle('hidden', !login);
  $('#form-register').classList.toggle('hidden', login);
  $('#login-error').textContent = '';
}
$('#tab-login').onclick = () => setTab(true);
$('#tab-register').onclick = () => setTab(false);

$('#form-login').onsubmit = async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const id = $('#login-id').value.trim();
  try { await connect(); } catch (err) { $('#login-error').textContent = err.message; return; }
  pendingLogin = id;
  wsSend({ t: 'login', id, password: $('#login-pw').value });
};
$('#form-register').onsubmit = async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try { await connect(); } catch (err) { $('#login-error').textContent = err.message; return; }
  pendingLogin = $('#reg-name').value.trim();
  wsSend({ t: 'register', name: $('#reg-name').value, email: $('#reg-email').value,
           callsign: $('#reg-call').value, password: $('#reg-pw').value });
};

// ---------- password recovery ----------
$('#btn-forgot').onclick = () => {
  $('#login-error').textContent = '';
  $('#reset-id').value = $('#login-id').value;
  $('#form-login').classList.add('hidden'); $('.tabs').classList.add('hidden');
  $('#form-reset').classList.remove('hidden');
  ($('#reset-id').value ? $('#reset-code') : $('#reset-id')).focus();
};
$('#btn-reset-back').onclick = () => {
  $('#form-reset').classList.add('hidden'); $('.tabs').classList.remove('hidden');
  $('#form-login').classList.remove('hidden'); $('#login-error').textContent = '';
};
$('#form-reset').onsubmit = async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const id = $('#reset-id').value.trim();
  try { await connect(); } catch (err) { $('#login-error').textContent = err.message; return; }
  pendingLogin = id;
  wsSend({ t: 'reset-password', id, code: $('#reset-code').value, password: $('#reset-pw').value });
};
function showRecoveryKey(key, why) {
  $('#recovery-key').textContent = key;
  $('#recovery-why').textContent = why || 'Save this key somewhere safe (a password manager or a printout). If you forget your password it is the only way to get back in without asking the server\'s owner. It is shown only once.';
  showModal('recovery', true);
}
$('#btn-recovery-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#recovery-key').textContent); toast('Recovery key copied.'); } catch { toast('Select the key and copy it by hand.'); }
};
$('#btn-recovery-done').onclick = () => { showModal('recovery', false); $('#recovery-key').textContent = ''; };
$('#form-recovery').onsubmit = e => {
  e.preventDefault(); $('#sec-error').textContent = '';
  wsSend({ t: 'recovery-new', password: $('#rec-pw').value });
};

// ---------- two-factor ----------
function showTotpStage(on) {
  $('#form-totp').classList.toggle('hidden', !on);
  $('#form-login').classList.toggle('hidden', on);
  $('.tabs').classList.toggle('hidden', on);
  if (on) { $('#totp-code').value = ''; $('#totp-code').focus(); }
  else { $('#form-login').classList.toggle('hidden', $('#tab-register').classList.contains('active')); }
}
$('#form-totp').onsubmit = e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  wsSend({ t: 'login-totp', code: $('#totp-code').value });
};
$('#btn-totp-back').onclick = () => { showTotpStage(false); $('#login-error').textContent = ''; $('#login-pw').value = ''; };

function showSec(which) { // which: off | setup | codes | on
  for (const id of ['off', 'setup', 'codes', 'on']) $('#sec-' + id).classList.toggle('hidden', id !== which);
}
$('#btn-security').onclick = () => {
  $('#sec-error').textContent = '';
  $('#form-sec-enable').reset(); $('#form-sec-disable').reset();
  showSec(me.totp ? 'on' : 'off');
  showModal('security', true);
};
$('#btn-sec-close').onclick = () => { showModal('security', false); $('#sec-codes-list').textContent = ''; $('#sec-qr').removeAttribute('src'); };
$('#btn-sec-start').onclick = () => { $('#sec-error').textContent = ''; wsSend({ t: 'totp-setup' }); };
async function onTotpSetup(m) {
  $('#sec-qr').src = await api.makeQr(m.uri);
  $('#sec-secret').textContent = m.secret.match(/.{1,4}/g).join(' ');
  $('#form-sec-enable').reset();
  showSec('setup');
  $('#sec-code').focus();
}
$('#form-sec-enable').onsubmit = e => { e.preventDefault(); $('#sec-error').textContent = ''; wsSend({ t: 'totp-enable', code: $('#sec-code').value }); };
$('#form-sec-disable').onsubmit = e => {
  e.preventDefault(); $('#sec-error').textContent = '';
  wsSend({ t: 'totp-disable', password: $('#sec-pw').value, code: $('#sec-dcode').value });
};
$('#btn-sec-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#sec-codes-list').textContent); toast('Backup codes copied.'); } catch { toast('Select the codes and copy them by hand.'); }
};

async function logout() {
  loggedIn = false; wantedRoom = null;
  clearTimeout(reconnectTimer);
  hardLeave();
  wsSend({ t: 'logout', token });
  token = ''; me = null;
  await api.saveSettings({ token: '' }); // last login name stays so the field is prefilled next time
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  clearCallUi(); online = [];
  showLogin();
  api.hideToTray(); // Skippy keeps running in the system tray; click the tray icon to log in again
}
$('#btn-logout-lobby').onclick = logout;

// ---------- devices ----------
const selMic = $('#sel-mic'), selCam = $('#sel-cam'), selSpk = $('#sel-spk');
const cMic = $('#call-mic'), cCam = $('#call-cam'), cSpk = $('#call-spk');

async function refreshDevices() {
  let list = [];
  try { list = await navigator.mediaDevices.enumerateDevices(); } catch { /* ignore */ }
  const fill = (kind, sels, saved) => {
    const devs = list.filter(d => d.kind === kind);
    for (const sel of sels) {
      sel.innerHTML = '';
      if (!devs.length) sel.add(new Option('None found', ''));
      else {
        sel.add(new Option('System default', ''));
        devs.forEach((d, i) => { if (d.deviceId !== 'default' && d.deviceId !== 'communications') sel.add(new Option(d.label || `${kind} ${i + 1}`, d.deviceId)); });
      }
      sel.value = [...sel.options].some(o => o.value === saved) ? saved : '';
    }
  };
  fill('audioinput', [selMic, cMic], S.devices.mic);
  fill('videoinput', [selCam, cCam], S.devices.cam);
  fill('audiooutput', [selSpk, cSpk], S.devices.spk);
}
// A camera/mic that appears later (hot-plug, or the OS finishing enumeration at startup) is picked up automatically.
let deviceTimer;
navigator.mediaDevices.addEventListener('devicechange', () => {
  clearTimeout(deviceTimer);
  deviceTimer = setTimeout(async () => {
    await refreshDevices();
    if (!localStream) return;
    const live = kind => localStream.getTracks().some(t => t.kind === kind && t.readyState === 'live');
    const have = sel => [...sel.options].some(o => o.value);
    if ((!live('video') && (have(selCam) || selCam.options.length > 1)) || (!live('audio') && selMic.options.length > 1)) startLocal();
  }, 400);
});

async function onDeviceChosen(kind, value) {
  S.devices[kind] = value;
  api.saveSettings({ devices: S.devices });
  await refreshDevices();
  if (kind === 'spk') applySpeaker();
  else await startLocal();
}
for (const [sels, kind] of [[[selMic, cMic], 'mic'], [[selCam, cCam], 'cam'], [[selSpk, cSpk], 'spk']])
  for (const sel of sels) sel.onchange = () => onDeviceChosen(kind, sel.value);

function applySpeaker() {
  for (const v of document.querySelectorAll('video.remote'))
    if (v.setSinkId) v.setSinkId(S.devices.spk || '').catch(() => toast('Could not switch speaker.'));
}

// ---------- local media ----------
let meterCtx = null, meterRaf = 0;
function stopLocal() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  cancelAnimationFrame(meterRaf);
  if (meterCtx) { meterCtx.close().catch(() => {}); meterCtx = null; }
  $('#preview').srcObject = null;
}

async function startLocal() {
  const old = localStream;
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (S.devices.mic) audio.deviceId = { exact: S.devices.mic };
  const video = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } };
  if (S.devices.cam) video.deviceId = { exact: S.devices.cam };

  let stream = null, note = '';
  if (old) old.getTracks().forEach(t => t.stop()); // release the device before reopening it
  for (const attempt of [{ audio, video }, { audio, video: false }, { audio: false, video }]) {
    try { stream = await navigator.mediaDevices.getUserMedia(attempt); break; } catch (e) { note = e.name; }
  }
  if (!stream) stream = new MediaStream();
  localStream = stream;
  for (const t of stream.getTracks()) t.onended = () => {
    if (localStream !== stream) return; // we replaced it ourselves
    toast(`Your ${t.kind === 'audio' ? 'microphone' : 'camera'} was disconnected.`);
    refreshDevices(); updateSelfTile(); applyTrackStates();
  };
  const hasA = stream.getAudioTracks().length > 0, hasV = stream.getVideoTracks().length > 0;
  $('#preview-note').textContent = hasV ? '' : (note === 'NotAllowedError' ? 'Camera access was denied.' : 'No camera available.');
  if (!hasA) toast('No microphone available - others will not hear you.');
  applyTrackStates();
  $('#preview').srcObject = stream;
  await refreshDevices(); // labels become available once permission is granted
  startMeter(stream);

  // swap the new tracks into every live connection without renegotiating
  for (const p of peers.values()) {
    await p.senders.audio?.replaceTrack(stream.getAudioTracks()[0] || null);
    await p.senders.video?.replaceTrack(stream.getVideoTracks()[0] || null);
  }
  updateSelfTile();
}

function applyTrackStates() {
  localStream?.getAudioTracks().forEach(t => t.enabled = micOn);
  localStream?.getVideoTracks().forEach(t => t.enabled = camOn);
  $('#btn-mic').textContent = micOn ? 'Mute' : 'Unmute';
  $('#btn-mic').classList.toggle('off', !micOn);
  $('#btn-cam').textContent = camOn ? 'Stop video' : 'Start video';
  $('#btn-cam').classList.toggle('off', !camOn);
  $('#self-tile')?.classList.toggle('novideo', !camOn || !localStream?.getVideoTracks().length);
  for (const p of peers.values()) sendState(p);
}
function sendState(p) {
  if (p.dc?.readyState === 'open') p.dc.send(JSON.stringify({ k: 'state', mic: micOn, cam: camOn }));
}
$('#btn-mic').onclick = () => { micOn = !micOn; applyTrackStates(); };
$('#btn-cam').onclick = () => { camOn = !camOn; applyTrackStates(); };

function startMeter(stream) {
  cancelAnimationFrame(meterRaf);
  if (meterCtx) { meterCtx.close().catch(() => {}); meterCtx = null; }
  if (!stream.getAudioTracks().length) { $('#mic-level').style.width = '0'; return; }
  meterCtx = new AudioContext();
  const an = meterCtx.createAnalyser(); an.fftSize = 512;
  meterCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const tick = () => {
    an.getByteTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    $('#mic-level').style.width = Math.min(100, peak / 128 * 140) + '%';
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

// ---------- lobby ----------
async function showLobby() {
  room = null;
  show('screen-lobby');
  $('#join-error').textContent = '';
  await startLocal();
  $('#room-name').focus();
}
function renderRecent(list) {
  const box = $('#recent-rooms'); box.innerHTML = '';
  if (!list.length) { box.textContent = 'None yet.'; box.classList.add('muted'); return; }
  box.classList.remove('muted');
  for (const r of list) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = r;
    b.onclick = () => joinRoom(r);
    box.appendChild(b);
  }
}
function joinRoom(name) {
  $('#join-error').textContent = '';
  wantedRoom = name; dmWith = null;
  wsSend({ t: 'join', room: name });
}
$('#form-join').onsubmit = e => { e.preventDefault(); joinRoom($('#room-name').value.trim()); };

// ---------- call ----------
function onJoined(m) {
  room = m.room; wantedRoom = null;
  show('screen-call');
  $('#call-room').textContent = room.startsWith('@') ? '📞 ' + (dmWith ? dmWith.name : 'Direct call') : '# ' + room;
  $('#conn-banner').classList.add('hidden');
  roster.clear();
  roster.set(m.me.id, m.me);
  for (const p of m.peers) roster.set(p.id, p);
  $('#grid').innerHTML = '';
  addSelfTile();
  for (const p of m.peers) makePeer(p, true);
  renderHistory(m.history);
  updateCount();
  applyTrackStates();
  refreshDevices();
}

function updateCount() { $('#call-count').textContent = `${roster.size} / 10`; layoutGrid(); }

function layoutGrid() {
  const n = $('#grid').children.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  $('#grid').style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
}

function makeTile(user, self) {
  const tile = document.createElement('div');
  tile.className = 'tile novideo' + (self ? ' self' : '');
  tile.innerHTML = '<div class="avatar"></div><video autoplay playsinline></video><div class="label"></div><div class="state"></div>';
  tile.querySelector('.avatar').textContent = (user.name[0] || '?').toUpperCase();
  tile.querySelector('.label').textContent = user.name + (self ? ' (you)' : '');
  const v = tile.querySelector('video');
  if (self) v.muted = true; else v.classList.add('remote');
  return tile;
}
function addSelfTile() {
  const tile = makeTile(me, true); tile.id = 'self-tile';
  $('#grid').appendChild(tile);
  updateSelfTile();
}
function updateSelfTile() {
  const tile = $('#self-tile'); if (!tile) return;
  tile.querySelector('video').srcObject = localStream;
  tile.classList.toggle('novideo', !camOn || !localStream?.getVideoTracks().some(t => t.readyState === 'live'));
}

function iceConfig() { return { iceServers: S.iceServers }; }

// The newcomer sends the first offer; people already in the room wait for it (avoids offer collisions).
function makePeer(user, initiator = false) {
  if (peers.has(user.id)) return peers.get(user.id);
  const pc = new RTCPeerConnection(iceConfig());
  const p = { user, pc, initiator, polite: me.id > user.id, making: false, ignore: false, senders: {}, stream: new MediaStream(),
              dc: null, chain: Promise.resolve(), sigChain: Promise.resolve(), incoming: null, tile: makeTile(user, false) };
  peers.set(user.id, p);
  $('#grid').appendChild(p.tile);
  const vid = p.tile.querySelector('video');
  vid.srcObject = p.stream;
  if (vid.setSinkId && S.devices.spk) vid.setSinkId(S.devices.spk).catch(() => {});

  for (const kind of ['audio', 'video']) {
    const tr = pc.addTransceiver(kind, { direction: 'sendrecv' });
    p.senders[kind] = tr.sender;
    const track = localStream?.[kind === 'audio' ? 'getAudioTracks' : 'getVideoTracks']()[0];
    if (track) tr.sender.replaceTrack(track).catch(() => {});
  }
  p.dc = pc.createDataChannel('skippy', { negotiated: true, id: 0 });
  p.dc.binaryType = 'arraybuffer';
  p.dc.bufferedAmountLowThreshold = 256 * 1024;
  p.dc.onmessage = ev => onDataMessage(p, ev.data);
  p.dc.onopen = () => sendState(p);

  pc.onnegotiationneeded = async () => {
    if (!p.initiator && !pc.remoteDescription) return;
    try {
      p.making = true;
      await pc.setLocalDescription();
      wsSend({ t: 'signal', to: user.id, data: { description: pc.localDescription } });
    } catch (e) { console.warn('negotiation', e); } finally { p.making = false; }
  };
  pc.onicecandidate = ev => { if (ev.candidate) wsSend({ t: 'signal', to: user.id, data: { candidate: ev.candidate } }); };
  pc.ontrack = ev => {
    p.stream.addTrack(ev.track);
    ev.track.onmute = () => updatePeerVideo(p);
    ev.track.onunmute = () => updatePeerVideo(p);
    updatePeerVideo(p);
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    p.tile.querySelector('.state').textContent = st === 'connected' ? '' : st;
    if (st === 'failed') pc.restartIce();
  };
  p.tile.querySelector('.state').textContent = 'connecting';
  updateBitrates();
  layoutGrid();
  return p;
}

function updatePeerVideo(p) {
  const vt = p.stream.getVideoTracks()[0];
  p.tile.classList.toggle('novideo', !vt || vt.muted || p.camOff);
}

async function onSignal(from, data) {
  const user = roster.get(from);
  if (!user || !room) return;
  const p = peers.get(from) || makePeer(user);
  // Handle one peer's signals strictly in order, or a candidate can overtake the offer it belongs to.
  p.sigChain = p.sigChain.then(() => handleSignal(p, from, data));
}

async function handleSignal(p, from, data) {
  const pc = p.pc;
  try {
    if (data.description) {
      const collision = data.description.type === 'offer' && (p.making || pc.signalingState !== 'stable');
      p.ignore = !p.polite && collision;
      if (p.ignore) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        wsSend({ t: 'signal', to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignore) throw e; }
    }
  } catch (e) { console.warn('signal error', e); }
}

// Fewer people -> better quality; keep total upstream sane in a full mesh.
function updateBitrates() {
  const n = Math.max(1, peers.size);
  const maxBitrate = n <= 2 ? 800_000 : n <= 5 ? 400_000 : 200_000;
  for (const p of peers.values()) {
    const s = p.senders.video; if (!s) continue;
    const prm = s.getParameters();
    if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
    prm.encodings[0].maxBitrate = maxBitrate;
    s.setParameters(prm).catch(() => {});
  }
}

function closePeer(id) {
  const p = peers.get(id); if (!p) return;
  if (p.incoming && !p.incoming.skip) { // transfer cut short
    const { id: fid, f } = p.incoming;
    f.failed = true; api.fileDiscard(fid); refreshFileEls(fid);
  }
  p.dc?.close(); p.pc.close(); p.tile.remove();
  peers.delete(id);
  updateBitrates(); layoutGrid();
}
function closeAllPeers() { for (const id of [...peers.keys()]) closePeer(id); }

function hardLeave() {
  closeAllPeers();
  if (room) wsSend({ t: 'leave' });
  room = null; roster.clear();
}
$('#btn-leave').onclick = async () => { wantedRoom = null; hardLeave(); await showLobby(); };

// ---------- chat ----------
const log = $('#chat-log');
function sysMsg(text) {
  const d = document.createElement('div'); d.className = 'sys'; d.textContent = text;
  log.appendChild(d); scrollLog();
}
function scrollLog() { log.scrollTop = log.scrollHeight; }

function renderHistory(list) {
  log.innerHTML = '';
  if (list.length) sysMsg('— earlier messages —');
  for (const m of list) addMessage(m, false);
  if (list.length) sysMsg('— now —');
  scrollLog();
}

function addMessage(m, live) {
  const d = document.createElement('div');
  d.className = 'msg' + (m.userId === me.id ? ' mine' : '') + (m.kind === 'file' ? ' file' : '');
  const meta = document.createElement('div'); meta.className = 'meta';
  const b = document.createElement('b'); b.textContent = m.name;
  meta.append(b, ' · ' + fmtTime(m.ts));
  const body = document.createElement('div'); body.className = 'body';
  if (m.kind === 'file') {
    d.dataset.fileId = m.fileId || '';
    d.dataset.name = m.fileName; d.dataset.size = m.fileSize;
    d.dataset.mine = m.userId === me.id ? '1' : '';
    d.append(meta, body);
    log.appendChild(d);
    updateFileEl(d, m.fileId);
  } else {
    body.textContent = m.text;
    d.append(meta, body);
    log.appendChild(d);
  }
  if (live) scrollLog();
}

$('#chat-form').onsubmit = e => {
  e.preventDefault();
  const text = $('#chat-input').value;
  if (!text.trim()) return;
  wsSend({ t: 'chat', text });
  $('#chat-input').value = '';
};

// ---------- file transfer ----------
$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').onchange = () => {
  const f = $('#file-input').files[0];
  $('#file-input').value = '';
  if (f) sendFile(f);
};

function sendFile(file) {
  if (!room) return;
  if (file.size > MAX_FILE) return toast(`File too large (limit ${fmtSize(MAX_FILE)}).`);
  if (!peers.size) toast('Nobody else is in the room - the file will only be logged in chat.');
  const fileId = uuid();
  files.set(fileId, { name: file.name, size: file.size, mine: true, blob: file, done: true, sent: 0, targets: 0 });
  wsSend({ t: 'file-announce', fileId, fileName: file.name, fileSize: file.size });
  // Push the bytes once the announcement is in the log (peers render the chat entry as it arrives).
  const f = files.get(fileId);
  const targets = [...peers.values()].filter(p => p.dc?.readyState === 'open');
  f.targets = targets.length;
  for (const p of targets) {
    p.chain = p.chain.then(() => pushFile(p, fileId, file)).catch(() => {});
  }
}

async function pushFile(p, fileId, file) {
  const dc = p.dc, f = files.get(fileId);
  if (!dc || dc.readyState !== 'open') return;
  dc.send(JSON.stringify({ k: 'start', id: fileId, name: file.name, size: file.size }));
  for (let off = 0; off < file.size; off += CHUNK) {
    if (dc.readyState !== 'open') return;
    if (dc.bufferedAmount > 1024 * 1024)
      await new Promise(r => dc.addEventListener('bufferedamountlow', r, { once: true }));
    const buf = await file.slice(off, off + CHUNK).arrayBuffer();
    dc.send(buf);
    f.sent += buf.byteLength;
    refreshFileEls(fileId);
  }
  dc.send(JSON.stringify({ k: 'end', id: fileId }));
}

function onDataMessage(p, data) {
  if (typeof data === 'string') {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.k === 'state') { p.camOff = !m.cam; updatePeerVideo(p); return; }
    if (m.k === 'start') {
      if (typeof m.size !== 'number' || m.size > MAX_FILE) { p.incoming = { skip: true }; toast(`${p.user.name} sent a file that is too large; skipped.`); return; }
      if (typeof m.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(m.id)) return;
      const f = { name: String(m.name).slice(0, 200), size: m.size, got: 0, done: false, from: p.user.name };
      files.set(m.id, f);
      api.fileOpen(m.id); // main process streams it to a temp file
      p.incoming = { id: m.id, f };
      refreshFileEls(m.id);
    } else if (m.k === 'end' && p.incoming && !p.incoming.skip) {
      const { id, f } = p.incoming;
      p.incoming = null;
      api.fileClose(id).then(n => {
        if (n !== f.size) { f.failed = true; api.fileDiscard(id); } else f.done = true;
        refreshFileEls(id);
        if (f.done) toast(`Received ${f.name} from ${p.user.name}`);
      });
    } else if (m.k === 'end') p.incoming = null;
    return;
  }
  const inc = p.incoming;
  if (!inc || inc.skip) return;
  api.fileWrite(inc.id, data);
  inc.f.got += data.byteLength;
  if ((inc.f.got / CHUNK | 0) % 8 === 0) refreshFileEls(inc.id);
}

function refreshFileEls(fileId) {
  for (const el of log.querySelectorAll('.msg.file')) if (el.dataset.fileId === fileId) updateFileEl(el, fileId);
}

function updateFileEl(el, fileId) {
  const body = el.querySelector('.body');
  const f = files.get(fileId);
  const name = el.dataset.name, size = Number(el.dataset.size);
  body.innerHTML = '';
  const title = document.createElement('div');
  title.textContent = `📎 ${name} (${fmtSize(size)})`;
  body.appendChild(title);
  const status = document.createElement('div'); status.className = 'meta';
  body.appendChild(status);
  if (!f) { status.textContent = 'File not available (it is only delivered to people present when it was sent).'; return; }
  if (f.mine) {
    const total = f.size * f.targets;
    const pct = total ? Math.min(100, f.sent / total * 100) : 100;
    status.textContent = f.targets === 0 ? 'Sent (no one else was connected)' : pct >= 100 ? `Sent to ${f.targets} participant${f.targets > 1 ? 's' : ''}` : `Sending… ${pct.toFixed(0)}%`;
    if (total && pct < 100) addBar(body, pct);
    return;
  }
  if (f.failed) { status.textContent = 'Transfer interrupted.'; return; }
  if (!f.done) {
    const pct = f.size ? f.got / f.size * 100 : 0;
    status.textContent = `Receiving… ${pct.toFixed(0)}%`;
    addBar(body, pct);
    return;
  }
  const a = document.createElement('a');
  a.textContent = 'Save';
  a.onclick = async () => {
    const r = await api.fileSave(fileId, f.name);
    if (r.ok) toast(`Saved to ${r.path}`); else if (!r.canceled) toast(r.error || 'Could not save the file.');
  };
  status.append('Received · ', a);
}
function addBar(parent, pct) {
  const bar = document.createElement('div'); bar.className = 'bar';
  const inner = document.createElement('div'); inner.style.width = pct + '%';
  bar.appendChild(inner); parent.appendChild(bar);
}

// ---------- direct calls ----------
function showModal(which, on) { $('#modal-' + which).classList.toggle('hidden', !on); }
function clearCallUi() {
  incomingCall = outgoingCall = null; stopRing();
  for (const m of ['incoming', 'calling', 'people', 'security']) showModal(m, false);
}

let ringCtx = null, ringTimer = null;
function ring(kind) {
  stopRing();
  try {
    const ctx = ringCtx = new AudioContext();
    if (ctx.setSinkId && S.devices.spk) ctx.setSinkId(S.devices.spk).catch(() => {});
    const beep = () => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = kind === 'in' ? 880 : 440; g.gain.value = 0.12;
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.35);
    };
    beep();
    ringTimer = setInterval(beep, kind === 'in' ? 1400 : 2500);
  } catch { /* no audio output */ }
}
function stopRing() {
  clearInterval(ringTimer); ringTimer = null;
  if (ringCtx) { ringCtx.close().catch(() => {}); ringCtx = null; }
}

function renderPeople() {
  const box = $('#people-list'); box.innerHTML = '';
  const others = online.filter(u => !me || u.id !== me.id);
  if (!others.length) { box.textContent = 'Nobody else is online.'; box.classList.add('muted'); return; }
  box.classList.remove('muted');
  for (const u of others) {
    const row = document.createElement('div'); row.className = 'person';
    const nm = document.createElement('span'); nm.textContent = u.name + (u.callsign ? ` (${u.callsign})` : '');
    const b = document.createElement('button'); b.className = 'primary'; b.type = 'button'; b.textContent = 'Call';
    b.onclick = () => placeCall(u.id);
    row.append(nm, b); box.appendChild(row);
  }
}
function placeCall(to) {
  $('#call-error').textContent = '';
  showModal('people', false);
  wsSend({ t: 'call', to });
}
function openPeople() { $('#call-error').textContent = ''; renderPeople(); showModal('people', true); }
$('#btn-call-lobby').onclick = $('#btn-call-call').onclick = openPeople;
$('#btn-people-close').onclick = () => showModal('people', false);
$('#form-call-name').onsubmit = e => {
  e.preventDefault();
  const v = $('#call-name').value.trim();
  if (v) { $('#call-name').value = ''; placeCall(v); }
};
$('#btn-cancel-call').onclick = () => {
  if (outgoingCall) wsSend({ t: 'call-cancel', callId: outgoingCall.callId });
  outgoingCall = null; showModal('calling', false); stopRing();
};

function onIncomingCall(m) {
  if (incomingCall) return wsSend({ t: 'call-answer', callId: m.callId, accept: false }); // already ringing: decline the second
  incomingCall = m;
  $('#incoming-title').textContent = m.from.name + (m.from.callsign ? ` (${m.from.callsign})` : '');
  showModal('incoming', true);
  ring('in');
  api.showWindow(); // bring Skippy out of the tray
  try { new Notification('Skippy', { body: `Incoming call from ${m.from.name}` }); } catch { /* ignore */ }
}
$('#btn-accept').onclick = () => {
  if (!incomingCall) return;
  wsSend({ t: 'call-answer', callId: incomingCall.callId, accept: true });
  incomingCall = null; showModal('incoming', false); stopRing();
};
$('#btn-decline').onclick = () => {
  if (!incomingCall) return;
  wsSend({ t: 'call-answer', callId: incomingCall.callId, accept: false });
  incomingCall = null; showModal('incoming', false); stopRing();
};

function startDirect(m) {
  outgoingCall = null; showModal('calling', false); showModal('incoming', false); stopRing();
  dmWith = m.with;
  closeAllPeers(); // leave whatever room we were in; the server moves us when we join
  wantedRoom = m.room;
  wsSend({ t: 'join', room: m.room });
}

// ---------- update check ----------
function newer(a, b) { // is version a newer than b?
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}
async function checkForUpdates() {
  if (S.checkUpdates === false) return;
  const info = await api.checkUpdate(($('#server-url').value || S.serverUrl).trim());
  if (!info || !info.version || !newer(info.version, S.version)) return;
  $('#update-text').textContent = `Skippy ${info.version} is available (you have ${S.version}).` + (info.notes ? ' ' + info.notes : '');
  $('#btn-update-get').classList.toggle('hidden', !info.url);
  $('#btn-update-get').onclick = () => api.openExternal(info.url);
  $('#btn-update-dismiss').onclick = () => $('#update-banner').classList.add('hidden');
  $('#update-banner').classList.remove('hidden');
}

// ---------- startup ----------
(async function init() {
  S = await api.loadSettings();
  S.devices = { mic: '', cam: '', spk: '', ...(S.devices || {}) };
  S.iceServers = S.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
  $('#server-url').value = S.serverUrl;
  $('#chk-updates').checked = S.checkUpdates !== false;
  $('#chk-updates').onchange = e => { S.checkUpdates = e.target.checked; api.saveSettings({ checkUpdates: e.target.checked }); };
  checkForUpdates();
  $('#chk-autostart').checked = !!S.autostart;
  $('#chk-autostart').onchange = e => api.setAutostart(e.target.checked);
  for (const id of ['#version-login', '#version-lobby']) $(id).textContent = 'Skippy v' + S.version;
  $('#login-id').value = S.lastLogin || '';

  // Auto sign-in as the last user, if their session is still valid.
  if (S.token) {
    show('screen-login');
    try { await connect(); wsSend({ t: 'resume', token: S.token }); token = S.token; return; }
    catch { $('#login-error').textContent = 'Could not reach the server - log in when it is available.'; }
  }
  showLogin();
})();
