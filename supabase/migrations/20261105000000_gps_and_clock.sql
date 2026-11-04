-- 1. Ghosts can't hide by turning GPS off: every ghost is in every snapshot,
--    flagged no_gps when their location is missing or older than 2 minutes.
create or replace function public._snapshot(p_game uuid, p_only uuid default null)
 returns jsonb language sql security definer set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'lat', l.lat, 'lng', l.lng, 'acc', l.acc, 'at', l.updated_at,
           'no_gps', l.updated_at is null or l.updated_at < now() - interval '2 minutes')), '[]'::jsonb)
  from public.players p left join public.locations l on l.player_id = p.id
  where p.game_id = p_game and p.team = 'ghost' and (p_only is null or p.id = p_only);
$function$;

-- get_state: hunters get each ghost's GPS freshness; a ghost's "last seen" skips snapshots without a position.
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
       'interval_min', case when g.mode = 'quick' or g.status = 'lobby' then null else public._interval_min(g) end),
    'me', jsonb_build_object('id', me.id, 'name', me.name, 'avatar', me.avatar, 'team', me.team),
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

-- 2. The game clock runs on the server: every 30 s, tick every live game (pings, penalties, time-up)
--    and clear out games older than a day, even when no phone is polling.
create extension if not exists pg_cron;

create or replace function public._tick_all()
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare r record;
begin
  for r in select id from public.games where status = 'live' loop
    begin
      perform public._tick(r.id);
    exception when others then
      raise warning 'ghostrun tick failed for %: %', r.id, sqlerrm;
    end;
  end loop;
  delete from public.games where created_at < now() - interval '1 day';
end $function$;
revoke all on function public._tick_all() from public, anon, authenticated;

select cron.unschedule('ghostrun-tick') where exists (select 1 from cron.job where jobname = 'ghostrun-tick');
select cron.schedule('ghostrun-tick', '30 seconds', 'select public._tick_all()');
