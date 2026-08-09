alter table public.conversations
  add column if not exists active_branch text;
