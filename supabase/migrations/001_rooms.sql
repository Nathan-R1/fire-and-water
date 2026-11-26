-- Rooms: one row per game room, written by the server only.
create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  created_at  timestamptz not null default now(),
  ended_at    timestamptz
);

create index if not exists rooms_code_idx on public.rooms (code);

-- RLS on with no policies: only the secret/service-role key (server) can access.
alter table public.rooms enable row level security;
