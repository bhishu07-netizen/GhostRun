import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import '@fontsource/kanit/900-italic.css';
import './style.css';
import { rpc, profile, session, auth } from './api.js';
import { createMap, avatarMarker, circle, CAMPUS_VIEW } from './map.js';
import { openCamera } from './camera.js';

const AVATARS = [
  ['hunter', 'The Hunter'], ['ghost', 'The Ghost'], ['runner', 'The Runner'], ['spotter', 'The Spotter'],
  ['sneak', 'The Sneak'], ['camper', 'The Camper'], ['strategist', 'The Strategist'], ['rebel', 'The Rebel'],
  ['shadow', 'The Shadow'], ['survivor', 'The Survivor'], ['operative', 'The Operative'], ['scout', 'The Scout'],
];
const MODES = {
  quick: { label: 'Quick', sub: '15 min · no pings' },
  hour: { label: '1 hour', sub: 'pings + photo hints' },
  endless: { label: 'Endless', sub: 'until everyone is caught' },
};
const RING = { hunter: '#EC4899', ghost: '#818CF8' };

const screen = document.getElementById('screen');
const hud = document.getElementById('hud');
const modal = document.getElementById('modal');
const toastEl = document.getElementById('toast');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (sec) => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };

let toastTimer;
function toast(msg, ms = 3500) {
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}
const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch { /* not supported */ } };

const map = createMap((m) => console.warn(m));
map.setOrbit(true);

// ------------------------------------------------------------------ profile + age gate
function renderProfile() {
  stopPolling(); hud.hidden = true; map.setOrbit(true);
  const p = profile.get() || {};
  const thisYear = new Date().getFullYear();
  screen.innerHTML = `
    <section class="card sheet">
      <h1 class="logo big">GHOSTRUN</h1>
      <p class="muted">Pick who you'll be on the map.</p>
      <label class="field"><span>Your name</span><input id="pName" maxlength="20" autocomplete="nickname" value="${esc(p.name || '')}" placeholder="Bhishu"></label>
      <div class="avatars" role="radiogroup" aria-label="Choose an avatar">
        ${AVATARS.map(([k, label]) => `<button class="av ${p.avatar === k ? 'on' : ''}" role="radio" aria-checked="${p.avatar === k}" data-av="${k}"><img src="/a/${k}.png" alt=""><span>${label.replace('The ', '')}</span></button>`).join('')}
      </div>
      <label class="field"><span>Year you were born</span>
        <select id="pYear"><option value="">Select</option>${Array.from({ length: 70 }, (_, i) => thisYear - 6 - i).map((y) => `<option ${p.year == y ? 'selected' : ''}>${y}</option>`).join('')}</select>
      </label>
      <p class="fine">Ghostrun shares your live location with the other players in your game only, and deletes it when the game ends. You must be 13 or older to play.</p>
      <p class="err" id="pErr" hidden></p>
      <button class="btn primary" id="pGo">Let's play</button>
    </section>`;
  let chosen = p.avatar || null;
  screen.querySelectorAll('.av').forEach((b) => b.onclick = () => {
    chosen = b.dataset.av;
    screen.querySelectorAll('.av').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
  });
  screen.querySelector('#pGo').onclick = () => {
    const name = screen.querySelector('#pName').value.trim();
    const year = +screen.querySelector('#pYear').value;
    const err = screen.querySelector('#pErr');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (!name) return fail('Add a name so friends know who you are.');
    if (!chosen) return fail('Pick an avatar.');
    if (!year) return fail('Select the year you were born.');
    if (thisYear - year < 13) return fail('Sorry, Ghostrun is for players 13 and older.');
    profile.set({ name, avatar: chosen, year, ageOk: true });
    renderHome();
  };
}

// ------------------------------------------------------------------ home
function renderHome() {
  stopPolling(); hud.hidden = true; clearGameMap(); map.setOrbit(true);
  const p = profile.get();
  let mode = 'hour';
  screen.innerHTML = `
    <section class="card sheet">
      <div class="row between">
        <h1 class="logo">GHOSTRUN</h1>
        <button class="chip me" id="hEdit"><img src="/a/${esc(p.avatar)}.png" alt=""><span>${esc(p.name)}</span></button>
      </div>
      <p class="muted">Real-life manhunt on campus. Hide, hunt, don't get caught.</p>
      <div class="modes" role="radiogroup" aria-label="Game mode">
        ${Object.entries(MODES).map(([k, m]) => `<button class="mode ${k === mode ? 'on' : ''}" role="radio" aria-checked="${k === mode}" data-mode="${k}"><b>${m.label}</b><span>${m.sub}</span></button>`).join('')}
      </div>
      <button class="btn primary" id="hHost">Host a hunt</button>
      <div class="joinrow">
        <label class="field grow"><span>Lobby code</span><input id="hCode" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="K7QX"></label>
        <button class="btn soft" id="hJoin">Join</button>
      </div>
      <p class="err" id="hErr" hidden></p>
    </section>`;
  const err = screen.querySelector('#hErr');
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  screen.querySelectorAll('.mode').forEach((b) => b.onclick = () => {
    mode = b.dataset.mode;
    screen.querySelectorAll('.mode').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
  });
  screen.querySelector('#hEdit').onclick = renderProfile;
  screen.querySelector('#hHost').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await rpc('create_game', { p_mode: mode, p_name: p.name, p_avatar: p.avatar, p_age_ok: !!p.ageOk });
      session.set(r); enterGame();
    } catch (x) { fail(x.message); e.target.disabled = false; }
  };
  screen.querySelector('#hJoin').onclick = async (e) => {
    const code = screen.querySelector('#hCode').value.trim().toUpperCase();
    if (code.length !== 4) return fail('Enter the 4-letter lobby code.');
    e.target.disabled = true;
    try {
      const r = await rpc('join_game', { p_code: code, p_name: p.name, p_avatar: p.avatar, p_age_ok: !!p.ageOk });
      session.set(r); enterGame();
    } catch (x) { fail(x.message); e.target.disabled = false; }
  };
}

// ------------------------------------------------------------------ polling
let pollTimer = null, S = null, clockOffset = 0, photosSince = null;
const photoCache = new Map(); // key player_id:seq -> data url
const toldClaims = new Set(); // rejected catch claims we've already told the hunter about
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
function enterGame() { S = null; photoCache.clear(); photosSince = null; poll(); stopPolling(); pollTimer = setInterval(poll, 3000); }
const now = () => Date.now() + clockOffset;
const ts = (iso) => (iso ? new Date(iso).getTime() : null);

let busy = false;
async function poll() {
  if (busy) return; busy = true;
  try {
    const st = await rpc('get_state', { ...auth(), p_photos_since: photosSince });
    clockOffset = ts(st.now) - Date.now();
    (st.photos || []).forEach((h) => {
      photoCache.set(`${h.player_id}:${h.seq}`, h.photo);
      if (!photosSince || h.uploaded_at > photosSince) photosSince = h.uploaded_at;
    });
    const prev = S; S = st;
    detectEvents(prev, st);
    if (st.game.status === 'lobby') renderLobby();
    else if (st.game.status === 'live') renderLive();
    else renderResults();
  } catch (x) {
    if (/not allowed/i.test(x.message)) { session.clear(); stopPolling(); renderHome(); toast('That game is no longer available.'); }
    else toast(x.message);
  } finally { busy = false; }
}

function playerById(id) { return S.players.find((p) => p.id === id); }

// tell the server we're gone (host passes on, empty sides end the game), then forget the session locally
function leaveGame() {
  const s = session.get();
  if (s) rpc('leave_game', { p_player: s.player_id, p_secret: s.secret }).catch(() => {});
  session.clear(); stopPolling(); clearGameMap(); modal.innerHTML = ''; renderHome();
}

// catches, team switches, pings: the moments everyone should feel
function detectEvents(prev, st) {
  if (!prev || prev.game.status !== 'live' || st.game.status !== 'live') return;
  const before = new Set(prev.players.filter((p) => p.caught).map((p) => p.id));
  st.players.filter((p) => p.caught && !before.has(p.id)).forEach((p) => {
    const by = st.players.find((x) => x.id === p.caught_by);
    caughtSplash(p.id === st.me.id ? 'You got caught! You hunt now.' : `${by ? by.name : 'A hunter'} got ${p.name}`,
      st.players.filter((x) => x.team === 'ghost').length);
  });
  (st.my_claims || []).forEach((c) => {
    if (c.status === 'rejected' && !toldClaims.has(c.id)) {
      toldClaims.add(c.id);
      const g = st.players.find((x) => x.id === c.ghost_id);
      toast(`${g ? g.name : 'The ghost'} says they escaped.`);
    }
  });
  if (prev.me.team === 'ghost' && st.me.team === 'hunter' && cameraOpen && cam) cam.close();
  if (st.game.ping_seq > prev.game.ping_seq) {
    buzz([60, 40, 60]);
    toast(st.me.team === 'hunter' ? 'Ping! Ghost positions updated.' : 'Ping! Hunters just saw where you are. Move!');
  }
}

function caughtSplash(text, left) {
  buzz([80, 40, 140]);
  modal.innerHTML = `<div class="splash" role="alert"><img src="/e/out.png" alt=""><b>CAUGHT!</b><span>${esc(text)}</span><em>${left} ghost${left === 1 ? '' : 's'} left</em></div>`;
  setTimeout(() => { if (modal.querySelector('.splash')) modal.innerHTML = ''; }, 2200);
}

// ------------------------------------------------------------------ lobby
function renderLobby() {
  hud.hidden = true; map.setOrbit(true);
  const g = S.game, me = S.me, isHost = g.host_id === me.id;
  const hunters = S.players.filter((p) => p.team === 'hunter'), ghosts = S.players.filter((p) => p.team === 'ghost');
  const n = S.players.length;
  const base = n <= 5 ? 15 : n <= 7 ? 20 : 25;
  const ladder = [0, 1, 2, 3].map((c) => Math.max(5, base - 5 * c));
  const list = (arr) => arr.map((p) => `<button class="pl ${p.id === me.id ? 'mine' : ''}" data-id="${p.id}" ${(!isHost && p.id !== me.id) ? 'disabled' : ''}>
      <img src="/a/${esc(p.avatar)}.png" alt=""><span>${esc(p.id === me.id ? 'You' : p.name)}${p.id === g.host_id ? ' · host' : ''}</span></button>`).join('') || '<p class="muted small">Nobody yet</p>';
  screen.innerHTML = `
    <section class="card sheet">
      <div class="row between">
        <button class="chip" id="lLeave">Leave</button>
        <span class="logo small">LOBBY</span>
        <span class="chip ghosty">${n}/12</span>
      </div>
      <div class="codebox">
        <span class="muted small">Share this code</span>
        <b>${esc(g.code)}</b>
        <button class="btn soft slim" id="lShare">Invite friends</button>
      </div>
      ${isHost ? `<div class="modes" role="radiogroup" aria-label="Game mode">${Object.entries(MODES).map(([k, m]) => `<button class="mode ${k === g.mode ? 'on' : ''}" data-mode="${k}" role="radio" aria-checked="${k === g.mode}"><b>${m.label}</b><span>${m.sub}</span></button>`).join('')}</div>`
        : `<p class="pill">${MODES[g.mode].label} · ${MODES[g.mode].sub}</p>`}
      <div class="teams">
        <div class="team hunt"><h3>Hunters · ${hunters.length}</h3>${list(hunters)}</div>
        <div class="team ghost"><h3>Ghosts · ${ghosts.length}</h3>${list(ghosts)}</div>
      </div>
      <p class="small muted">${isHost ? 'Tap a player to switch their team.' : 'Tap yourself to switch team.'}</p>
      ${g.mode === 'quick' ? '<p class="small">Quick mode: no pings. Pure hide and seek.</p>'
        : `<div class="ladder"><span>Pings for ${n} players</span>${ladder.map((m, i) => `<b>${m} min<em>${i === 0 ? 'start' : `${i} catch${i > 1 ? 'es' : ''}`}</em></b>`).join('')}</div>`}
      ${isHost ? '<button class="btn primary" id="lStart">Start the hunt</button>' : '<p class="waiting">Waiting for the host to start…</p>'}
      <p class="err" id="lErr" hidden></p>
    </section>`;
  const err = screen.querySelector('#lErr');
  screen.querySelector('#lLeave').onclick = leaveGame;
  screen.querySelector('#lShare').onclick = async () => {
    const text = `Join my Ghostrun hunt! Code: ${g.code} ${location.origin}`;
    try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast('Invite copied'); } }
    catch { /* cancelled */ }
  };
  screen.querySelectorAll('.pl').forEach((b) => b.onclick = async () => {
    const p = playerById(b.dataset.id);
    try { await rpc('set_team', { ...auth(), p_target: p.id, p_team: p.team === 'hunter' ? 'ghost' : 'hunter' }); poll(); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
  });
  screen.querySelectorAll('.mode').forEach((b) => b.onclick = async () => { await rpc('set_mode', { ...auth(), p_mode: b.dataset.mode }); poll(); });
  const start = screen.querySelector('#lStart');
  if (start) start.onclick = async () => {
    start.disabled = true;
    try { await rpc('start_game', auth()); poll(); } catch (x) { err.textContent = x.message; err.hidden = false; start.disabled = false; }
  };
}

// ------------------------------------------------------------------ live game
let geoWatch = null, lastSent = 0, myPos = null, wakeLock = null;
const markers = new Map(); // key -> marker
let meMarker = null, cameraOpen = false, cam = null;

function startGeo() {
  if (geoWatch !== null || !('geolocation' in navigator)) return;
  geoWatch = navigator.geolocation.watchPosition((pos) => {
    myPos = [pos.coords.longitude, pos.coords.latitude, pos.coords.accuracy];
    if (Date.now() - lastSent > 5000) {
      lastSent = Date.now();
      rpc('update_location', { ...auth(), p_lat: myPos[1], p_lng: myPos[0], p_acc: Math.round(myPos[2]) }).catch(() => {});
    }
    drawMe();
  }, (e) => {
    toast(e.code === 1 ? 'Location is blocked. Allow location for this site so the game can work.' : 'GPS signal is weak. Step outside if you can.', 6000);
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  keepAwake();
}
async function keepAwake() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* optional */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && geoWatch !== null) keepAwake(); });
function stopGeo() { if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch); geoWatch = null; try { wakeLock && wakeLock.release(); } catch { /* ignore */ } }

let centered = false;
function drawMe() {
  if (!myPos || !S) return;
  if (!meMarker) { meMarker = avatarMarker(map, { avatar: S.me.avatar, label: 'You', ring: RING[S.me.team], size: 46 }); meMarker.getElement().classList.add('me'); }
  meMarker.getElement().style.setProperty('--ring', RING[S.me.team]);
  meMarker.setLngLat(myPos).addTo(map);
  const src = map.getSource('acc');
  if (src) src.setData(circle(myPos, Math.min(myPos[2], 150)));
  if (!centered) { centered = true; map.flyTo({ center: myPos, zoom: 17.2, pitch: 50 }); }
}
map.on('load', () => {
  map.addSource('acc', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': '#818CF8', 'fill-opacity': 0.14 } });
});

function setMarker(key, opts, lngLat, opacity = 1) {
  let m = markers.get(key);
  if (!m) { m = avatarMarker(map, opts); markers.set(key, m); }
  m.setLabel(opts.label); m.setLngLat(lngLat).addTo(map); m.setOpacity(opacity);
  return m;
}
function clearGameMap() {
  markers.forEach((m) => m.remove()); markers.clear();
  if (meMarker) { meMarker.remove(); meMarker = null; }
  const src = map.getSource && map.getSource('acc');
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
  stopGeo(); centered = false; myPos = null;
}

function renderLive() {
  screen.innerHTML = '';
  map.setOrbit(false);
  startGeo();
  const g = S.game, me = S.me, t = now();
  const ghostsLeft = S.players.filter((p) => p.team === 'ghost').length;
  const headLeft = (ts(g.hunt_starts_at) - t) / 1000;
  const endLeft = g.ends_at ? (ts(g.ends_at) - t) / 1000 : null;
  const pingLeft = g.next_ping_at ? (ts(g.next_ping_at) - t) / 1000 : null;

  // ----- HUD
  hud.hidden = false;
  hud.className = 'hud ' + me.team;
  hud.innerHTML = `
    <div class="hud-top">
      <span class="role">${me.team === 'hunter' ? 'HUNTER' : 'GHOST'}</span>
      <span class="clock" data-t="${endLeft !== null ? 'end' : 'up'}">${endLeft !== null ? fmt(endLeft) + ' left' : fmt((t - ts(g.started_at)) / 1000)}</span>
    </div>
    <div class="hud-strip">
      <span><b>${ghostsLeft}</b> ghost${ghostsLeft === 1 ? '' : 's'} left</span>
      ${pingLeft !== null ? `<span>Next ping <b data-t="ping">${fmt(pingLeft)}</b> · every ${g.interval_min}m</span>` : `<span>${MODES[g.mode].label} mode</span>`}
    </div>
    ${headLeft > 0 ? `<div class="banner">${me.team === 'hunter' ? `Ghosts are hiding. You can hunt in <b data-t="head">${fmt(headLeft)}</b>` : `Run and hide! Hunters start in <b data-t="head">${fmt(headLeft)}</b>`}</div>` : ''}
    ${me.team === 'ghost' && S.last_seen ? `<div class="banner soft">Hunters last saw you ${fmt((t - ts(S.last_seen.at)) / 1000)} ago</div>` : ''}
    <div class="hud-actions">
      ${me.team === 'hunter' ? '<button class="btn hot" id="gCatch">I caught someone</button><button class="btn soft slim" id="gHints">Hints</button>' : ''}
      <button class="btn soft slim" id="gMenu" aria-label="Game menu">Menu</button>
    </div>`;
  const catchBtn = hud.querySelector('#gCatch');
  if (catchBtn) catchBtn.onclick = openCatchSheet;
  const hintsBtn = hud.querySelector('#gHints');
  if (hintsBtn) hintsBtn.onclick = openHints;
  hud.querySelector('#gMenu').onclick = openMenu;

  // ----- markers
  const seen = new Set();
  S.teammates.forEach((tm) => {
    const p = playerById(tm.id); if (!p) return;
    setMarker('t:' + tm.id, { avatar: p.avatar, label: p.name, ring: RING[p.team] }, [tm.lng, tm.lat]);
    seen.add('t:' + tm.id);
  });
  if (me.team === 'hunter') {
    const shown = new Set();
    (S.pings || []).forEach((pg) => {
      const age = (t - ts(pg.created_at)) / 60000;
      pg.snapshot.forEach((s) => {
        if (shown.has(s.id)) return; // newest ping per ghost only
        const p = playerById(s.id); if (!p || p.team !== 'ghost') return;
        shown.add(s.id);
        const key = 'p:' + s.id;
        setMarker(key, { avatar: p.avatar, label: `${p.name} · ${Math.max(0, Math.round(age))}m ago`, ring: RING.ghost, echo: true }, [s.lng, s.lat], Math.max(0.35, 1 - age / 20));
        seen.add(key);
      });
    });
  } else if (S.last_seen) {
    setMarker('ls', { avatar: me.avatar, label: 'Last seen', ring: RING.ghost, echo: true }, [S.last_seen.lng, S.last_seen.lat], 0.6);
    seen.add('ls');
  }
  markers.forEach((m, k) => { if (!seen.has(k)) { m.remove(); markers.delete(k); } });
  drawMe();

  // ----- ghost duties: photo hint + catch confirmation
  if (me.team === 'ghost' && S.hint_due && !cameraOpen) {
    cameraOpen = true; buzz([200, 80, 200]);
    const seq = S.hint_due.seq;
    cam = openCamera(modal, {
      deadline: ts(S.hint_due.deadline) - clockOffset,
      onPhoto: (photo) => rpc('upload_hint', { ...auth(), p_seq: seq, p_photo: photo }).then(() => toast('Hint sent. Now move!')),
      onClose: () => { cameraOpen = false; cam = null; },
    });
  }
  if (me.team === 'ghost' && S.catch_request && !cameraOpen && !modal.querySelector('.confirm')) {
    const h = playerById(S.catch_request.hunter_id);
    buzz([100, 50, 100]);
    modal.innerHTML = `<div class="confirm card" role="alertdialog" aria-modal="true">
      <img src="/a/${esc(h ? h.avatar : 'hunter')}.png" alt="">
      <h2>${esc(h ? h.name : 'A hunter')} says they caught you</h2>
      <p class="muted">Did they tag you for real?</p>
      <div class="row"><button class="btn soft" id="cNo">No, I escaped</button><button class="btn hot" id="cYes">Yes, caught</button></div>
    </div>`;
    const reqId = S.catch_request.id;
    const answer = async (yes) => { modal.innerHTML = ''; await rpc('respond_catch', { ...auth(), p_catch: reqId, p_accept: yes }).catch((x) => toast(x.message)); poll(); };
    modal.querySelector('#cYes').onclick = () => answer(true);
    modal.querySelector('#cNo').onclick = () => answer(false);
  }
}

setInterval(() => {
  if (!S || S.game.status !== 'live' || hud.hidden) return;
  const g = S.game, t = now();
  hud.querySelectorAll('[data-t]').forEach((el) => {
    const k = el.dataset.t;
    if (k === 'end') el.textContent = fmt((ts(g.ends_at) - t) / 1000) + ' left';
    else if (k === 'up') el.textContent = fmt((t - ts(g.started_at)) / 1000);
    else if (k === 'ping') el.textContent = fmt((ts(g.next_ping_at) - t) / 1000);
    else if (k === 'head') el.textContent = fmt((ts(g.hunt_starts_at) - t) / 1000);
  });
}, 1000);

function openCatchSheet() {
  const ghosts = S.players.filter((p) => p.team === 'ghost');
  modal.innerHTML = `<div class="sheet-modal card" role="dialog" aria-modal="true" aria-label="Who did you catch?">
    <h2>Who did you catch?</h2>
    <p class="muted small">They'll get a prompt to confirm.</p>
    <div class="picklist">${ghosts.map((p) => `<button class="pl" data-id="${p.id}"><img src="/a/${esc(p.avatar)}.png" alt=""><span>${esc(p.name)}</span></button>`).join('') || '<p>No ghosts left.</p>'}</div>
    <button class="btn soft" id="csClose">Cancel</button></div>`;
  modal.querySelector('#csClose').onclick = () => { modal.innerHTML = ''; };
  modal.querySelectorAll('.pl').forEach((b) => b.onclick = async () => {
    try { await rpc('report_catch', { ...auth(), p_ghost: b.dataset.id }); modal.innerHTML = ''; toast(`Waiting for ${playerById(b.dataset.id).name} to confirm…`); }
    catch (x) { toast(x.message); }
  });
}

function openHints() {
  const items = [...photoCache.entries()].map(([k, url]) => { const [pid, seq] = k.split(':'); return { p: playerById(pid), seq: +seq, url }; })
    .filter((x) => x.p).sort((a, b) => b.seq - a.seq);
  modal.innerHTML = `<div class="sheet-modal card" role="dialog" aria-modal="true" aria-label="Photo hints">
    <h2>Photo hints</h2>
    ${items.length ? `<div class="hints">${items.map((x) => `<figure><img src="${x.url}" alt="Photo hint from ${esc(x.p.name)}"><figcaption><img src="/a/${esc(x.p.avatar)}.png" alt="">${esc(x.p.name)} · ping ${x.seq}</figcaption></figure>`).join('')}</div>`
      : '<p class="muted">No photos yet. Ghosts send one at every ping.</p>'}
    <button class="btn soft" id="hClose">Close</button></div>`;
  modal.querySelector('#hClose').onclick = () => { modal.innerHTML = ''; };
}

function openMenu() {
  const isHost = S.game.host_id === S.me.id;
  modal.innerHTML = `<div class="sheet-modal card" role="dialog" aria-modal="true" aria-label="Game menu">
    <h2>Game ${esc(S.game.code)}</h2>
    <button class="btn soft" id="mCenter">Center on me</button>
    ${isHost ? '<button class="btn soft" id="mEnd">End game for everyone</button>' : ''}
    <button class="btn soft" id="mLeave">Leave game</button>
    <button class="btn primary" id="mClose">Back to the hunt</button></div>`;
  modal.querySelector('#mClose').onclick = () => { modal.innerHTML = ''; };
  modal.querySelector('#mCenter').onclick = () => { modal.innerHTML = ''; if (myPos) map.flyTo({ center: myPos, zoom: 17.2 }); else toast('Waiting for your GPS…'); };
  modal.querySelector('#mLeave').onclick = leaveGame;
  const end = modal.querySelector('#mEnd');
  if (end) end.onclick = async () => { modal.innerHTML = ''; await rpc('end_game', auth()).catch((x) => toast(x.message)); poll(); };
}

// ------------------------------------------------------------------ results
function renderResults() {
  stopPolling(); clearGameMap(); hud.hidden = true; modal.innerHTML = ''; map.setOrbit(true); map.flyTo(CAMPUS_VIEW);
  const g = S.game;
  const counts = {};
  S.players.forEach((p) => { if (p.caught_by) counts[p.caught_by] = (counts[p.caught_by] || 0) + 1; });
  const survivors = S.players.filter((p) => p.team === 'ghost');
  const topId = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const top = topId && playerById(topId);
  screen.innerHTML = `
    <section class="card sheet center">
      <img class="sticker" src="/e/gg.png" alt="">
      <h1 class="logo big ${g.winner === 'hunters' ? 'pink' : 'blue'}">${g.winner === 'hunters' ? 'HUNTERS WIN!' : 'GHOSTS WIN!'}</h1>
      <p class="muted">${g.catches} catch${g.catches === 1 ? '' : 'es'} · ${MODES[g.mode].label} mode</p>
      <div class="titles">
        ${survivors.map((p) => `<div class="title blue"><img src="/a/${esc(p.avatar)}.png" alt=""><span><b>Last Ghost</b>${esc(p.name)} was never caught</span></div>`).join('')}
        ${top ? `<div class="title pink"><img src="/a/${esc(top.avatar)}.png" alt=""><span><b>Bloodhound</b>${esc(top.name)} · ${counts[topId]} catch${counts[topId] === 1 ? '' : 'es'}</span></div>` : ''}
      </div>
      <button class="btn primary" id="rHome">Play again</button>
    </section>`;
  screen.querySelector('#rHome').onclick = () => { session.clear(); renderHome(); };
}

// ------------------------------------------------------------------ boot
if (!profile.get()) renderProfile();
else if (session.get()) enterGame();
else renderHome();
