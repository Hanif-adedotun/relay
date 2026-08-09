alter table public.conversations
  add column if not exists active_repo text;

alter table public.conversations
  add constraint conversations_active_repo_format
  check (
    active_repo is null
    or active_repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  );
