-- Web push alerts (so ghosts can lock their phone and still be woken before a ping)
-- and a 5-minute head start for ghosts in 1-hour and Endless games.
--
-- Flow: game events insert rows into push_outbox (one row per subscribed device).
-- An AFTER INSERT trigger pokes the send-push Edge Function through pg_net, and the
-- ghostrun-tick cron job pokes it too as a safety net. The function claims the rows,
-- sends them with the VAPID keys kept in Vault, and forgets subscriptions that are gone.
-- Subscriptions are deleted when the game ends; sent rows are deleted straight away.

create extension if not exists pg_net;

-- ------------------------------------------------------------------ tables
create table public.push_subs (
  endpoint   text primary key check (endpoint ~ '^https://'),
  player_id  uuid not null references public.players(id) on delete cascade,
  game_id    uuid not null references public.games(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index on public.push_subs(game_id);

create table public.push_outbox (
  id         bigint generated always as identity primary key,
  game_id    uuid not null references public.games(id) on delete cascade,
  endpoint   text not null,
  p256dh     text not null,
  auth       text not null,
  title      text not null,
  body       text not null,
  tag        text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subs enable row level security;
alter table public.push_outbox enable row level security;
revoke all on public.push_subs, public.push_outbox from anon, authenticated;

alter table public.games add column warned_seq int not null default 0;
alter table public.games add column hunt_announced boolean not null default false;

-- ------------------------------------------------------------------ queueing
-- Queue one alert for every subscribed device of the matching players.
create or replace function public._notify(p_game uuid, p_team text, p_player uuid, p_title text, p_body text, p_tag text)
 returns void language sql security definer set search_path to 'public'
as $$
  insert into public.push_outbox(game_id, endpoint, p256dh, auth, title, body, tag)
  select s.game_id, s.endpoint, s.p256dh, s.auth, p_title, p_body, p_tag
  from public.push_subs s join public.players p on p.id = s.player_id
  where s.game_id = p_game
    and (p_team is null or p.team = p_team)
    and (p_player is null or p.id = p_player);
$$;

-- Wake the sender. Reads the shared hook secret from Vault.
create or replace function public._push_kick()
 returns trigger language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare cfg jsonb;
begin
  select decrypted_secret::jsonb into cfg from vault.decrypted_secrets where name = 'ghostrun_push';
  if cfg is null then return null; end if;
  perform net.http_post(
    url := 'https://lxsuhejenatbhjuabxep.supabase.co/functions/v1/send-push',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ghostrun-hook', cfg->>'hook'),
    timeout_milliseconds := 10000);
  return null;
end $$;

create trigger push_outbox_kick after insert on public.push_outbox
  for each statement execute function public._push_kick();

-- Called by the send-push function (service role only).
create or replace function public._push_config()
 returns jsonb language sql security definer set search_path to 'public'
as $$ select decrypted_secret::jsonb from vault.decrypted_secrets where name = 'ghostrun_push' $$;

create or replace function public._push_claim(p_limit int default 200)
 returns setof public.push_outbox language sql security definer set search_path to 'public'
as $$
  delete from public.push_outbox where id in (
    select id from public.push_outbox order by id limit p_limit for update skip locked)
  returning *;
$$;

create or replace function public._push_forget(p_endpoints text[])
 returns void language sql security definer set search_path to 'public'
as $$ delete from public.push_subs where endpoint = any(p_endpoints) $$;

revoke all on function public._notify(uuid, text, uuid, text, text, text), public._push_kick(),
  public._push_config(), public._push_claim(int), public._push_forget(text[]) from public, anon, authenticated;
grant execute on function public._push_config(), public._push_claim(int), public._push_forget(text[]) to service_role;

-- ------------------------------------------------------------------ browser entry point
create or replace function public.save_push(p_player uuid, p_secret text, p_sub jsonb)
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare me public.players; v_end text := p_sub->>'endpoint';
begin
  me := public._auth(p_player, p_secret);
  if not exists (select 1 from public.games where id = me.game_id and status <> 'ended') then return; end if;
  if v_end is null or v_end !~ '^https://' or length(v_end) > 1000
     or coalesce(p_sub#>>'{keys,p256dh}', '') = '' or coalesce(p_sub#>>'{keys,auth}', '') = '' then
    raise exception 'That notification subscription looks wrong.';
  end if;
  insert into public.push_subs(endpoint, player_id, game_id, p256dh, auth)
  values (v_end, me.id, me.game_id, p_sub#>>'{keys,p256dh}', p_sub#>>'{keys,auth}')
  on conflict (endpoint) do update set player_id = excluded.player_id, game_id = excluded.game_id,
    p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
end $$;
revoke all on function public.save_push(uuid, text, jsonb) from public;
grant execute on function public.save_push(uuid, text, jsonb) to anon;

-- ------------------------------------------------------------------ game functions with alerts
create or replace function public.start_game(p_player uuid, p_secret text)
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare me public.players; g public.games; nh int; ng int; v_head interval; v_mins int;
begin
  me := public._auth(p_player, p_secret);
  select * into g from public.games where id = me.game_id for update;
  if g.host_id <> me.id then raise exception 'Only the host can start.'; end if;
  if g.status <> 'lobby' then return; end if;
  select count(*) filter (where team='hunter'), count(*) filter (where team='ghost') into nh, ng
    from public.players where game_id = g.id;
  if nh < 1 or ng < 1 then raise exception 'You need at least 1 hunter and 1 ghost.'; end if;
  v_mins := case when g.mode = 'quick' then 1 else 5 end;
  v_head := make_interval(mins => v_mins);
  update public.games set status = 'live', start_players = nh + ng, started_at = now(),
    hunt_starts_at = now() + v_head,
    ends_at = case g.mode when 'quick' then now() + interval '15 minutes'
                          when 'hour' then now() + interval '60 minutes' else null end
  where id = g.id returning * into g;
  if g.mode <> 'quick' then
    update public.games set next_ping_at = now() + make_interval(mins => public._interval_min(g)) where id = g.id;
  end if;
  perform public._notify(g.id, 'ghost', null, 'The hunt is on!',
    format('Run and hide. Hunters start chasing in %s minute%s.', v_mins, case when v_mins = 1 then '' else 's' end), 'start');
  perform public._notify(g.id, 'hunter', null, 'The hunt is on!',
    format('Ghosts are hiding. You can start hunting in %s minute%s.', v_mins, case when v_mins = 1 then '' else 's' end), 'start');
end $$;

create or replace function public._tick(p_game uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare g public.games; h record;
begin
  select * into g from public.games where id = p_game for update;
  if g.status <> 'live' then return; end if;
  if not exists (select 1 from public.players where game_id = g.id and team = 'ghost') then
    perform public._end(g.id, 'hunters'); return;
  end if;
  if g.ends_at is not null and now() >= g.ends_at then
    perform public._end(g.id, 'ghosts'); return;
  end if;
  -- head start over
  if not g.hunt_announced and now() >= g.hunt_starts_at then
    update public.games set hunt_announced = true where id = g.id;
    perform public._notify(g.id, 'hunter', null, 'Go hunt!', 'The head start is over. Find the ghosts.', 'hunt');
    perform public._notify(g.id, 'ghost', null, 'Hunters are coming', 'The head start is over. Stay hidden.', 'hunt');
  end if;
  -- about a minute before a ping, wake the ghosts so their position is fresh
  if g.next_ping_at is not null and g.warned_seq < g.ping_seq + 1
     and now() >= g.next_ping_at - interval '75 seconds' and now() < g.next_ping_at then
    update public.games set warned_seq = g.ping_seq + 1 where id = g.id;
    perform public._notify(g.id, 'ghost', null, 'Ping in 1 minute',
      'Open Ghostrun now. Hunters are about to see your spot, and you will need to send a photo hint.', 'ping-soon');
  end if;
  if g.next_ping_at is not null and now() >= g.next_ping_at then
    update public.games set ping_seq = ping_seq + 1 where id = g.id returning * into g;
    insert into public.pings(game_id, seq, kind, snapshot) values (g.id, g.ping_seq, 'ping', public._snapshot(g.id));
    insert into public.hints(game_id, player_id, ping_seq, deadline)
      select g.id, p.id, g.ping_seq, now() + interval '60 seconds' from public.players p
      where p.game_id = g.id and p.team = 'ghost' on conflict do nothing;
    update public.games set next_ping_at = now() + make_interval(mins => public._interval_min(g)) where id = g.id;
    perform public._notify(g.id, 'ghost', null, 'Ping! Send your photo hint',
      'Hunters just saw your spot. You have 60 seconds to send a photo hint.', 'ping');
    perform public._notify(g.id, 'hunter', null, 'Ping!', 'Ghost positions are on the map.', 'ping');
  end if;
  for h in select * from public.hints where game_id = g.id and photo is null and not penalized and deadline < now() loop
    update public.hints set penalized = true where id = h.id;
    if exists (select 1 from public.players where id = h.player_id and team = 'ghost') then
      insert into public.pings(game_id, seq, kind, snapshot) values (g.id, h.ping_seq, 'penalty', public._snapshot(g.id, h.player_id));
    end if;
  end loop;
end $$;

create or replace function public.report_catch(p_player uuid, p_secret text, p_ghost uuid)
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare me public.players; g public.games;
begin
  me := public._auth(p_player, p_secret);
  if me.team <> 'hunter' then raise exception 'Only hunters can report a catch.'; end if;
  select * into g from public.games where id = me.game_id;
  if g.status <> 'live' then raise exception 'The game is not running.'; end if;
  if now() < g.hunt_starts_at then raise exception 'Hold on, ghosts still have their head start.'; end if;
  if not exists (select 1 from public.players where id = p_ghost and game_id = me.game_id and team = 'ghost') then raise exception 'That player is not a ghost.'; end if;
  if exists (select 1 from public.catches where hunter_id = me.id and ghost_id = p_ghost and status = 'rejected'
             and created_at > now() - interval '30 seconds') then
    raise exception 'They just said they escaped. Try again in a few seconds.';
  end if;
  delete from public.catches where ghost_id = p_ghost and status = 'pending';
  insert into public.catches(game_id, hunter_id, ghost_id) values (me.game_id, me.id, p_ghost);
  perform public._notify(me.game_id, null, p_ghost, format('%s says they caught you', me.name),
    'Open Ghostrun to confirm, or say you escaped.', 'catch');
end $$;

create or replace function public.respond_catch(p_player uuid, p_secret text, p_catch bigint, p_accept boolean)
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare me public.players; c public.catches;
begin
  me := public._auth(p_player, p_secret);
  select * into c from public.catches where id = p_catch and ghost_id = me.id and status = 'pending';
  if c.id is null then return; end if;
  update public.catches set status = case when p_accept then 'confirmed' else 'rejected' end where id = c.id;
  if p_accept then
    perform public._apply_catch(me.game_id, me.id, c.hunter_id);
  else
    perform public._notify(me.game_id, null, c.hunter_id, format('%s says they escaped', me.name),
      'They rejected your catch. Keep hunting.', 'catch');
  end if;
end $$;

create or replace function public._end(p_game uuid, p_winner text)
 returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  update public.games set status = 'ended', winner = p_winner, next_ping_at = null where id = p_game and status = 'live';
  if not found then return; end if;
  perform public._notify(p_game, null, null,
    case when p_winner = 'hunters' then 'Hunters win!' else 'Ghosts win!' end,
    'The game is over. Open Ghostrun to see the results.', 'end');
  delete from public.locations where game_id = p_game;
  delete from public.hints where game_id = p_game;
  delete from public.push_subs where game_id = p_game;
  update public.pings set snapshot = '[]'::jsonb where game_id = p_game;
end $$;

-- safety net: the 30-second cron job also flushes anything left in the outbox, and drops stale rows
create or replace function public._tick_all()
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare r record;
begin
  for r in select id from public.games where status = 'live' loop
    begin
      perform public._tick(r.id);
    exception when others then
      raise warning 'ghostrun tick failed for %: %', r.id, sqlerrm;
    end;
  end loop;
  delete from public.push_outbox where created_at < now() - interval '10 minutes';
  if exists (select 1 from public.push_outbox) then
    perform public._push_kick_now();
  end if;
  delete from public.games where created_at < now() - interval '1 day';
end $$;

create or replace function public._push_kick_now()
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare cfg jsonb;
begin
  select decrypted_secret::jsonb into cfg from vault.decrypted_secrets where name = 'ghostrun_push';
  if cfg is null then return; end if;
  perform net.http_post(
    url := 'https://lxsuhejenatbhjuabxep.supabase.co/functions/v1/send-push',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ghostrun-hook', cfg->>'hook'),
    timeout_milliseconds := 10000);
end $$;
revoke all on function public._push_kick_now(), public._tick_all() from public, anon, authenticated;
