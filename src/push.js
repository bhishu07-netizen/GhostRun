// Web push alerts: lets a ghost lock their phone and still be woken before a ping.
// The server decides when to send; this file only asks permission, subscribes the device,
// and hands the subscription to the current game.
import { rpc, auth } from './api.js';

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const ua = navigator.userAgent || '';
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!VAPID;

let reg = null;
export function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then((r) => { reg = r; }).catch(() => { /* alerts just stay off */ });
}

const keyBytes = (b64) => {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const ready = async () => reg || (reg = await navigator.serviceWorker.ready);

// What the alerts control should show right now.
//   'ios-home'   iPhone/iPad in a Safari tab: alerts only work from the Home Screen app
//   'unsupported' this browser can't do web push
//   'blocked'    the player said no; only browser settings can undo that
//   'on'         permission granted (the device gets saved to each game it joins)
//   'off'        not asked yet
export function alertState() {
  if (isIOS && !standalone) return 'ios-home';
  if (!supported) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission === 'granted') return 'on';
  return 'off';
}

async function subscribe() {
  const r = await ready();
  return (await r.pushManager.getSubscription())
    || r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID) });
}

// Must run from a tap: iOS only shows the permission prompt for a user gesture.
export async function turnOnAlerts() {
  if (alertState() !== 'off' && alertState() !== 'on') return alertState();
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return alertState();
  await linkToGame();
  return 'on';
}

// Point this device's subscription at the game we're in. Safe to call on every game entry.
let linkedFor = null;
export async function linkToGame(force = false) {
  if (alertState() !== 'on') return false;
  const a = auth();
  if (!force && linkedFor === a.p_player) return true;
  const sub = await subscribe();
  await rpc('save_push', { ...a, p_sub: sub.toJSON() });
  linkedFor = a.p_player;
  return true;
}
