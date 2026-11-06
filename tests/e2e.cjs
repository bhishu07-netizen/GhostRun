// End-to-end play-test: two phones (host hunter + ghost) against an in-memory copy of the server rules.
// Run: npm run build && npx vite preview --port 4173 & node tests/e2e.cjs   (needs `playwright` installed)
const { chromium, devices } = require('playwright');
const OUT = require('path').join(__dirname, 'screens'); require('fs').mkdirSync(OUT, { recursive: true });
// ---------- mock backend mirroring the Supabase functions ----------
const games = {}, players = {}, pushSubs = new Map(); let seq = 1, catchId = 1;
const nowIso = () => new Date().toISOString();
const err = (m) => ({ status: 400, body: { message: m } });
const interval = (g) => (g.rules || {}).ping || Math.max(5, (g.start_players <= 5 ? 15 : g.start_players <= 7 ? 20 : 25) - 5 * g.catches);
function auth(a) { const p = players[a.p_player]; if (!p || p.secret !== a.p_secret) throw err('not allowed'); return p; }
function newPlayer(g, name, avatar, team) { const id = 'p' + seq++; players[id] = { id, secret: 's' + id, game: g.id, name, avatar, team, alive: true, joined: seq }; return { player_id: id, secret: 's' + id, game_id: g.id, code: g.code }; }
const gp = (g) => Object.values(players).filter((p) => p.game === g.id);
function end(g, w) { if (g.status !== 'live') return; g.status = 'ended'; g.winner = w; g.next_ping_at = null; g.hints = []; g.locs = {}; }
const distM = (a, b) => { const r = (d) => d * Math.PI / 180; const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2; return 2 * 6371000 * Math.asin(Math.sqrt(h)); };
function tick(g) {
  if (g.status === 'live' && g.zone) gp(g).filter((p) => p.team === 'ghost' && g.locs[p.id]).forEach((p) => {
    const l = g.locs[p.id]; const out = distM(g.zone, l) > g.zone.r + Math.max(l.acc || 0, 20);
    if (out && !p.out_since) p.out_since = nowIso(); if (!out) p.out_since = null;
  });
  if (g.status !== 'live') return;
  if (!gp(g).some((p) => p.team === 'ghost')) return end(g, 'hunters');
  if (g.ends_at && Date.now() >= +new Date(g.ends_at)) return end(g, 'ghosts');
  if (g.next_ping_at && Date.now() >= +new Date(g.next_ping_at)) {
    g.ping_seq++;
    g.pings.unshift({ seq: g.ping_seq, kind: 'ping', created_at: nowIso(), snapshot: gp(g).filter((p) => p.team === 'ghost').map((p) => { const l = g.locs[p.id]; return l ? { id: p.id, ...l, no_gps: Date.now() - +new Date(l.at) > 120000 } : { id: p.id, lat: null, lng: null, at: null, no_gps: true }; }) });
    gp(g).filter((p) => p.team === 'ghost').forEach((p) => g.hints.push({ player: p.id, seq: g.ping_seq, deadline: new Date(Date.now() + 60000).toISOString(), photo: null }));
    g.next_ping_at = new Date(Date.now() + interval(g) * 60000).toISOString();
    if ((g.rules || {}).shrink && g.zone && g.zone.r > 100) g.zone = { ...g.zone, r: Math.max(100, Math.round(g.zone.r * 0.8)) };
  }
}
const api = {
  create_game(a) { if (!a.p_age_ok) throw err('13+'); const id = 'g' + seq++; const g = games[id] = { id, code: 'K7QX', mode: a.p_mode, status: 'lobby', catches: 0, ping_seq: 0, pings: [], hints: [], locs: {}, catchesList: [] }; const r = newPlayer(g, a.p_name, a.p_avatar, 'hunter'); g.host_id = r.player_id; return r; },
  join_game(a) { const g = Object.values(games).find((x) => x.code === a.p_code); if (!g) throw err('No game with that code.'); if (g.status !== 'lobby') throw err('That game already started.'); return newPlayer(g, a.p_name, a.p_avatar, 'ghost'); },
  set_team(a) { const me = auth(a); players[a.p_target].team = a.p_team; },
  set_mode(a) { const me = auth(a); games[me.game].mode = a.p_mode; },
  start_game(a) { const me = auth(a); const g = games[me.game]; const ps = gp(g); if (!ps.some((p) => p.team === 'hunter') || !ps.some((p) => p.team === 'ghost')) throw err('You need at least 1 hunter and 1 ghost.'); Object.assign(g, { status: 'live', start_players: ps.length, started_at: nowIso(), hunt_starts_at: new Date(Date.now() + (g.mode === 'quick' ? 1 : ((g.rules || {}).head || 5)) * 60000).toISOString(), ends_at: g.mode === 'hour' ? new Date(Date.now() + ((g.rules || {}).len || 60) * 60000).toISOString() : null }); g.next_ping_at = g.mode !== 'quick' ? new Date(Date.now() + interval(g) * 60000).toISOString() : null; },
  update_location(a) { const me = auth(a); const g = games[me.game]; if (g.status === 'live') g.locs[me.id] = { lat: a.p_lat, lng: a.p_lng, acc: a.p_acc, at: nowIso() }; },
  report_catch(a) { const me = auth(a); const g = games[me.game]; if (Date.now() < +new Date(g.hunt_starts_at)) throw err('Hold on, ghosts still have their head start.'); g.catchesList.push({ id: catchId++, hunter: me.id, ghost: a.p_ghost, status: 'pending', at: Date.now() }); },
  respond_catch(a) { const me = auth(a); const g = games[me.game]; const c = g.catchesList.find((x) => x.id === a.p_catch && x.ghost === me.id && x.status === 'pending'); if (!c) return; c.status = a.p_accept ? 'confirmed' : 'rejected'; if (a.p_accept) { Object.assign(me, { team: 'hunter', alive: false, caught_by: c.hunter }); g.catches++; tick(g); } },
  upload_hint(a) { const me = auth(a); const g = games[me.game]; const h = g.hints.find((x) => x.player === me.id && x.seq === a.p_seq && !x.photo); if (!/^data:image\/jpeg;base64,/.test(a.p_photo) || a.p_photo.length > 400000) throw err('Photo must be a JPEG under 300 KB.'); if (!h) throw err('Too late'); h.photo = a.p_photo; h.uploaded_at = nowIso(); },
  end_game(a) { const me = auth(a); end(games[me.game], 'ghosts'); },
  set_rules(a) { const me = auth(a); const g = games[me.game]; if (g.host_id !== me.id) throw err('Only the host can change the rules.'); if (g.status !== 'lobby') throw err('locked'); g.rules = { head: a.p_head, len: a.p_len, ping: a.p_ping, shrink: !!a.p_shrink }; },
  set_zone(a) { const me = auth(a); const g = games[me.game]; if (g.host_id !== me.id) throw err('Only the host can set the play zone.'); if (g.status !== 'lobby') throw err('The play zone is locked once the game starts.'); g.zone = a.p_radius == null ? null : { lat: a.p_lat, lng: a.p_lng, r: a.p_radius }; },
  save_push(a) { const me = auth(a); if (!/^https:\/\//.test(a.p_sub && a.p_sub.endpoint)) throw err('bad sub'); pushSubs.set(a.p_sub.endpoint, me.id); },
  leave_game(a) { const me = auth(a); delete players[me.id]; const g = games[me.game]; if (g.host_id === me.id) { const n = gp(g)[0]; g.host_id = n && n.id; } if (g.status === 'live') tick(g); },
  get_state(a) {
    const me = auth(a); const g = games[me.game]; tick(g);
    const res = { now: nowIso(), game: { id: g.id, code: g.code, mode: g.mode, status: g.status, host_id: g.host_id, started_at: g.started_at, hunt_starts_at: g.hunt_starts_at, ends_at: g.ends_at, next_ping_at: g.next_ping_at, catches: g.catches, ping_seq: g.ping_seq, winner: g.winner, interval_min: g.mode === 'quick' || g.status === 'lobby' ? null : interval(g), zone: g.zone || null, rules: { head: null, len: null, ping: null, shrink: false, ...(g.rules || {}) } },
      me: { id: me.id, name: me.name, avatar: me.avatar, team: me.team, out_since: me.out_since || null },
      players: gp(g).map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, team: p.team, caught: !p.alive, caught_by: p.caught_by || null, online: true })),
      teammates: gp(g).filter((p) => p.team === me.team && p.id !== me.id && g.locs[p.id]).map((p) => ({ id: p.id, ...g.locs[p.id] })) };
    if (me.team === 'hunter') Object.assign(res, { pings: g.pings.slice(0, 6), photos: g.hints.filter((h) => h.photo && (!a.p_photos_since || h.uploaded_at > a.p_photos_since)).map((h) => ({ player_id: h.player, seq: h.seq, photo: h.photo, uploaded_at: h.uploaded_at })), my_claims: g.catchesList.filter((c) => c.hunter === me.id).map((c) => ({ id: c.id, ghost_id: c.ghost, status: c.status })),
      ghost_gps: g.status === 'live' && Date.now() >= +new Date(g.hunt_starts_at) ? gp(g).filter((p) => p.team === 'ghost').map((p) => ({ id: p.id, age_s: g.locs[p.id] ? Math.floor((Date.now() - +new Date(g.locs[p.id].at)) / 1000) : null })) : [] });
    else { const ls = g.pings.flatMap((p) => p.snapshot).find((s) => s.id === me.id && s.lat != null); const hd = g.hints.find((h) => h.player === me.id && !h.photo && Date.now() < +new Date(h.deadline)); const cr = g.catchesList.filter((c) => c.ghost === me.id && c.status === 'pending').pop();
      Object.assign(res, { last_seen: ls || null, hint_due: hd ? { seq: hd.seq, deadline: hd.deadline } : null, catch_request: cr ? { id: cr.id, hunter_id: cr.hunter } : null }); }
    return res;
  },
};
const calls = [];
async function wire(ctx) {
  await ctx.route(/openfreemap\.org/, (r) => r.abort());
  await ctx.route(/supabase\.co\/rest\/v1\/rpc\/(\w+)/, async (route) => {
    const fn = route.request().url().split('/rpc/')[1]; const args = JSON.parse(route.request().postData() || '{}'); calls.push(fn);
    try { const out = api[fn](args); await route.fulfill({ status: 200, contentType: 'application/json', body: out === undefined ? '' : JSON.stringify(out) }); }
    catch (e) { await route.fulfill({ status: e.status || 500, contentType: 'application/json', body: JSON.stringify(e.body || { message: String(e) }) }); }
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };

(async () => {
  const browser = await chromium.launch();
  const mk = async (lat, lng, device = 'Pixel 7') => { const ctx = await browser.newContext({ ...devices[device], ...(lat ? { geolocation: { latitude: lat, longitude: lng, accuracy: 10 }, permissions: ['geolocation'] } : { permissions: [] }) }); await wire(ctx);
    // headless Chromium has no push service: fake the permission prompt and the subscription
    await ctx.addInitScript(() => {
      if (!window.Notification || !window.PushManager) return;
      let perm = 'default';
      Object.defineProperty(Notification, 'permission', { get: () => perm });
      Notification.requestPermission = async () => { perm = 'granted'; return perm; };
      const sub = { endpoint: 'https://push.example.test/' + Math.random().toString(36).slice(2), toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BKtestkey', auth: 'authtest' } }; } };
      PushManager.prototype.getSubscription = async () => null;
      PushManager.prototype.subscribe = async () => sub;
    }); const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/openfreemap|Failed to load resource|ERR_FAILED|AJAXError/i.test(m.text())) errs.push(m.text()); }); page.errs = errs; return page; };
  const host = await mk(30.7701, 76.5759), ghost = await mk(30.7712, 76.5771), dark = await mk(null);
  const URL = 'http://localhost:4173/';
  for (const [pg, name, av] of [[host, 'Bhishu', 'hunter'], [ghost, 'Riya', 'sneak'], [dark, 'Kabir', 'shadow']]) {
    await pg.goto(URL); await pg.waitForSelector('#pGo');
    await pg.click('#pGo'); check(`${name}: empty profile shows error`, await pg.isVisible('#pErr'));
    await pg.fill('#pName', name); await pg.click(`[data-av="${av}"]`);
    await pg.selectOption('#pYear', String(new Date().getFullYear() - 10)); await pg.click('#pGo');
    check(`${name}: under-13 blocked`, /13/.test(await pg.textContent('#pErr')));
    await pg.selectOption('#pYear', '2004'); await pg.click('#pGo');
    check(`${name}: reaches home`, await pg.isVisible('#hHost'));
  }
  await host.screenshot({ path: OUT + '/01-home.png' });
  await ghost.fill('#hCode', 'ZZZZ'); await ghost.click('#hJoin'); await sleep(300);
  check('bad code error shown', /No game/.test(await ghost.textContent('#hErr')));
  await host.click('[data-mode="endless"]'); await host.click('#hHost'); await host.waitForSelector('.codebox');
  await ghost.fill('#hCode', 'k7qx'); await ghost.click('#hJoin'); await ghost.waitForSelector('.codebox');
  await dark.fill('#hCode', 'K7QX'); await dark.click('#hJoin'); await dark.waitForSelector('.codebox');
  await sleep(3500);
  check('host lobby lists all 3 players', (await host.$$('.pl')).length === 3);
  check('lobby shows ping ladder for endless', await host.isVisible('.ladder'));
  check('ghost sees waiting text', await ghost.isVisible('.waiting'));
  // alerts: offered in the lobby, one tap links this phone to the game
  check('service worker registered', await host.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r)));
  check('lobby offers Turn on alerts', await ghost.isVisible('#alertsOn'));
  await ghost.click('#alertsOn'); await sleep(600);
  const ghostId = JSON.parse(await ghost.evaluate(() => localStorage.getItem('gr.session'))).player_id;
  check('alerts link this phone to the game', [...pushSubs.values()].includes(ghostId));
  await sleep(3200);
  check('lobby shows alerts are on', /Alerts are on/.test(await ghost.textContent('#alertsBox')));
  // play zone: host draws 250 m around themselves; everyone sees it
  check('host gets the zone sizes', (await host.$$('.zone-sizes .zchip')).length === 4);
  await host.click('.zchip[data-r="250"]'); await sleep(800);
  const gz = Object.values(games)[0].zone;
  check('zone set around the host', gz && gz.r === 250 && Math.abs(gz.lat - 30.7701) < 0.001, JSON.stringify(gz));
  await sleep(3200);
  check('ghost sees the zone in the lobby', /Play zone: 250 m/.test(await ghost.textContent('.zone-pill')));
  check('host sees the chosen size', await host.isVisible('.zchip.on[data-r="250"]'));
  // custom rules: 2 min head start, fixed 5 min pings, shrinking zone
  check('host gets the rules box', await host.isVisible('#rulesBox'));
  await host.click('[data-rule="head"][data-v="2"]'); await sleep(700);
  await host.click('[data-rule="ping"][data-v="5"]'); await sleep(700);
  await host.check('#ruleShrink'); await sleep(700);
  const gr = Object.values(games)[0].rules;
  check('rules saved', gr && gr.head === 2 && gr.ping === 5 && gr.shrink === true, JSON.stringify(gr));
  await sleep(3200);
  const rp = await ghost.textContent('.rules-pill');
  check('ghost sees the rules', /2 min head start/.test(rp) && /every 5 min/.test(rp) && /shrinks/.test(rp), rp);
  await host.screenshot({ path: OUT + '/02c-lobby-rules.png', fullPage: true });
  await host.screenshot({ path: OUT + '/02b-lobby-zone.png' });
  await host.screenshot({ path: OUT + '/02-lobby-host.png' });
  await host.click('#lStart'); const liveAt = Date.now(); await sleep(3500);
  check('host HUD live as HUNTER', (await host.textContent('.role')) === 'HUNTER');
  check('ghost HUD live as GHOST', (await ghost.textContent('.role')) === 'GHOST');
  check('head-start banner', /Hunters start in/.test(await ghost.textContent('.hud')));
  check('head start follows the rules (2 min)', /Hunters start in <b[^>]*>[12]:\d\d/.test(await ghost.innerHTML('.hud')));
  // the display can lag up to 1 s and rounds to whole seconds, so allow 2.5 s for it to move
  const c1 = await ghost.textContent('[data-t="head"]');
  await ghost.waitForFunction((v) => document.querySelector('[data-t="head"]').textContent !== v, c1, { timeout: 2500 }).catch(() => {});
  const c2 = await ghost.textContent('[data-t="head"]');
  check('countdown ticks every second', c1 !== c2, `${c1} -> ${c2}`);
  check('geolocation sent to server', calls.includes('update_location'));
  check('no zone warning while inside', !/Outside the play zone/.test(await ghost.textContent('.hud')));
  await ghost.context().setGeolocation({ latitude: 30.7790, longitude: 76.5759, accuracy: 10 }); // ~1 km north
  await sleep(6500);
  check('ghost warned outside the zone', /Outside the play zone/.test(await ghost.textContent('.hud')));
  await ghost.screenshot({ path: OUT + '/03b-outside-zone.png' });
  await ghost.context().setGeolocation({ latitude: 30.7712, longitude: 76.5771, accuracy: 10 });
  await sleep(6500);
  check('warning clears back inside', !/Outside the play zone/.test(await ghost.textContent('.hud')));
  await ghost.screenshot({ path: OUT + '/03-live-ghost.png' });
  // catch during head start
  await host.click('#gCatch'); await host.click('.picklist .pl'); await sleep(400);
  check('head-start catch blocked with message', /head start/.test(await host.textContent('#toast')));
  await host.click('#csClose').catch(() => {});
  // skip head start + force ping
  const g = Object.values(games)[0]; g.hunt_starts_at = new Date(Date.now() - 1000).toISOString(); g.next_ping_at = new Date(Date.now() - 1000).toISOString();
  await sleep(3800);
  check('ghost camera opens on ping', await ghost.isVisible('.cam'));
  check('zone shrank 20% at the ping', Object.values(games)[0].zone.r === 200, String(Object.values(games)[0].zone.r));
  check('ghost told the zone shrank', /zone shrank to 200 m/.test(await ghost.textContent('#toast')));
  const g0 = Object.values(games)[0];
  check('GPS-off ghost is in the ping snapshot as no_gps', g0.pings[0].snapshot.some((x) => x.no_gps && x.lat == null));
  check('hunter warned about GPS-off ghost', /No GPS from Kabir/.test(await host.textContent('.hud')));
  await host.screenshot({ path: OUT + '/04b-hunter-nogps.png' });
  await ghost.screenshot({ path: OUT + '/04-camera.png' });
  // headless has no camera -> fallback; use file picker
  const fallbackShown = await ghost.isVisible('#camPickWrap');
  if (fallbackShown) {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await ghost.setInputFiles('#camPick', { name: 'a.png', mimeType: 'image/png', buffer: png });
  } else {
    await ghost.waitForFunction(() => document.querySelector('#camVideo').videoWidth > 0, null, { timeout: 5000 }).catch(() => {});
    await ghost.click('#camShoot');
  }
  await ghost.waitForSelector('#camSend:not([hidden])', { timeout: 5000 }).catch(() => {});
  await ghost.click('#camSend'); await sleep(500);
  check('photo hint uploaded', g.hints.some((h) => h.photo), fallbackShown ? 'file fallback' : 'live cam');
  await sleep(3500);
  check('hunter sees ping marker', (await host.$$('.mk.echo')).length >= 1);
  await host.click('#gHints'); check('hunter sees photo hint', (await host.$$('.hints figure')).length === 1);
  await host.screenshot({ path: OUT + '/05-hunter-hints.png' }); await host.click('#hClose');
  await sleep(Math.max(0, 21500 - (Date.now() - liveAt)));
  check('GPS-off ghost sees location warning', /Your location is off/.test(await dark.textContent('.hud')));
  await dark.screenshot({ path: OUT + '/04c-ghost-nogps.png' });
  // Kabir sends his hint from the camera fallback, then quits so Riya is the last ghost
  check('GPS-off ghost still gets the photo-hint camera', await dark.isVisible('.cam'));
  await dark.setInputFiles('#camPick', { name: 'b.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await dark.waitForSelector('#camSend:not([hidden])'); await dark.click('#camSend'); await sleep(400);
  await dark.click('#gMenu'); await dark.click('#mLeave'); await sleep(300);
  // catch, ghost rejects
  await host.click('#gCatch'); await host.click('.picklist .pl'); await sleep(3800);
  check('ghost gets confirm dialog', await ghost.isVisible('.confirm'));
  await ghost.screenshot({ path: OUT + '/06-confirm.png' });
  await ghost.click('#cNo'); await sleep(3800);
  check('hunter told about escape', /escaped/.test(await host.textContent('#toast')));
  // catch, ghost accepts -> game ends (last ghost)
  await host.click('#gCatch'); await host.click('.picklist .pl'); await sleep(3800);
  await ghost.click('#cYes'); await sleep(4000);
  check('host results: HUNTERS WIN', /HUNTERS WIN/.test(await host.textContent('#screen')));
  check('ghost results: HUNTERS WIN', /HUNTERS WIN/.test(await ghost.textContent('#screen')));
  check('Bloodhound title', /Bloodhound/.test(await host.textContent('#screen')));
  await host.screenshot({ path: OUT + '/07-results.png' });
  // leave flow from a fresh lobby
  await host.click('#rHome'); await host.click('#hHost'); await host.waitForSelector('#lLeave'); await host.click('#lLeave'); await sleep(300);
  check('lobby Leave calls leave_game', calls.includes('leave_game'));
  check('back home after leave', await host.isVisible('#hHost'));
  // reload resumes session
  const hp = await host.evaluate(() => localStorage.getItem('gr.session'));
  check('session cleared after leave', hp === null);
  for (const [n, p] of [['host', host], ['ghost', ghost], ['gps-off ghost', dark]]) check(`${n}: no JS errors`, p.errs.length === 0, p.errs.slice(0, 3).join(' | '));
  // global: last GPS spot is remembered (rounded) so the map opens there next time
  const lp = JSON.parse(await host.evaluate(() => localStorage.getItem('gr.lastpos')) || 'null');
  check('last position remembered, rounded', lp && Math.abs(lp[0] - 76.576) < 0.002 && Math.abs(lp[1] - 30.770) < 0.002, JSON.stringify(lp));
  // global: a phone in London can host a game too
  const london = await mk(51.5074, -0.1278);
  await london.goto(URL); await london.fill('#pName', 'Ollie'); await london.click('[data-av="scout"]'); await london.selectOption('#pYear', '2000'); await london.click('#pGo');
  await london.click('#hHost'); await london.waitForSelector('.codebox');
  check('London phone hosts a lobby', await london.isVisible('#lStart'));
  // an iPhone in a Safari tab can't get web push: show how to add Ghostrun to the Home Screen
  const iphone = await mk(40.7128, -74.006, 'iPhone 13');
  await iphone.goto(URL); await iphone.fill('#pName', 'Maya'); await iphone.click('[data-av="spotter"]'); await iphone.selectOption('#pYear', '2001'); await iphone.click('#pGo');
  await iphone.click('#hHost'); await iphone.waitForSelector('.codebox');
  check('iPhone tab gets the Add to Home Screen hint', /Add to Home Screen/.test(await iphone.textContent('#alertsBox')));
  check('iPhone phone: no JS errors', iphone.errs.length === 0, iphone.errs.slice(0, 3).join(' | '));
  check('London phone: no JS errors', london.errs.length === 0, london.errs.slice(0, 3).join(' | '));
  // legal pages: linked from the app, readable at phone width, contact filled in
  await london.evaluate(() => localStorage.removeItem('gr.session'));
  await london.goto(URL); await london.waitForSelector('.legal a[href="/privacy"]');
  await london.click('.legal a[href="/privacy"]'); await london.waitForSelector('h1');
  check('Privacy page opens from home', /Privacy Policy/.test(await london.textContent('h1')));
  check('Privacy page has a contact email', /mailto:[^%]+@/.test(await london.content()));
  check('Privacy page fits phone width', await london.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await london.screenshot({ path: OUT + '/08-privacy.png', fullPage: true });
  await london.click('footer a[href="/terms"]'); await london.waitForSelector('h1');
  check('Terms page opens from Privacy', /Terms & Conditions/.test(await london.textContent('h1')));
  check('Terms page fits phone width', await london.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await london.screenshot({ path: OUT + '/09-terms.png', fullPage: true });
  // horizontal overflow at phone width
  check('no horizontal scroll', await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log(results.join('\n'));
  await browser.close();
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
