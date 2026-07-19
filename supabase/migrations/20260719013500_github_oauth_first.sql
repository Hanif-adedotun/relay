alter table public.integration_auth_sessions
  add column github_user_id bigint,
  add column github_login text,
  add column eligible_installations jsonb,
  add constraint integration_auth_sessions_eligible_installations_array
    check (
      eligible_installations is null
      or jsonb_typeof(eligible_installations) = 'array'
    );

create or replace function public.consume_github_auth_session(
  p_state_hash text,
  p_installation_id bigint,
  p_now timestamptz
)
returns table (
  user_id uuid,
  conversation_id uuid,
  github_user_id bigint,
  github_login text,
  repository_selection text
)
language sql
security definer
set search_path = public
as $$
  with consumed as (
    update public.integration_auth_sessions as auth_session
       set consumed_at = p_now
     where auth_session.provider = 'github'
       and auth_session.state_hash = p_state_hash
       and auth_session.consumed_at is null
       and auth_session.expires_at > p_now
       and auth_session.github_user_id is not null
       and auth_session.github_login is not null
       and exists (
         select 1
           from jsonb_array_elements(
             auth_session.eligible_installations
           ) as candidate
          where (candidate->>'id')::bigint = p_installation_id
       )
    returning
      auth_session.user_id,
      auth_session.conversation_id,
      auth_session.github_user_id,
      auth_session.github_login,
      auth_session.eligible_installations
  )
  select
    consumed.user_id,
    consumed.conversation_id,
    consumed.github_user_id,
    consumed.github_login,
    candidate->>'repositorySelection'
  from consumed
  cross join lateral jsonb_array_elements(
    consumed.eligible_installations
  ) as candidate
  where (candidate->>'id')::bigint = p_installation_id;
$$;

revoke all on function public.consume_github_auth_session(text, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.consume_github_auth_session(text, bigint, timestamptz)
  to service_role;
