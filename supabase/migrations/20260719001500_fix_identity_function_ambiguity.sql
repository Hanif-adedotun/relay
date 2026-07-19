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
