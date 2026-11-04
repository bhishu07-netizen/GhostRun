-- Ghostrun hardening: found while play-testing the server functions.

-- 1. Avatars must be one of the 12 shipped images.
alter table public.players drop constraint if exists players_avatar_check;
alter table public.players add constraint players_avatar_check check (avatar in
  ('hunter','ghost','runner','spotter','sneak','camper','strategist','rebel','shadow','survivor','operative','scout'));

-- 2. No catches during the head start, and no spamming a ghost who just said "no".
create or replace function public.report_catch(p_player uuid, p_secret text, p_ghost uuid)
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
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
end $function$;

-- 3. Only store locations while the game is live, so nothing is left behind after it ends.
create or replace function public.update_location(p_player uuid, p_secret text, p_lat double precision, p_lng double precision, p_acc real)
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare me public.players;
begin
  me := public._auth(p_player, p_secret);
  if not exists (select 1 from public.games where id = me.game_id and status = 'live') then return; end if;
  insert into public.locations(player_id, game_id, lat, lng, acc, updated_at)
  values (me.id, me.game_id, p_lat, p_lng, p_acc, now())
  on conflict (player_id) do update set lat = excluded.lat, lng = excluded.lng, acc = excluded.acc, updated_at = now();
end $function$;
delete from public.locations l using public.games g where g.id = l.game_id and g.status <> 'live';

-- 4. Leaving really leaves: the player is removed, host passes on, and the game ends if a side is empty.
create or replace function public.leave_game(p_player uuid, p_secret text)
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare me public.players; g public.games; v_next uuid;
begin
  me := public._auth(p_player, p_secret);
  select * into g from public.games where id = me.game_id for update;
  if g.status = 'ended' then return; end if;
  delete from public.players where id = me.id;
  if g.host_id = me.id then
    select id into v_next from public.players where game_id = g.id order by joined_at limit 1;
    if v_next is null then delete from public.games where id = g.id; return; end if;
    update public.games set host_id = v_next where id = g.id;
  end if;
  if g.status = 'live' then
    if not exists (select 1 from public.players where game_id = g.id and team = 'hunter') then
      perform public._end(g.id, 'ghosts');
    else
      perform public._tick(g.id);
    end if;
  end if;
end $function$;
revoke all on function public.leave_game(uuid, text) from public;
grant execute on function public.leave_game(uuid, text) to anon, authenticated;
