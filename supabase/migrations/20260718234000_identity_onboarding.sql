create extension if not exists pgcrypto;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  platform text not null,
  external_user_id text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (platform, external_user_id)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  platform text not null,
  external_space_id text not null,
  github_confirmation_pending boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, platform, external_space_id)
);

create table public.integration_auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  provider text not null check (provider = 'github'),
  state_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index integration_auth_sessions_active_idx
  on public.integration_auth_sessions (state_hash, expires_at)
  where consumed_at is null;

create table public.github_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  installation_id bigint not null,
  github_user_id bigint not null,
  github_login text not null,
  repository_selection text not null check (repository_selection in ('all', 'selected')),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, installation_id)
);

alter table public.users enable row level security;
alter table public.user_identities enable row level security;
alter table public.conversations enable row level security;
alter table public.integration_auth_sessions enable row level security;
alter table public.github_connections enable row level security;

create or replace function public.resolve_relay_identity(
  p_platform text,
  p_external_user_id text,
  p_external_space_id text
)
returns table (
  user_id uuid,
  conversation_id uuid,
  is_new_user boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_user_id uuid;
  resolved_conversation_id uuid;
  created_user boolean := false;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(p_platform || ':' || p_external_user_id, 0)
  );

  select identity.user_id
    into resolved_user_id
    from public.user_identities as identity
   where identity.platform = p_platform
     and identity.external_user_id = p_external_user_id;

  if resolved_user_id is null then
    insert into public.users default values
      returning id into resolved_user_id;

    insert into public.user_identities (
      user_id,
      platform,
      external_user_id
    ) values (
      resolved_user_id,
      p_platform,
      p_external_user_id
    );

    created_user := true;
  else
    update public.user_identities
       set last_seen_at = now()
     where platform = p_platform
       and external_user_id = p_external_user_id;
  end if;

  insert into public.conversations (
    user_id,
    platform,
    external_space_id
  ) values (
    resolved_user_id,
    p_platform,
    p_external_space_id
  )
  on conflict on constraint conversations_user_id_platform_external_space_id_key
  do update set updated_at = now()
  returning id into resolved_conversation_id;

  return query
  select resolved_user_id, resolved_conversation_id, created_user;
end;
$$;

revoke all on function public.resolve_relay_identity(text, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_relay_identity(text, text, text)
  to service_role;
