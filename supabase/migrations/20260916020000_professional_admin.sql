create extension if not exists pgcrypto;

alter table public.kf_license_keys add column if not exists key_hash char(64);
alter table public.kf_license_keys add column if not exists key_hint varchar(80);
alter table public.kf_license_keys add column if not exists notes varchar(500) not null default '';
alter table public.kf_license_keys add column if not exists updated_at timestamptz not null default now();

-- Backfill in loturi mici cu COMMIT per lot (procedura + CALL).
-- INAINTE erau 4x UPDATE full-table intr-o singura tranzactie: pe tabele
-- mari depaseau statement_timeout-ul si faceau rollback la TOT la fiecare
-- boot — migratia nu se termina niciodata si bloca toata baza.
-- Fiecare lot atinge max 5000 randuri (sub timeout), iar WHERE-urile
-- ... IS NULL fac reluarea idempotenta: la retry continua de unde a ramas.
create or replace procedure public.kf_backfill_hashes()
language plpgsql
as $$
declare
  n integer;
begin
  loop
    update public.kf_license_keys
    set key_hash = encode(digest(upper(trim(license_key)), 'sha256'), 'hex')
    where id in (select id from public.kf_license_keys where key_hash is null limit 5000);
    get diagnostics n = row_count;
    commit;
    exit when n = 0;
  end loop;
  loop
    update public.kf_license_keys
    set key_hint = 'KF-****-****-' || right(replace(license_key, '-', ''), 6) || '-' || left(id::text, 6)
    where id in (select id from public.kf_license_keys where key_hint is null limit 5000);
    get diagnostics n = row_count;
    commit;
    exit when n = 0;
  end loop;
  loop
    update public.kf_license_keys set license_key = key_hint
    where id in (select id from public.kf_license_keys where license_key <> key_hint limit 5000);
    get diagnostics n = row_count;
    commit;
    exit when n = 0;
  end loop;
  loop
    update public.kf_license_keys set status = 'blocked'
    where id in (select id from public.kf_license_keys where status = 'disabled' limit 5000);
    get diagnostics n = row_count;
    commit;
    exit when n = 0;
  end loop;
end;
$$;

call public.kf_backfill_hashes();
drop procedure public.kf_backfill_hashes();

alter table public.kf_license_keys alter column key_hash set not null;
create unique index if not exists idx_kf_keys_hash on public.kf_license_keys(key_hash);
create index if not exists idx_kf_keys_created on public.kf_license_keys(created_at desc);
create index if not exists idx_kf_keys_product_status on public.kf_license_keys(product_id, status);

-- Swap-ul de constraint rula DROP+ADD la FIECARE boot (validare full-table
-- de fiecare data). Gardat: sare peste daca definitia contine deja 'blocked'.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'kf_license_keys_status_check'
      and pg_get_constraintdef(oid) ilike '%blocked%'
  ) then
    alter table public.kf_license_keys drop constraint if exists kf_license_keys_status_check;
    alter table public.kf_license_keys add constraint kf_license_keys_status_check
      check (status in ('active', 'used', 'revoked', 'blocked'));
  end if;
end;
$$;

alter table public.kf_activations add column if not exists activation_ip varchar(64);

create table if not exists public.kf_audit_logs (
  id uuid primary key default gen_random_uuid(),
  level varchar(10) not null check (level in ('INFO','SUCCESS','WARNING','ERROR','DEBUG')),
  action varchar(100) not null,
  entity_type varchar(50) not null,
  entity_id varchar(100),
  actor_id uuid references public.kf_users(id) on delete set null,
  actor_name varchar(100) not null default 'system',
  ip_address varchar(64),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_kf_audit_created on public.kf_audit_logs(created_at desc);
create index if not exists idx_kf_audit_action on public.kf_audit_logs(action);
create index if not exists idx_kf_audit_entity on public.kf_audit_logs(entity_type, entity_id);

create table if not exists public.kf_key_history (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.kf_license_keys(id) on delete cascade,
  action varchar(50) not null,
  old_data jsonb,
  new_data jsonb,
  actor_name varchar(100) not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_kf_history_license on public.kf_key_history(license_id, created_at desc);

alter table public.kf_audit_logs enable row level security;
alter table public.kf_key_history enable row level security;

drop function if exists public.kf_redeem_key(text, text, text, uuid);
create or replace function public.kf_redeem_key(
  p_key text,
  p_product_id text,
  p_hwid_hash text,
  p_user_id uuid,
  p_activation_ip text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  license public.kf_license_keys%rowtype;
  activation_count integer;
  activation_number integer;
begin
  select * into license from public.kf_license_keys
  where key_hash = encode(digest(upper(trim(p_key)), 'sha256'), 'hex') for update;

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

  select count(*)::integer into activation_count from public.kf_activations where license_id = license.id;
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
    update public.kf_license_keys set status = 'used', updated_at = now() where id = license.id and status = 'active';
  else
    update public.kf_activations set last_seen_at = now(), activation_ip = coalesce(left(p_activation_ip, 64), activation_ip)
      where license_id = license.id and hwid_hash = p_hwid_hash;
  end if;

  if p_user_id is not null and license.redeemed_by_user_id is null then
    update public.kf_license_keys set redeemed_by_user_id = p_user_id, updated_at = now() where id = license.id;
  end if;

  return jsonb_build_object('valid', true, 'productId', license.product_id,
    'expiresAt', license.expires_at, 'activation', activation_number,
    'maxActivations', license.max_activations);
end;
$$;

revoke all on function public.kf_redeem_key(text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.kf_redeem_key(text, text, text, uuid, text) to service_role;
