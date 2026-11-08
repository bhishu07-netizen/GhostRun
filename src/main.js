import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import '@fontsource/kanit/900-italic.css';
import './style.css';
import { rpc, profile, session, auth, lastPos } from './api.js';
import { createMap, avatarMarker, circle, DEFAULT_VIEW, localView } from './map.js';
import { mountMapControls } from './mapControls.js';
import { openCamera } from './camera.js';
import { registerWorker, alertState, turnOnAlerts, linkToGame } from './push.js';

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

const homeView = () => (lastPos.get() ? localView(lastPos.get()) : DEFAULT_VIEW);
const map = createMap((m) => console.warn(m), homeView());
map.setOrbit(true);
const mapUI = mountMapControls(map, { getPos: () => myPos });

// if location is already allowed, quietly open the map over the player's neighbourhood (never prompts)
async function locateQuietly() {
  try {
    if (!navigator.permissions || !navigator.geolocation) return;
    const p = await navigator.permissions.query({ name: 'geolocation' });
    if (p.state !== 'granted') return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const ll = [pos.coords.longitude, pos.coords.latitude];
      const first = !lastPos.get();
      lastPos.set(ll);
      if (first && !S) map.flyTo({ ...localView(ll), duration: 3500 });
    }, () => {}, { maximumAge: 600000, timeout: 15000 });
  } catch { /* not supported */ }
}
locateQuietly();

// ------------------------------------------------------------------ profile + age gate
function renderProfile() {
  stopPolling(); hud.hidden = true; map.setOrbit(true);
  const p = profile.get() || {};
  const thisYear = new Date().getFullYear();
  screen.innerHTML = `
    <section class="card sheet">
      <div class="brand big"><img src="/icons/icon-192.png" alt="" width="88" height="88"><h1 class="logo big">GHOSTRUN</h1></div>
      <p class="muted">Pick who you'll be on the map.</p>
      <label class="field"><span>Your name</span><input id="pName" maxlength="20" autocomplete="nickname" value="${esc(p.name || '')}" placeholder="Bhishu"></label>
      <div class="avatars" role="radiogroup" aria-label="Choose an avatar">
        ${AVATARS.map(([k, label]) => `<button class="av ${p.avatar === k ? 'on' : ''}" role="radio" aria-checked="${p.avatar === k}" data-av="${k}"><img src="/a/${k}.png" alt=""><span>${label.replace('The ', '')}</span></button>`).join('')}
      </div>
      <label class="field"><span>Year you were born</span>
        <select id="pYear"><option value="">Select</option>${Array.from({ length: 70 }, (_, i) => thisYear - 6 - i).map((y) => `<option ${p.year == y ? 'selected' : ''}>${y}</option>`).join('')}</select>
      </label>
      <p class="fine">Ghostrun shares your live location with the other players in your game only, and deletes it when the game ends. You must be 13 or older to play. By playing you agree to the <a href="/terms">Terms &amp; Conditions</a> and <a href="/privacy">Privacy Policy</a>.</p>
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
    mapUI.locate({ quiet: true }); // ask for location now, so the map opens on the player
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
        <div class="brand"><img src="/icons/icon-192.png" alt="" width="40" height="40"><h1 class="logo">GHOSTRUN</h1></div>
        <button class="chip me" id="hEdit"><img src="/a/${esc(p.avatar)}.png" alt=""><span>${esc(p.name)}</span></button>
      </div>
      <p class="muted">Real-life manhunt anywhere: your campus, your block, your park. Hide, hunt, don't get caught.</p>
      <div class="modes" role="radiogroup" aria-label="Game mode">
        ${Object.entries(MODES).map(([k, m]) => `<button class="mode ${k === mode ? 'on' : ''}" role="radio" aria-checked="${k === mode}" data-mode="${k}"><b>${m.label}</b><span>${m.sub}</span></button>`).join('')}
      </div>
      <button class="btn primary" id="hHost">Host a hunt</button>
      <div class="or"><span>or</span></div>
      <div class="joinrow">
        <label class="field grow"><span>Got a code from a friend?</span><input id="hCode" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="4-letter code" aria-describedby="hCodeHelp"></label>
        <button class="btn soft" id="hJoin">Join</button>
      </div>
      <p class="hint" id="hCodeHelp">One friend hosts and shares a code. Everyone else types it here to join their hunt.</p>
      <p class="err" id="hErr" hidden></p>
      <p class="legal"><a href="/privacy">Privacy</a> · <a href="/terms">Terms &amp; Conditions</a> · Play safe, stay out of private property</p>
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
    if (st.game.status !== 'ended') linkToGame().catch(() => { /* alerts are a bonus */ });
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
  if (cam) cam.close();
  session.clear(); stopPolling(); clearGameMap(); modal.innerHTML = ''; renderHome();
}

// catches, team switches, pings: the moments everyone should feel
function detectEvents(prev, st) {
  if (!prev || prev.game.status !== 'live' || st.game.status !== 'live') return;
  const seenZone = new Set((prev.pings || []).filter((p) => p.kind === 'zone').map((p) => p.created_at));
  (st.pings || []).filter((p) => p.kind === 'zone' && !seenZone.has(p.created_at)).forEach((p) => {
    const g = p.snapshot[0] && st.players.find((x) => x.id === p.snapshot[0].id);
    if (g) { buzz([60, 40, 60]); toast(`${g.name} left the play zone. Their spot is on the map.`); }
  });
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
  if (prev.game.zone && st.game.zone && st.game.zone.r < prev.game.zone.r) {
    buzz([120, 60, 120]);
    toast(`The zone shrank to ${zoneLabel(st.game.zone.r)}. Stay inside!`);
  }
}

function caughtSplash(text, left) {
  buzz([80, 40, 140]);
  if (cameraOpen) { toast(`${text} · ${left} ghost${left === 1 ? '' : 's'} left`); return; } // don't wipe a photo hint in progress
  modal.innerHTML = `<div class="splash" role="alert"><img src="/e/out.png" alt=""><b>CAUGHT!</b><span>${esc(text)}</span><em>${left} ghost${left === 1 ? '' : 's'} left</em></div>`;
  setTimeout(() => { if (modal.querySelector('.splash')) modal.innerHTML = ''; }, 2200);
}

// ------------------------------------------------------------------ lobby
let lobbyHtml = '';
function renderLobby() {
  hud.hidden = true; map.setOrbit(!S.game.zone); // hold still over the zone once there is one
  const g = S.game, me = S.me, isHost = g.host_id === me.id;
  const hunters = S.players.filter((p) => p.team === 'hunter'), ghosts = S.players.filter((p) => p.team === 'ghost');
  const n = S.players.length;
  const base = n <= 5 ? 15 : n <= 7 ? 20 : 25;
  const ladder = [0, 1, 2, 3].map((c) => Math.max(5, base - 5 * c));
  const list = (arr) => arr.map((p) => `<button class="pl ${p.id === me.id ? 'mine' : ''}" data-id="${p.id}" ${(!isHost && p.id !== me.id) ? 'disabled' : ''}>
      <img src="/a/${esc(p.avatar)}.png" alt=""><span>${esc(p.id === me.id ? 'You' : p.name)}${p.id === g.host_id ? ' · host' : ''}</span></button>`).join('') || '<p class="muted small">Nobody yet</p>';
  const html = `
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
      ${g.mode === 'quick' ? '<p class="small">Quick mode: 1 minute head start, 15 minutes, no pings. Pure hide and seek.</p>'
        : rulesOf(g).ping ? `<p class="small">Pings every <b>${rulesOf(g).ping} min</b>, whatever the catches.</p>`
        : `<div class="ladder"><span>Pings for ${n} players</span>${ladder.map((m, i) => `<b>${m} min<em>${i === 0 ? 'start' : `${i} catch${i > 1 ? 'es' : ''}`}</em></b>`).join('')}</div>`}
      ${rulesBox(isHost, g)}
      ${zoneBox(isHost, g.zone)}
      ${alertsBox()}
      ${isHost ? '<button class="btn primary" id="lStart">Start the hunt</button>' : '<p class="waiting">Waiting for the host to start…</p>'}
      <p class="err" id="lErr" hidden></p>
    </section>`;
  // The lobby polls every 3 s. Only rebuild it when something changed, and keep the scroll
  // position when it does, so scrolling (and an error message) isn't wiped mid-gesture.
  if (html === lobbyHtml && screen.querySelector('#lLeave')) { showLobbyZone(g.zone); return; }
  lobbyHtml = html;
  const y = screen.scrollTop;
  screen.innerHTML = html;
  screen.scrollTop = y;
  const err = screen.querySelector('#lErr');
  wireAlerts(screen);
  wireZone(screen);
  wireRules(screen, err);
  showLobbyZone(g.zone);
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
let lastSaved = 0, geoWatch = null, lastSent = 0, myPos = null, wakeLock = null, lastFix = 0, geoStarted = 0, geoDenied = false;
const markers = new Map(); // key -> marker
let meMarker = null, cameraOpen = false, cam = null;

function startGeo() {
  if (geoWatch !== null) return;
  if (!('geolocation' in navigator)) { geoStarted = geoStarted || Date.now(); return; }
  geoStarted = Date.now();
  geoWatch = navigator.geolocation.watchPosition((pos) => {
    myPos = [pos.coords.longitude, pos.coords.latitude, pos.coords.accuracy]; lastFix = Date.now(); geoDenied = false;
    if (Date.now() - lastSent > 5000) {
      lastSent = Date.now();
      rpc('update_location', { ...auth(), p_lat: myPos[1], p_lng: myPos[0], p_acc: Math.round(myPos[2]) }).catch(() => {});
    }
    if (Date.now() - lastSaved > 60000) { lastSaved = Date.now(); lastPos.set(myPos); }
    drawMe();
  }, (e) => {
    if (e.code === 1) geoDenied = true;
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
  map.addSource('zone', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': '#7C5CD6', 'fill-opacity': 0.06 } });
  map.addLayer({ id: 'zone-line', type: 'line', source: 'zone', paint: { 'line-color': '#7C5CD6', 'line-width': 3, 'line-dasharray': [2, 1.5] } });
  map.addSource('acc', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': '#818CF8', 'fill-opacity': 0.14 } });
  drawZone(shownZone);
});

// ----- play zone on the map
let shownZone = null, zoneKey = '';
const zoneId = (z) => (z ? `${z.lat},${z.lng},${z.r}` : '');
function drawZone(z) {
  shownZone = z;
  const src = map.getSource && map.getSource('zone');
  if (src) src.setData(z ? circle([z.lng, z.lat], z.r, 96) : { type: 'FeatureCollection', features: [] });
}
// metres between two [lng, lat] points
function distM([lng1, lat1], [lng2, lat2]) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}
// outside only beyond the radius plus GPS accuracy (at least 20 m), the same rule the server uses
function outsideZone(z) {
  if (!z || !myPos) return false;
  return distM([z.lng, z.lat], myPos) > z.r + Math.max(myPos[2] || 0, 20);
}
const zoneLabel = (r) => (r >= 1000 ? `${r / 1000} km` : `${r} m`);
const ZONE_SIZES = [250, 500, 1000, 2000, 5000];

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
  drawZone(null); zoneKey = '';
  stopGeo(); centered = false; myPos = null; lastFix = 0; geoStarted = 0; geoDenied = false;
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
  const noGps = me.team === 'hunter' ? (S.ghost_gps || []).filter((x) => x.age_s == null || x.age_s > 120)
    .map((x) => ({ ...x, p: playerById(x.id) })).filter((x) => x.p) : [];

  drawZone(g.zone);
  const out = outsideZone(g.zone);
  if (out && !wasOutside) buzz([300, 100, 300]);
  wasOutside = out;
  const zoneBanner = !out ? '' : me.team === 'hunter'
    ? '<div class="banner warn">You\'re outside the play zone.</div>'
    : headLeft > 0 ? '<div class="banner warn"><b>Outside the play zone!</b> Get back in before the hunt starts.</div>'
    : zoneOutLeft() > 0 ? `<div class="banner warn"><b>Outside the play zone!</b> Get back in within <b data-t="zone">${fmt(zoneOutLeft())}</b> or hunters will see you.</div>`
    : '<div class="banner warn"><b>Outside the play zone!</b> Hunters can see your spot until you\'re back in.</div>';

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
    ${zoneBanner}
    ${headLeft > 0 ? `<div class="banner">${me.team === 'hunter' ? `Ghosts are hiding. You can hunt in <b data-t="head">${fmt(headLeft)}</b>` : `Run and hide! Hunters start in <b data-t="head">${fmt(headLeft)}</b>`}</div>` : ''}
    ${me.team === 'ghost' && geoStarted && (geoDenied || (Date.now() - geoStarted > 20000 && Date.now() - lastFix > 60000))
      ? '<div class="banner warn">Your location is off. Hunters can see that you have no GPS. Turn location on to play fair.</div>' : ''}
    ${noGps.length ? `<div class="banner warn">No GPS from ${noGps.map((x) => `<b>${esc(x.p.name)}</b> (${x.age_s == null ? 'no signal yet' : 'last ' + fmt(x.age_s) + ' ago'})`).join(', ')}. Pings can't show them.</div>` : ''}
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
        if (shown.has(s.id) || s.lat == null) return; // newest known position per ghost only
        const p = playerById(s.id); if (!p || p.team !== 'ghost') return;
        shown.add(s.id);
        const key = 'p:' + s.id;
        const seenAge = s.at ? (t - ts(s.at)) / 60000 : age; // when the ghost was really there, not when the ping fired
        const why = pg.kind === 'zone' ? ' · left the zone' : '';
        setMarker(key, { avatar: p.avatar, label: `${p.name}${why} · ${Math.max(0, Math.round(seenAge))}m ago`, ring: RING.ghost, echo: true }, [s.lng, s.lat], Math.max(0.35, 1 - seenAge / 20));
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
    else if (k === 'zone') el.textContent = fmt(zoneOutLeft());
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
    ${alertsBox()}
    <button class="btn soft" id="mCenter">Center on me</button>
    ${isHost ? '<button class="btn soft" id="mEnd">End game for everyone</button>' : ''}
    <button class="btn soft" id="mLeave">Leave game</button>
    <button class="btn primary" id="mClose">Back to the hunt</button></div>`;
  modal.querySelector('#mClose').onclick = () => { modal.innerHTML = ''; };
  wireAlerts(modal);
  modal.querySelector('#mCenter').onclick = () => { modal.innerHTML = ''; if (myPos) map.flyTo({ center: myPos, zoom: 17.2 }); else toast('Waiting for your GPS…'); };
  modal.querySelector('#mLeave').onclick = leaveGame;
  const end = modal.querySelector('#mEnd');
  if (end) end.onclick = async () => { modal.innerHTML = ''; await rpc('end_game', auth()).catch((x) => toast(x.message)); poll(); };
}

// ------------------------------------------------------------------ custom rules (lobby)
const rulesOf = (g) => g.rules || { head: null, len: null, ping: null, shrink: false };
function seg(name, options, current, unit) {
  return `<div class="seg" role="group" aria-label="${name}">${options.map(([v, label]) =>
    `<button class="zchip ${String(current) === String(v) ? 'on' : ''}" data-rule="${name}" data-v="${v}">${label}${unit && v !== 'auto' ? `<small> ${unit}</small>` : ''}</button>`).join('')}</div>`;
}
function rulesBox(isHost, g) {
  if (g.mode === 'quick') return '';
  const r = rulesOf(g);
  if (!isHost) {
    const bits = [`${r.head || 5} min head start`, r.ping ? `pings every ${r.ping} min` : 'pings speed up with catches'];
    if (r.shrink && g.zone) bits.push('the zone shrinks at every ping');
    return `<p class="pill rules-pill">Rules: ${bits.join(' · ')}</p>`;
  }
  return `<div class="rulesbox" id="rulesBox">
      <p><b>Rules</b></p>
      <div class="rule"><span>Head start</span>${seg('head', [[2, '2'], [5, '5'], [10, '10']], r.head || 5, 'min')}</div>
      <div class="rule"><span>Pings</span>${seg('ping', [['auto', 'Auto'], [5, '5'], [10, '10'], [15, '15'], [20, '20']], r.ping || 'auto', 'min')}</div>
      <p class="small muted">Auto: pings start at 15 to 25 minutes depending on players, and get 5 minutes faster with every catch.</p>
      ${g.zone ? `<label class="toggle"><input type="checkbox" id="ruleShrink" ${r.shrink ? 'checked' : ''}> <span><b>Shrinking zone</b> · the zone gets 20% smaller at every ping</span></label>` : ''}
    </div>`;
}
function wireRules(root, err) {
  const g = S.game, r = rulesOf(g);
  const send = async (next) => {
    try {
      await rpc('set_rules', { ...auth(), p_head: next.head ?? null, p_len: null, p_ping: next.ping ?? null, p_shrink: !!next.shrink });
      poll();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  };
  root.querySelectorAll('[data-rule]').forEach((b) => b.onclick = () => {
    const v = b.dataset.v === 'auto' ? null : +b.dataset.v;
    const defaults = { head: 5 }; // store null for the default so the server keeps its own
    const key = b.dataset.rule;
    send({ ...r, [key]: v === defaults[key] ? null : v });
  });
  const sh = root.querySelector('#ruleShrink');
  if (sh) sh.onchange = () => send({ ...r, shrink: sh.checked });
}

// ------------------------------------------------------------------ play zone (lobby)
let wasOutside = false, zoneBusy = false;
// seconds a ghost has left before the server shows them to the hunters
function zoneOutLeft() {
  const o = S && S.me.out_since;
  return o ? Math.max(0, 30 - (now() - ts(o)) / 1000) : 30;
}
function zoneBox(isHost, z) {
  if (!isHost) {
    return z ? `<p class="pill zone-pill">Play zone: <b>${zoneLabel(z.r)}</b> around the host's spot. Stay inside or hunters will see you.</p>`
      : '<p class="pill zone-pill">Play zone: <b>Anywhere</b>. No limits, go wherever you like.</p>';
  }
  return `<div class="zonebox" id="zoneBox">
      <p><b>Play zone</b> · ${z ? `${zoneLabel(z.r)} circle around where you set it.` : 'Anywhere. No limits.'}</p>
      <div class="zone-sizes" role="group" aria-label="Zone size">${ZONE_SIZES.map((r) => `<button class="zchip ${z && z.r === r ? 'on' : ''}" data-r="${r}" ${zoneBusy ? 'disabled' : ''}><b>${zoneLabel(r)}</b></button>`).join('')}<button class="zchip ${z ? '' : 'on'}" id="zoneOff" ${zoneBusy ? 'disabled' : ''}><b>Anywhere</b></button></div>
      <p class="small muted">${zoneBusy ? 'Finding you…' : 'Pick a size to draw the zone around where you\'re standing. Ghosts who stay outside it get shown to the hunters. Anywhere means no zone.'}</p>
    </div>`;
}
function wireZone(root) {
  // look the error box up when needed: the lobby may have been rebuilt since wiring
  const fail = (m) => { const e = screen.querySelector('#lErr'); if (e) { e.textContent = m; e.hidden = false; } };
  root.querySelectorAll('.zone-sizes [data-r]').forEach((b) => b.onclick = () => {
    if (!('geolocation' in navigator)) return fail('This phone can\'t share its location, so it can\'t set a zone.');
    zoneBusy = true; renderLobby();
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        await rpc('set_zone', { ...auth(), p_lat: pos.coords.latitude, p_lng: pos.coords.longitude, p_radius: +b.dataset.r });
        lastPos.set([pos.coords.longitude, pos.coords.latitude]);
      } catch (x) { fail(x.message); }
      zoneBusy = false; poll();
    }, (e) => {
      zoneBusy = false; renderLobby();
      fail(e.code === 1 ? 'Allow location for Ghostrun to set the zone around you.' : 'Couldn\'t find you. Try again outside.');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  });
  const off = root.querySelector('#zoneOff');
  if (off) off.onclick = async () => { if (!S.game.zone) return; try { await rpc('set_zone', { ...auth(), p_lat: null, p_lng: null, p_radius: null }); poll(); } catch (x) { fail(x.message); } };
}
// draw the zone behind the lobby and fly to it once each time it changes
function showLobbyZone(z) {
  drawZone(z);
  const k = zoneId(z);
  if (k === zoneKey) return;
  zoneKey = k;
  if (z) { map.setOrbit(false); map.flyTo({ center: [z.lng, z.lat], zoom: Math.max(12.5, 17.3 - Math.log2(z.r / 100)), pitch: 30, duration: 1800 }); }
}

// ------------------------------------------------------------------ alerts
// Lobby and game-menu control for push alerts. What it shows depends on the device.
function alertsBox() {
  const st = alertState();
  if (st === 'on') return '<p class="alerts on" id="alertsBox"><b>Alerts are on.</b> Lock your phone while you hide; we\'ll buzz you a minute before each ping.</p>';
  if (st === 'off') return `<div class="alerts" id="alertsBox"><p><b>Get a buzz before each ping.</b> Lock your phone while you hide and we'll wake you up in time.</p><button class="btn soft slim" id="alertsOn">Turn on alerts</button></div>`;
  if (st === 'ios-home') return '<p class="alerts" id="alertsBox"><b>Want ping alerts on iPhone?</b> Tap Share, then <b>Add to Home Screen</b>, and open Ghostrun from that icon.</p>';
  if (st === 'blocked') return '<p class="alerts" id="alertsBox">Alerts are blocked. Allow notifications for Ghostrun in your phone settings to get ping alerts.</p>';
  return ''; // browser can't do web push: say nothing, the game works without it
}
function wireAlerts(root) {
  const b = root.querySelector('#alertsOn');
  if (!b) return;
  b.onclick = async () => {
    b.disabled = true; b.textContent = 'Turning on…';
    try {
      const st = await turnOnAlerts();
      toast(st === 'on' ? 'Alerts on. We\'ll buzz you before each ping.' : 'Alerts stay off. You can still play.');
    } catch { toast('Couldn\'t turn on alerts on this device. You can still play.'); }
    const box = root.querySelector('#alertsBox');
    if (box) box.outerHTML = alertsBox();
  };
}

// ------------------------------------------------------------------ results
function renderResults() {
  if (cam) cam.close();
  stopPolling(); clearGameMap(); hud.hidden = true; modal.innerHTML = ''; map.setOrbit(true); map.flyTo(homeView());
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
registerWorker();
if (!profile.get()) renderProfile();
else if (session.get()) enterGame();
else renderHome();
