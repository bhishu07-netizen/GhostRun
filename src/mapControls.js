// Map buttons, the way a maps app has them: compass (North up / Default), Satellite, and "centre on me".
// Shown on the home screen and during a game; hidden on tall menu cards where they'd cover content.
import './mapcontrols.css';
import { lastPos } from './api.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const pref = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: the buttons still work */ } },
};

const SVG = (inner) => `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">${inner}</svg>`;
const ICON = {
  compass: SVG('<g class="needle"><path d="M12 3.2 16.2 12H7.8z" fill="#EC4899"/><path d="M12 20.8 7.8 12h8.4z" fill="currentColor" opacity=".4"/></g><circle cx="12" cy="12" r="1.7" fill="#fff" stroke="currentColor" stroke-width="1.2"/>'),
  layers: SVG('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/></g>'),
  locate: SVG('<circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
};

export function mountMapControls(map, { getPos }) {
  const screenEl = document.getElementById('screen');
  const hudEl = document.getElementById('hud');
  const box = document.createElement('div');
  box.className = 'mapctl';
  box.hidden = true;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Map controls');
  box.innerHTML = `
    <button type="button" class="mc" id="mcCompass" aria-pressed="false">${ICON.compass}</button>
    <button type="button" class="mc" id="mcSat" aria-pressed="false">${ICON.layers}</button>
    <button type="button" class="mc" id="mcLoc" aria-pressed="false">${ICON.locate}</button>
    <p class="mc-hint" role="status" aria-live="polite" hidden></p>`;
  document.body.append(box);
  const $ = (id) => box.querySelector('#' + id);
  const compassBtn = $('mcCompass'), satBtn = $('mcSat'), locBtn = $('mcLoc'), hintEl = box.querySelector('.mc-hint');
  const needle = compassBtn.querySelector('.needle');

  const live = () => !hudEl.hidden;
  const dur = (ms) => (reduceMotion ? 0 : ms);
  let northUp = false, sat = false, follow = false, wasLive = false, hintTimer = null;

  function hint(text) {
    hintEl.textContent = text; hintEl.hidden = false;
    clearTimeout(hintTimer); hintTimer = setTimeout(() => { hintEl.hidden = true; }, 2600);
  }

  // ----- satellite
  function setSatellite(on, say) {
    sat = on;
    map.setMapType(on ? 'satellite' : 'pastel');
    satBtn.setAttribute('aria-pressed', String(on));
    satBtn.setAttribute('aria-label', on ? 'Satellite view is on. Tap for the Ghostrun map' : 'Switch to satellite view');
    box.dataset.type = on ? 'satellite' : 'pastel';
    pref.set('gr.maptype', on ? 'satellite' : 'pastel');
    if (say) hint(on ? 'Satellite view' : 'Ghostrun map');
  }

  // ----- compass: North up (top of the screen is always north) or Default (turn the map with two fingers)
  function setNorthUp(on, say) {
    northUp = on;
    map.lockNorth = on;
    map.dragRotate[on ? 'disable' : 'enable']();
    map.touchZoomRotate[on ? 'disableRotation' : 'enableRotation']();
    compassBtn.setAttribute('aria-pressed', String(on));
    compassBtn.setAttribute('aria-label', on ? 'North up is on. Tap to rotate the map freely' : 'Compass. Tap to keep north at the top');
    box.dataset.northup = on ? '1' : '0';
    pref.set('gr.northup', on ? '1' : '0');
    if (on) map.easeTo({ bearing: 0, duration: dur(450) });
    if (say) hint(on ? 'North up: north stays at the top' : 'Default: turn the map with two fingers');
  }
  const drawNeedle = () => needle.setAttribute('transform', `rotate(${(-map.getBearing()).toFixed(1)} 12 12)`);
  const stamp = () => { drawNeedle(); box.dataset.bearing = String(Math.round(map.getBearing())); box.dataset.zoom = map.getZoom().toFixed(1); };
  map.on('rotate', drawNeedle);
  map.on('moveend', stamp);

  // ----- centre on me (and keep following during a game, until the player drags the map away)
  function fresh() {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition((p) => {
        const ll = [p.coords.longitude, p.coords.latitude, p.coords.accuracy];
        lastPos.set(ll);
        resolve(ll);
      }, () => resolve(null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 });
    });
  }
  async function locate({ quiet = false } = {}) {
    let pos = getPos && getPos();
    if (!pos) pos = await fresh();
    if (!pos) pos = lastPos.get();
    if (!pos) { if (!quiet) hint('Allow location to find yourself'); return; }
    follow = live();
    if (!quiet && map.setOrbit) map.setOrbit(false);
    map.flyTo({ center: [pos[0], pos[1]], zoom: Math.max(map.getZoom(), 17.2), duration: dur(900), essential: true });
    syncLoc();
  }
  function syncLoc() {
    locBtn.setAttribute('aria-pressed', String(follow));
    locBtn.setAttribute('aria-label', follow ? 'Following you. Drag the map to look around' : 'Centre the map on me');
    box.dataset.follow = follow ? '1' : '0';
  }
  map.on('dragstart', (e) => { if (e.originalEvent && follow) { follow = false; syncLoc(); } });

  setInterval(() => {
    const isLive = live();
    if (isLive && !wasLive) follow = true;      // a game just started: stay on the player
    if (!isLive && wasLive) follow = false;
    wasLive = isLive;
    if (follow && isLive && !map.isMoving()) {
      const p = getPos && getPos();
      if (p) {
        const c = map.getCenter();
        if (Math.abs(c.lng - p[0]) + Math.abs(c.lat - p[1]) > 0.00002) map.easeTo({ center: [p[0], p[1]], duration: dur(900), easing: (x) => x });
      }
    }
    syncLoc();
  }, 1000);

  // ----- where the buttons show, and keeping the player's spot above the menu card
  function applyPadding() {
    const card = screenEl.querySelector('.card');
    const bottom = card ? Math.round(Math.min(card.offsetHeight + 24, window.innerHeight * 0.55)) : 0;
    if (Math.abs((map.getPadding().bottom || 0) - bottom) > 4) map.setPadding({ top: 0, left: 0, right: 0, bottom });
  }
  function sync() {
    const inGame = live();
    box.classList.toggle('live', inGame);
    box.hidden = !(inGame || screenEl.querySelector('#hHost'));
    if (!inGame && !box.hidden) {
      // on a short screen the home card can reach the top: then there's no room for the buttons, so hide them
      const card = screenEl.querySelector('.card');
      box.hidden = !!card && card.getBoundingClientRect().top < box.getBoundingClientRect().bottom + 8;
    }
    applyPadding();
  }
  window.addEventListener('resize', sync);
  new MutationObserver(sync).observe(screenEl, { childList: true });
  new MutationObserver(sync).observe(hudEl, { attributes: true, attributeFilter: ['hidden'] });

  compassBtn.onclick = () => setNorthUp(!northUp, true);
  satBtn.onclick = () => setSatellite(!sat, true);
  locBtn.onclick = () => locate();

  setNorthUp(pref.get('gr.northup') === '1', false);
  setSatellite(pref.get('gr.maptype') === 'satellite', false);
  syncLoc(); stamp(); sync();
  return { locate };
}
