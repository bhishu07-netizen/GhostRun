-- Round 5: rematch and a closeness check on catches.
--
-- Rematch: from an ended game, the first player to tap Rematch creates a new lobby with the
-- same mode, rules and play zone and becomes its host; everyone else who taps it joins that
-- lobby. The old game remembers the new code so the results screen can offer "Join rematch".
--
-- Catch check: when both the hunter's and the ghost's phones sent a fix in the last minute,
-- they must be within 60 m plus both GPS accuracies (each capped at 50 m). Without fresh
-- fixes the catch is allowed as before and the ghost still confirms it.

alter table public.games add column rematch_code text;
alter table public.games add column zone_start_r int;

create or replace function public.rematch(p_player uuid, p_secret text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare me public.players; g public.games; n public.games; v jsonb;
begin
  me := public._auth(p_player, p_secret);
  select * into g from public.games where id = me.game_id for update;
  if g.status <> 'ended' then raise exception 'You can only start a rematch after the game ends.'; end if;
  if g.rematch_code is not null then
    select * into n from public.games where code = g.rematch_code and status = 'lobby';
  end if;
  if n.id is not null then
    return public.join_game(n.code, me.name, me.avatar, true);
  end if;
  v := public.create_game(g.mode, me.name, me.avatar, true);
  update public.games set head_start_min = g.head_start_min, ping_every_min = g.ping_every_min, shrink = g.shrink,
    zone_lat = g.zone_lat, zone_lng = g.zone_lng,
    zone_radius_m = case when g.zone_radius_m is null then null else coalesce(g.zone_start_r, g.zone_radius_m) end
  where id = (v->>'game_id')::uuid;
  update public.games set rematch_code = v->>'code' where id = g.id;
  return v;
end $$;
revoke all on function public.rematch(uuid, text) from public;
grant execute on function public.rematch(uuid, text) to anon;

-- remember the zone's starting size so a rematch doesn't start with a shrunken zone
create or replace function public._remember_zone_start()
 returns trigger language plpgsql set search_path to 'public'
as $$
begin
  if new.status = 'live' and old.status = 'lobby' then new.zone_start_r := new.zone_radius_m; end if;
  return new;
end $$;
create trigger games_zone_start before update of status on public.games
  for each row execute function public._remember_zone_start();

create or replace function public.report_catch(p_player uuid, p_secret text, p_ghost uuid)
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare me public.players; g public.games; lh public.locations; lg public.locations; v_d double precision; v_max double precision;
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
  -- when both phones have a fresh fix, the hunter has to be close to the ghost
  select * into lh from public.locations where player_id = me.id and updated_at > now() - interval '60 seconds';
  select * into lg from public.locations where player_id = p_ghost and updated_at > now() - interval '60 seconds';
  if lh.player_id is not null and lg.player_id is not null then
    v_d := public._dist_m(lh.lat, lh.lng, lg.lat, lg.lng);
    v_max := 60 + least(coalesce(lh.acc, 0), 50) + least(coalesce(lg.acc, 0), 50);
    if v_d > v_max then
      raise exception 'You are about % m apart. Get closer to catch them.', round(v_d)::int;
    end if;
  end if;
  delete from public.catches where ghost_id = p_ghost and status = 'pending';
  insert into public.catches(game_id, hunter_id, ghost_id) values (me.game_id, me.id, p_ghost);
  perform public._notify(me.game_id, null, p_ghost, format('%s says they caught you', me.name),
    'Open Ghostrun to confirm, or say you escaped.', 'catch');
end $$;

create or replace function public.get_state(p_player uuid, p_secret text, p_photos_since timestamp with time zone default null)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare me public.players; g public.games; res jsonb;
begin
  me := public._auth(p_player, p_secret);
  perform public._tick(me.game_id);
  select * into me from public.players where id = me.id;
  select * into g from public.games where id = me.game_id;
  res := jsonb_build_object(
    'now', now(),
    'game', jsonb_build_object('id', g.id, 'code', g.code, 'mode', g.mode, 'status', g.status, 'host_id', g.host_id,
       'started_at', g.started_at, 'hunt_starts_at', g.hunt_starts_at, 'ends_at', g.ends_at, 'next_ping_at', g.next_ping_at,
       'catches', g.catches, 'ping_seq', g.ping_seq, 'winner', g.winner,
       'interval_min', case when g.mode = 'quick' or g.status = 'lobby' then null else public._interval_min(g) end,
       'zone', case when g.zone_radius_m is null then null
                    else jsonb_build_object('lat', g.zone_lat, 'lng', g.zone_lng, 'r', g.zone_radius_m) end,
       'rules', jsonb_build_object('head', g.head_start_min, 'len', g.game_len_min, 'ping', g.ping_every_min, 'shrink', g.shrink),
       'rematch_code', g.rematch_code),
    'me', jsonb_build_object('id', me.id, 'name', me.name, 'avatar', me.avatar, 'team', me.team, 'out_since', me.out_since),
    'players', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'avatar', p.avatar, 'team', p.team,
                  'caught', not p.alive, 'caught_by', p.caught_by, 'online', p.last_seen > now() - interval '45 seconds') order by p.joined_at), '[]')
                from public.players p where p.game_id = g.id),
    'teammates', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'lat', l.lat, 'lng', l.lng, 'at', l.updated_at)), '[]')
                from public.players p join public.locations l on l.player_id = p.id
                where p.game_id = g.id and p.team = me.team and p.id <> me.id and l.updated_at > now() - interval '2 minutes')
  );
  if me.team = 'hunter' then
    res := res || jsonb_build_object(
      'pings', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
                  select seq, kind, snapshot, created_at from public.pings where game_id = g.id order by created_at desc limit 6) x),
      'photos', (select coalesce(jsonb_agg(jsonb_build_object('player_id', h.player_id, 'seq', h.ping_seq, 'photo', h.photo, 'uploaded_at', h.uploaded_at)), '[]')
                 from public.hints h where h.game_id = g.id and h.photo is not null
                 and (p_photos_since is null or h.uploaded_at > p_photos_since)),
      'my_claims', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'ghost_id', c.ghost_id, 'status', c.status)), '[]')
                 from public.catches c where c.hunter_id = me.id and c.created_at > now() - interval '2 minutes'),
      'ghost_gps', case when g.status = 'live' and now() >= g.hunt_starts_at then
                 (select coalesce(jsonb_agg(jsonb_build_object('id', p.id,
                    'age_s', case when l.updated_at is null then null else floor(extract(epoch from now() - l.updated_at))::int end)), '[]')
                  from public.players p left join public.locations l on l.player_id = p.id
                  where p.game_id = g.id and p.team = 'ghost') else '[]'::jsonb end);
  else
    res := res || jsonb_build_object(
      'last_seen', (select e from public.pings pg, jsonb_array_elements(pg.snapshot) e
                    where pg.game_id = g.id and e->>'id' = me.id::text and e->>'lat' is not null order by pg.created_at desc limit 1),
      'hint_due', (select jsonb_build_object('seq', h.ping_seq, 'deadline', h.deadline) from public.hints h
                   where h.player_id = me.id and h.photo is null and not h.penalized and h.deadline > now()
                   order by h.ping_seq desc limit 1),
      'catch_request', (select jsonb_build_object('id', c.id, 'hunter_id', c.hunter_id) from public.catches c
                   where c.ghost_id = me.id and c.status = 'pending' order by c.created_at desc limit 1));
  end if;
  return res;
end $function$;
