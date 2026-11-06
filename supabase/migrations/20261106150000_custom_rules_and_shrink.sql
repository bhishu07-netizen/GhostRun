-- Custom rules and a shrinking zone.
-- The host can pick the head start (2/5/10 min), the length of a timed game (30/60/120 min),
-- and a fixed ping gap (5/10/15/20 min) instead of the automatic ladder. Quick mode keeps its
-- fixed rules. With a play zone set, "shrink" makes the zone 20% smaller at every ping
-- (never below 100 m) and alerts everyone.

alter table public.games
  add column head_start_min int check (head_start_min in (2, 5, 10)),
  add column game_len_min int check (game_len_min in (30, 60, 120)),
  add column ping_every_min int check (ping_every_min in (5, 10, 15, 20)),
  add column shrink boolean not null default false;

-- a fixed ping gap wins over the automatic ladder
create or replace function public._interval_min(g public.games)
 returns integer language sql immutable set search_path to 'public'
as $$
  select coalesce(g.ping_every_min,
    greatest(5, (case when coalesce(g.start_players, 0) <= 5 then 15
                      when g.start_players <= 7 then 20 else 25 end) - 5 * g.catches));
$$;

-- host only, lobby only; null means "use the default"
create or replace function public.set_rules(p_player uuid, p_secret text, p_head int, p_len int, p_ping int, p_shrink boolean)
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare me public.players; g public.games;
begin
  me := public._auth(p_player, p_secret);
  select * into g from public.games where id = me.game_id for update;
  if g.host_id <> me.id then raise exception 'Only the host can change the rules.'; end if;
  if g.status <> 'lobby' then raise exception 'The rules are locked once the game starts.'; end if;
  if p_head is not null and p_head not in (2, 5, 10) then raise exception 'Head start must be 2, 5 or 10 minutes.'; end if;
  if p_len is not null and p_len not in (30, 60, 120) then raise exception 'Game length must be 30, 60 or 120 minutes.'; end if;
  if p_ping is not null and p_ping not in (5, 10, 15, 20) then raise exception 'Pings must be every 5, 10, 15 or 20 minutes.'; end if;
  update public.games set head_start_min = p_head, game_len_min = p_len, ping_every_min = p_ping,
    shrink = coalesce(p_shrink, false) where id = g.id;
end $$;
revoke all on function public.set_rules(uuid, text, int, int, int, boolean) from public;
grant execute on function public.set_rules(uuid, text, int, int, int, boolean) to anon;

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
  v_mins := case when g.mode = 'quick' then 1 else coalesce(g.head_start_min, 5) end;
  v_head := make_interval(mins => v_mins);
  update public.games set status = 'live', start_players = nh + ng, started_at = now(),
    hunt_starts_at = now() + v_head,
    ends_at = case g.mode when 'quick' then now() + interval '15 minutes'
                          when 'hour' then now() + make_interval(mins => coalesce(g.game_len_min, 60)) else null end
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
declare g public.games; h record; v_r int;
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
    if g.shrink and g.zone_radius_m is not null and g.zone_radius_m > 100 then
      update public.games set zone_radius_m = greatest(100, round(zone_radius_m * 0.8)::int) where id = g.id
        returning zone_radius_m into v_r;
      perform public._notify(g.id, null, null, 'The zone is shrinking',
        format('It is now %s m around the centre. Stay inside.', v_r), 'shrink');
    end if;
  end if;
  for h in select * from public.hints where game_id = g.id and photo is null and not penalized and deadline < now() loop
    update public.hints set penalized = true where id = h.id;
    if exists (select 1 from public.players where id = h.player_id and team = 'ghost') then
      insert into public.pings(game_id, seq, kind, snapshot) values (g.id, h.ping_seq, 'penalty', public._snapshot(g.id, h.player_id));
    end if;
  end loop;
  select * into g from public.games where id = g.id;
  perform public._zone_check(g);
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
       'rules', jsonb_build_object('head', g.head_start_min, 'len', g.game_len_min, 'ping', g.ping_every_min, 'shrink', g.shrink)),
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
