import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { pastelStyle, buildingHeight } from './pastelStyle.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const WORLD_VIEW = { center: [20, 20], zoom: 1.4, pitch: 0, bearing: 0 };
export const localView = (lngLat) => ({ center: lngLat, zoom: 16, pitch: 45, bearing: -15 });

// start where this player last played, or on the whole globe
export function createMap(onError, start = WORLD_VIEW) {
  const map = new maplibregl.Map({
    container: 'map',
    style: pastelStyle(),
    ...start,
    minZoom: 1,
    maxZoom: 19.5,
    attributionControl: false,
  });
  map.on('style.load', () => { try { map.setProjection({ type: 'globe' }); } catch { /* flat map is fine */ } });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.on('error', (e) => onError && onError((e && e.error && e.error.message) || 'Map error'));

  let grown = false;
  const grow = () => {
    if (grown) return;
    grown = true;
    if (reduceMotion) { map.setPaintProperty('building-3d', 'fill-extrusion-height', buildingHeight(1)); return; }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 1400);
      const k = 1 - Math.pow(1 - p, 3) + Math.sin(p * Math.PI) * 0.08;
      map.setPaintProperty('building-3d', 'fill-extrusion-height', buildingHeight(p < 1 ? k : 1));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    // if the tab is in the background, rAF never fires: make sure buildings still stand up
    setTimeout(() => map.setPaintProperty('building-3d', 'fill-extrusion-height', buildingHeight(1)), 2500);
  };
  // buildings grow the first time we're close enough to see them
  const maybeGrow = () => { if (map.getZoom() >= 14) grow(); };
  map.on('load', maybeGrow);
  map.on('zoomend', maybeGrow);

  // gentle orbit for menu screens
  let orbiting = false;
  const spin = () => {
    if (!orbiting) return;
    if (map.getZoom() < 5) { const c = map.getCenter(); map.easeTo({ center: [c.lng + 12, c.lat], duration: 4000, easing: (x) => x }); } // turn the globe
    else map.easeTo({ bearing: map.getBearing() + 8, duration: 4000, easing: (x) => x }); // circle the neighbourhood
  };
  map.on('moveend', spin);
  ['mousedown', 'touchstart', 'wheel', 'dragstart'].forEach((ev) => map.on(ev, () => { orbiting = false; }));
  map.setOrbit = (on) => {
    if (reduceMotion) return;
    orbiting = on;
    if (on) { if (map.loaded()) spin(); else map.once('load', spin); }
  };
  return map;
}

// avatar marker that we can move and fade
export function avatarMarker(map, { avatar, label, ring, size = 40, echo = false }) {
  const el = document.createElement('div');
  el.className = 'mk' + (echo ? ' echo' : '');
  el.style.setProperty('--ring', ring);
  const img = document.createElement('img');
  img.src = `/a/${avatar}.png`;
  img.alt = '';
  img.width = size; img.height = size;
  const tag = document.createElement('span');
  tag.textContent = label;
  el.append(img, tag);
  const m = new maplibregl.Marker({ element: el, anchor: 'center' });
  m.setLabel = (t) => { tag.textContent = t; };
  m.setOpacity = (o) => { el.style.opacity = o; };
  return m;
}

export function circle([lng, lat], radiusM, steps = 48) {
  const coords = [];
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    coords.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
}
