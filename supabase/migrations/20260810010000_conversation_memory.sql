create extension if not exists vector;

alter table public.conversations
  add column if not exists last_pr_number integer;

alter table public.conversations
  add column if not exists last_pr_url text;

alter table public.conversations
  add column if not exists last_commit_sha text;

create table public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  action text,
  created_at timestamptz not null default now()
);

create index conversation_messages_conversation_created_idx
  on public.conversation_messages (conversation_id, created_at desc);

create table public.memory_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  content text not null,
  kind text not null default 'turn' check (kind in ('turn')),
  source_message_ids uuid[] not null default '{}',
  repo text,
  branch text,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

create index memory_chunks_user_id_idx
  on public.memory_chunks (user_id);

create index memory_chunks_embedding_idx
  on public.memory_chunks
  using hnsw (embedding vector_cosine_ops);

alter table public.conversation_messages enable row level security;
alter table public.memory_chunks enable row level security;

create or replace function public.search_memory_chunks(
  p_user_id uuid,
  p_embedding vector(1536),
  p_limit integer default 5
)
returns table (
  id uuid,
  conversation_id uuid,
  content text,
  kind text,
  source_message_ids uuid[],
  repo text,
  branch text,
  created_at timestamptz,
  distance float
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.conversation_id,
    c.content,
    c.kind,
    c.source_message_ids,
    c.repo,
    c.branch,
    c.created_at,
    (c.embedding <=> p_embedding) as distance
  from public.memory_chunks c
  where c.user_id = p_user_id
  order by c.embedding <=> p_embedding
  limit greatest(1, least(coalesce(p_limit, 5), 20));
$$;
