-- Play zone: the host draws a circle in the lobby. A ghost who stays outside it for more
-- than 30 seconds after the head start is revealed to the hunters (a "zone" ping for just
-- that ghost), again every minute while they stay out, and gets an alert.

alter table public.games
  add column zone_lat double precision check (zone_lat between -90 and 90),
  add column zone_lng double precision check (zone_lng between -180 and 180),
  add column zone_radius_m int check (zone_radius_m between 100 and 5000);

alter table public.players
  add column out_since timestamptz,
  add column zone_revealed_at timestamptz;

alter table public.pings drop constraint if exists pings_kind_check;
alter table public.pings add constraint pings_kind_check check (kind in ('ping', 'penalty', 'zone'));

-- great-circle distance in metres
create or replace function public._dist_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
 returns double precision language sql immutable set search_path to 'public'
as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- host only, lobby only; a null radius removes the zone
create or replace function public.set_zone(p_player uuid, p_secret text, p_lat double precision, p_lng double precision, p_radius int)
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare me public.players; g public.games;
begin
  me := public._auth(p_player, p_secret);
  select * into g from public.games where id = me.game_id for update;
  if g.host_id <> me.id then raise exception 'Only the host can set the play zone.'; end if;
  if g.status <> 'lobby' then raise exception 'The play zone is locked once the game starts.'; end if;
  if p_radius is null then
    update public.games set zone_lat = null, zone_lng = null, zone_radius_m = null where id = g.id;
    return;
  end if;
  if p_lat is null or p_lng is null then raise exception 'Need your location to set the zone.'; end if;
  if p_radius < 100 or p_radius > 5000 then raise exception 'The zone must be between 100 m and 5 km across.'; end if;
  update public.games set zone_lat = p_lat, zone_lng = p_lng, zone_radius_m = p_radius where id = g.id;
end $$;
revoke all on function public.set_zone(uuid, text, double precision, double precision, int) from public;
grant execute on function public.set_zone(uuid, text, double precision, double precision, int) to anon;
revoke all on function public._dist_m(double precision, double precision, double precision, double precision) from public, anon, authenticated;

-- zone check, run from _tick; a fix is "outside" only beyond the radius plus its accuracy
-- (at least 20 m), so GPS wobble near the edge doesn't count
create or replace function public._zone_check(g public.games)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare r record;
begin
  if g.zone_radius_m is null then return; end if;
  for r in
    select p.id, p.name, p.out_since, p.zone_revealed_at,
           public._dist_m(g.zone_lat, g.zone_lng, l.lat, l.lng) > g.zone_radius_m + greatest(coalesce(l.acc, 0), 20) as outside
    from public.players p join public.locations l on l.player_id = p.id
    where p.game_id = g.id and p.team = 'ghost' and l.updated_at > now() - interval '2 minutes'
  loop
    if not r.outside then
      if r.out_since is not null then update public.players set out_since = null where id = r.id; end if;
      continue;
    end if;
    if r.out_since is null then
      update public.players set out_since = now() where id = r.id;
      perform public._notify(g.id, null, r.id, 'You left the play zone',
        'Get back in within 30 seconds or the hunters will see where you are.', 'zone');
      continue;
    end if;
    if now() >= g.hunt_starts_at and now() - r.out_since >= interval '30 seconds'
       and (r.zone_revealed_at is null or now() - r.zone_revealed_at >= interval '60 seconds') then
      update public.players set zone_revealed_at = now() where id = r.id;
      insert into public.pings(game_id, seq, kind, snapshot) values (g.id, g.ping_seq, 'zone', public._snapshot(g.id, r.id));
      perform public._notify(g.id, null, r.id, 'Hunters can see you',
        'You stayed outside the play zone, so your spot was shown to the hunters.', 'zone');
      perform public._notify(g.id, 'hunter', null, format('%s left the play zone', r.name),
        'Their spot is on the map.', 'zone');
    end if;
  end loop;
end $$;
revoke all on function public._zone_check(public.games) from public, anon, authenticated;

-- _tick: same as before, plus the zone check at the end
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
  if not g.hunt_announced and now() >= g.hunt_starts_at then
    update public.games set hunt_announced = true where id = g.id;
    perform public._notify(g.id, 'hunter', null, 'Go hunt!', 'The head start is over. Find the ghosts.', 'hunt');
    perform public._notify(g.id, 'ghost', null, 'Hunters are coming', 'The head start is over. Stay hidden.', 'hunt');
  end if;
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
  perform public._zone_check(g);
end $$;

-- get_state: same as before, plus the zone in the game object and the player's own out-of-zone time
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
                    else jsonb_build_object('lat', g.zone_lat, 'lng', g.zone_lng, 'r', g.zone_radius_m) end),
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
