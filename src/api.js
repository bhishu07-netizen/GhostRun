// Thin client for the Ghostrun database functions. All game rules live on the server.
const URL_BASE = 'https://lxsuhejenatbhjuabxep.supabase.co/rest/v1/rpc/';
const KEY = 'sb_publishable_3deF2gOExRG9LXpYezwO_g_0L1sS9Qg';

export async function rpc(fn, args = {}) {
  let res;
  try {
    res = await fetch(URL_BASE + fn, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error('No internet connection. Check your network and try again.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && (data.message || data.hint)) || 'Something went wrong.');
  return data;
}

// ---- local storage, always wrapped ----
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
export const profile = {
  get: () => store.get('gr.profile'),
  set: (p) => store.set('gr.profile', p),
};
// where this player last had GPS, rounded to ~100 m; only used to open the map near them
export const lastPos = {
  get: () => store.get('gr.lastpos'),
  set: ([lng, lat]) => store.set('gr.lastpos', [Math.round(lng * 1000) / 1000, Math.round(lat * 1000) / 1000]),
};
export const session = {
  get: () => store.get('gr.session'),
  set: (s) => store.set('gr.session', s),
  clear: () => store.del('gr.session'),
};

export const auth = () => {
  const s = session.get();
  return { p_player: s.player_id, p_secret: s.secret };
};
