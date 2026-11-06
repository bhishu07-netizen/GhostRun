// Ghostrun: delivers queued web-push alerts.
//
// The database queues one row per subscribed device in public.push_outbox and pokes this
// function (from a trigger, and from the 30-second cron job as a safety net) with the shared
// hook secret. VAPID keys and the hook secret live in Supabase Vault and are read through
// _push_config(), which only the service role can call. Rows are deleted as they are claimed,
// and subscriptions the push service reports as gone (404/410) are forgotten.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'jsr:@supabase/supabase-js@2';

type Row = { endpoint: string; p256dh: string; auth: string; title: string; body: string; tag: string };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const { data: cfg, error: cfgErr } = await db.rpc('_push_config');
  if (cfgErr || !cfg) return json({ error: 'not configured' }, 500);
  if (req.headers.get('x-ghostrun-hook') !== cfg.hook) return json({ error: 'forbidden' }, 403);

  webpush.setVapidDetails(cfg.subject, cfg.public, cfg.private);

  let sent = 0, failed = 0;
  const gone: string[] = [];
  // drain in batches so one poke clears a burst (e.g. a ping for 12 players)
  for (let round = 0; round < 5; round++) {
    const { data: rows, error } = await db.rpc('_push_claim', { p_limit: 200 });
    if (error) return json({ error: error.message }, 500);
    if (!rows || rows.length === 0) break;
    const results = await Promise.allSettled((rows as Row[]).map((r) =>
      webpush.sendNotification(
        { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
        JSON.stringify({ title: r.title, body: r.body, tag: r.tag }),
        { TTL: 120, urgency: 'high', topic: r.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined },
      )));
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') { sent++; return; }
      failed++;
      const code = (res.reason && (res.reason as { statusCode?: number }).statusCode) || 0;
      if (code === 404 || code === 410) gone.push((rows as Row[])[i].endpoint);
    });
  }
  if (gone.length) await db.rpc('_push_forget', { p_endpoints: gone });
  return json({ sent, failed, forgotten: gone.length });
});
