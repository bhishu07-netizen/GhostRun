create extension if not exists pgcrypto with schema extensions;

create table public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_id uuid,
  mode text not null check (mode in ('quick','hour','endless')),
  status text not null default 'lobby' check (status in ('lobby','live','ended')),
  start_players int,
  catches int not null default 0,
  ping_seq int not null default 0,
  started_at timestamptz,
  hunt_starts_at timestamptz,
  ends_at timestamptz,
  next_ping_at timestamptz,
  winner text,
  created_at timestamptz not null default now()
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  secret_hash text not null,
  name text not null check (char_length(name) between 1 and 20),
  avatar text not null check (avatar ~ '^[a-z]{2,16}$'),
  team text not null default 'ghost' check (team in ('hunter','ghost')),
  alive boolean not null default true,
  caught_at timestamptz,
  caught_by uuid,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index on public.players(game_id);

create table public.locations (
  player_id uuid primary key references public.players(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  acc real,
  updated_at timestamptz not null default now()
);

create table public.pings (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games(id) on delete cascade,
  seq int not null,
  kind text not null default 'ping' check (kind in ('ping','penalty')),
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index on public.pings(game_id, created_at desc);

create table public.hints (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  ping_seq int not null,
  deadline timestamptz not null,
  photo text,
  penalized boolean not null default false,
  created_at timestamptz not null default now(),
  unique (player_id, ping_seq)
);
create index on public.hints(game_id);

create table public.catches (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games(id) on delete cascade,
  hunter_id uuid not null references public.players(id) on delete cascade,
  ghost_id uuid not null references public.players(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  created_at timestamptz not null default now()
);
create index on public.catches(game_id);

-- Lock everything down: clients only talk to the security-definer functions below.
alter table public.games enable row level security;
alter table public.players enable row level security;
alter table public.locations enable row level security;
alter table public.pings enable row level security;
alter table public.hints enable row level security;
alter table public.catches enable row level security;
revoke all on public.games, public.players, public.locations, public.pings, public.hints, public.catches from anon, authenticated;;
