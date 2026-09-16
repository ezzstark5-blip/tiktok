-- O Supabase instala pgcrypto no schema `extensions`. A funcao anterior usava
-- search_path=public e falhava em runtime com "digest(text, unknown) does not exist".
create extension if not exists pgcrypto with schema extensions;

create or replace function public.kf_redeem_key(
  p_key text,
  p_product_id text,
  p_hwid_hash text,
  p_user_id uuid,
  p_activation_ip text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  license public.kf_license_keys%rowtype;
  activation_count integer;
  activation_number integer;
begin
  select * into license from public.kf_license_keys
  where key_hash = encode(extensions.digest(convert_to(upper(trim(p_key)), 'UTF8'), 'sha256'), 'hex')
  for update;

  if not found then return jsonb_build_object('valid', false, 'reason', 'KEY_NOT_FOUND'); end if;
  if p_product_id is not null and license.product_id <> p_product_id then
    return jsonb_build_object('valid', false, 'reason', 'WRONG_PRODUCT');
  end if;
  if license.status = 'blocked' then return jsonb_build_object('valid', false, 'reason', 'KEY_BLOCKED'); end if;
  if license.status = 'revoked' then return jsonb_build_object('valid', false, 'reason', 'KEY_REVOKED'); end if;
  if license.expires_at <= now() then return jsonb_build_object('valid', false, 'reason', 'KEY_EXPIRED'); end if;
  if p_user_id is not null and license.redeemed_by_user_id is not null and license.redeemed_by_user_id <> p_user_id then
    return jsonb_build_object('valid', false, 'reason', 'KEY_ALREADY_REDEEMED');
  end if;

  select count(*)::integer into activation_count
  from public.kf_activations where license_id = license.id;

  select row_number into activation_number from (
    select hwid_hash, row_number() over (order by activated_at)::integer
    from public.kf_activations where license_id = license.id
  ) existing where existing.hwid_hash = p_hwid_hash;

  if activation_number is null then
    if activation_count >= license.max_activations then
      return jsonb_build_object('valid', false, 'reason', 'ACTIVATION_LIMIT');
    end if;
    insert into public.kf_activations (license_id, hwid_hash, activated_at, last_seen_at, activation_ip)
      values (license.id, p_hwid_hash, now(), now(), left(p_activation_ip, 64));
    activation_number := activation_count + 1;
    update public.kf_license_keys set status = 'used', updated_at = now()
      where id = license.id and status = 'active';
  else
    update public.kf_activations
      set last_seen_at = now(), activation_ip = coalesce(left(p_activation_ip, 64), activation_ip)
      where license_id = license.id and hwid_hash = p_hwid_hash;
  end if;

  if p_user_id is not null and license.redeemed_by_user_id is null then
    update public.kf_license_keys set redeemed_by_user_id = p_user_id, updated_at = now()
      where id = license.id;
  end if;

  return jsonb_build_object(
    'valid', true,
    'productId', license.product_id,
    'expiresAt', license.expires_at,
    'activation', activation_number,
    'maxActivations', license.max_activations
  );
end;
$$;

revoke all on function public.kf_redeem_key(text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.kf_redeem_key(text, text, text, uuid, text) to service_role;
