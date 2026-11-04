alter table public.hints add column uploaded_at timestamptz;

create or replace function public._auth(p_player uuid, p_secret text)
returns public.players language plpgsql security definer set search_path = public, extensions as $$
declare r public.players;
begin
  select * into r from public.players where id = p_player;
  if r.id is null or r.secret_hash <> encode(digest(coalesce(p_secret,''), 'sha256'), 'hex') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.players set last_seen = now() where id = p_player;
  return r;
end $$;

create or replace function public._interval_min(g public.games)
returns int language sql immutable as $$
  select greatest(5, (case when coalesce(g.start_players,0) <= 5 then 15
                           when g.start_players <= 7 then 20 else 25 end) - 5 * g.catches);
$$;

create or replace function public._new_player(p_game uuid, p_name text, p_avatar text, p_team text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_secret text := encode(gen_random_bytes(24), 'hex'); v_id uuid;
begin
  insert into public.players(game_id, secret_hash, name, avatar, team)
  values (p_game, encode(digest(v_secret, 'sha256'), 'hex'), btrim(p_name), p_avatar, p_team)
  returning id into v_id;
  return jsonb_build_object('player_id', v_id, 'secret', v_secret);
end $$;

create or replace function public.create_game(p_mode text, p_name text, p_avatar text, p_age_ok boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_code text; v_game uuid; v_p jsonb; i int;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if p_age_ok is not true then raise exception 'You must be 13 or older to play.'; end if;
  delete from public.games where created_at < now() - interval '1 day';
  loop
    v_code := '';
    for i in 1..4 loop v_code := v_code || substr(alphabet, 1 + floor(random()*length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.games where code = v_code);
  end loop;
  insert into public.games(code, mode) values (v_code, p_mode) returning id into v_game;
  v_p := public._new_player(v_game, p_name, p_avatar, 'hunter');
  update public.games set host_id = (v_p->>'player_id')::uuid where id = v_game;
  return v_p || jsonb_build_object('game_id', v_game, 'code', v_code);
end $$;

create or replace function public.join_game(p_code text, p_name text, p_avatar text, p_age_ok boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare g public.games; v_p jsonb;
begin
  if p_age_ok is not true then raise exception 'You must be 13 or older to play.'; end if;
  select * into g from public.games where code = upper(btrim(p_code));
  if g.id is null then raise exception 'No game with that code.'; end if;
  if g.status <> 'lobby' then raise exception 'That game already started.'; end if;
  if (select count(*) from public.players where game_id = g.id) >= 12 then raise exception 'That game is full (12 players).'; end if;
  v_p := public._new_player(g.id, p_name, p_avatar, 'ghost');
  return v_p || jsonb_build_object('game_id', g.id, 'code', g.code);
end $$;

create or replace function public.set_team(p_player uuid, p_secret text, p_target uuid, p_team text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me public.players; g public.games;
begin
  me := public._auth(p_player, p_secret);
  select * into g from public.games where id = me.game_id;
  if g.status <> 'lobby' then raise exception 'Teams are locked once the game starts.'; end if;
  if p_target <> me.id and g.host_id <> me.id then raise exception 'Only the host can move other players.'; end if;
  update public.players set team = p_team where id = p_target and game_id = me.game_id;
end $$;

create or replace function public.set_mode(p_player uuid, p_secret text, p_mode text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me public.players;
begin
  me := public._auth(p_player, p_secret);
  update public.games set mode = p_mode where id = me.game_id and host_id = me.id and status = 'lobby';
end $$;

create or replace function public.start_game(p_player uuid, p_secret text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me public.players; g public.games; nh int; ng int; v_head interval;
begin
  me := public._auth(p_player, p_secret);
  select * into g from public.games where id = me.game_id for update;
  if g.host_id <> me.id then raise exception 'Only the host can start.'; end if;
  if g.status <> 'lobby' then return; end if;
  select count(*) filter (where team='hunter'), count(*) filter (where team='ghost') into nh, ng
    from public.players where game_id = g.id;
  if nh < 1 or ng < 1 then raise exception 'You need at least 1 hunter and 1 ghost.'; end if;
  v_head := case when g.mode = 'quick' then interval '1 minute' else interval '3 minutes' end;
  update public.games set status = 'live', start_players = nh + ng, started_at = now(),
    hunt_starts_at = now() + v_head,
    ends_at = case g.mode when 'quick' then now() + interval '15 minutes'
                          when 'hour' then now() + interval '60 minutes' else null end
  where id = g.id returning * into g;
  if g.mode <> 'quick' then
    update public.games set next_ping_at = now() + make_interval(mins => public._interval_min(g)) where id = g.id;
  end if;
end $$;

create or replace function public.update_location(p_player uuid, p_secret text, p_lat double precision, p_lng double precision, p_acc real)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me public.players;
begin
  me := public._auth(p_player, p_secret);
  insert into public.locations(player_id, game_id, lat, lng, acc, updated_at)
  values (me.id, me.game_id, p_lat, p_lng, p_acc, now())
  on conflict (player_id) do update set lat = excluded.lat, lng = excluded.lng, acc = excluded.acc, updated_at = now();
end $$;

create or replace function public._snapshot(p_game uuid, p_only uuid default null)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'lat', l.lat, 'lng', l.lng, 'acc', l.acc, 'at', l.updated_at)), '[]'::jsonb)
  from public.players p join public.locations l on l.player_id = p.id
  where p.game_id = p_game and p.team = 'ghost' and (p_only is null or p.id = p_only);
$$;

create or replace function public._end(p_game uuid, p_winner text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.games set status = 'ended', winner = p_winner, next_ping_at = null where id = p_game and status = 'live';
  delete from public.locations where game_id = p_game;
  delete from public.hints where game_id = p_game;
  update public.pings set snapshot = '[]'::jsonb where game_id = p_game;
end $$;

create or replace function public._tick(p_game uuid)
returns void language plpgsql security definer set search_path = public as $$
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
  if g.next_ping_at is not null and now() >= g.next_ping_at then
    update public.games set ping_seq = ping_seq + 1 where id = g.id returning * into g;
    insert into public.pings(game_id, seq, kind, snapshot) values (g.id, g.ping_seq, 'ping', public._snapshot(g.id));
    insert into public.hints(game_id, player_id, ping_seq, deadline)
      select g.id, p.id, g.ping_seq, now() + interval '60 seconds' from public.players p
      where p.game_id = g.id and p.team = 'ghost' on conflict do nothing;
    update public.games set next_ping_at = now() + make_interval(mins => public._interval_min(g)) where id = g.id;
  end if;
  for h in select * from public.hints where game_id = g.id and photo is null and not penalized and deadline < now() loop
    update public.hints set penalized = true where id = h.id;
    if exists (select 1 from public.players where id = h.player_id and team = 'ghost') then
      insert into public.pings(game_id, seq, kind, snapshot) values (g.id, h.ping_seq, 'penalty', public._snapshot(g.id, h.player_id));
    end if;
  end loop;
end $$;

create or replace function public._apply_catch(p_game uuid, p_ghost uuid, p_hunter uuid)
returns void language plpgsql security definer set search_path = public as $$
declare g public.games;
begin
  update public.players set team = 'hunter', alive = false, caught_at = now(), caught_by = p_hunter
    where id = p_ghost and game_id = p_game and team = 'ghost';
  if not found then return; end if;
  update public.games set catches = catches + 1 where id = p_game returning * into g;
  if g.mode <> 'quick' then
    update public.games set next_ping_at = now() + make_interval(mins => public._interval_min(g)) where id = p_game;
  end if;
  update public.hints set penalized = true where player_id = p_ghost and photo is null;
  perform public._tick(p_game);
end $$;

create or replace function public.report_catch(p_player uuid, p_secret text, p_ghost uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me public.players;
begin
  me := public._auth(p_player, p_secret);
  if me.team <> 'hunter' then raise exception 'Only hunters can report a catch.'; end if;
  if not exists (select 1 from public.games where id = me.game_id and status = 'live') then raise exception 'The game is not running.'; end if;
  if not exists (select 1 from public.players where id = p_ghost and game_id = me.game_id and team = 'ghost') then raise exception 'That player is not a ghost.'; end if;
  delete from public.catches where ghost_id = p_ghost and status = 'pending';
  insert into public.catches(game_id, hunter_id, ghost_id) values (me.game_id, me.id, p_ghost);
end $$;

create or replace function public.respond_catch(p_player uuid, p_secret text, p_catch bigint, p_accept boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me public.players; c public.catches;
begin
  me := public._auth(p_player, p_secret);
  select * into c from public.catches where id = p_catch and ghost_id = me.id and status = 'pending';
  if c.id is null then return; end if;
  update public.catches set status = case when p_accept then 'confirmed' else 'rejected' end where id = c.id;
  if p_accept then perform public._apply_catch(me.game_id, me.id, c.hunter_id); end if;
end $$;

create or replace function public.upload_hint(p_player uuid, p_secret text, p_seq int, p_photo text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me public.players;
begin
  me := public._auth(p_player, p_secret);
  if p_photo !~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' or length(p_photo) > 400000 then
    raise exception 'Photo must be a JPEG under 300 KB.';
  end if;
  update public.hints set photo = p_photo, uploaded_at = now()
    where player_id = me.id and ping_seq = p_seq and photo is null and not penalized and deadline >= now();
  if not found then raise exception 'Too late, the hint window closed.'; end if;
end $$;

create or replace function public.end_game(p_player uuid, p_secret text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me public.players;
begin
  me := public._auth(p_player, p_secret);
  if not exists (select 1 from public.games where id = me.game_id and host_id = me.id) then raise exception 'Only the host can end the game.'; end if;
  perform public._end(me.game_id, case when exists (select 1 from public.players where game_id = me.game_id and team='ghost') then 'ghosts' else 'hunters' end);
end $$;

create or replace function public.get_state(p_player uuid, p_secret text, p_photos_since timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
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
                 from public.catches c where c.hunter_id = me.id and c.created_at > now() - interval '2 minutes'));
  else
    res := res || jsonb_build_object(
      'last_seen', (select e from public.pings pg, jsonb_array_elements(pg.snapshot) e
                    where pg.game_id = g.id and e->>'id' = me.id::text order by pg.created_at desc limit 1),
      'hint_due', (select jsonb_build_object('seq', h.ping_seq, 'deadline', h.deadline) from public.hints h
                   where h.player_id = me.id and h.photo is null and not h.penalized and h.deadline > now()
                   order by h.ping_seq desc limit 1),
      'catch_request', (select jsonb_build_object('id', c.id, 'hunter_id', c.hunter_id) from public.catches c
                   where c.ghost_id = me.id and c.status = 'pending' order by c.created_at desc limit 1));
  end if;
  return res;
end $$;

-- Only the public entry points are callable by the browser.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.create_game(text, text, text, boolean), public.join_game(text, text, text, boolean),
  public.set_team(uuid, text, uuid, text), public.set_mode(uuid, text, text), public.start_game(uuid, text),
  public.update_location(uuid, text, double precision, double precision, real), public.report_catch(uuid, text, uuid),
  public.respond_catch(uuid, text, bigint, boolean), public.upload_hint(uuid, text, int, text), public.end_game(uuid, text),
  public.get_state(uuid, text, timestamptz) to anon;;
