create table if not exists public.kf_users (
  id uuid primary key,
  username varchar(100) not null unique,
  password_hash varchar(255) not null,
  role varchar(30) not null default 'customer',
  created_at timestamptz not null default now()
);

create table if not exists public.kf_products (
  id varchar(64) primary key,
  name varchar(120) not null,
  description text not null,
  price numeric(10,2) not null,
  active boolean not null default true
);

create table if not exists public.kf_license_keys (
  id uuid primary key,
  license_key varchar(80) not null unique,
  product_id varchar(64) not null references public.kf_products(id),
  status varchar(20) not null default 'active' check (status in ('active', 'disabled')),
  max_activations integer not null default 1 check (max_activations between 1 and 100),
  created_by varchar(150) not null,
  redeemed_by_user_id uuid references public.kf_users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.kf_activations (
  license_id uuid not null references public.kf_license_keys(id) on delete cascade,
  hwid_hash char(64) not null,
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  primary key (license_id, hwid_hash)
);

create table if not exists public.kf_sessions (
  id uuid primary key,
  user_id uuid not null references public.kf_users(id) on delete cascade,
  token_hash char(64) not null unique,
  expires_at timestamptz not null
);

create table if not exists public.kf_meta (
  meta_key varchar(100) primary key,
  meta_value text not null
);

create index if not exists idx_kf_sessions_expires on public.kf_sessions(expires_at);
create index if not exists idx_kf_keys_user on public.kf_license_keys(redeemed_by_user_id);
create index if not exists idx_kf_keys_status_expiry on public.kf_license_keys(status, expires_at);

insert into public.kf_products (id, name, description, price, active) values
  ('stark-menu', 'Stark Menu', 'Acesso ao produto Stark Menu.', 59.90, true),
  ('bypass-cfx', 'Bypass CFX', 'Acesso ao produto Bypass CFX.', 39.90, true),
  ('stark-spoofer', 'Stark Spoofer', 'Acesso ao produto Stark Spoofer.', 49.90, true)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  price = excluded.price,
  active = excluded.active;

-- A chave publicavel nao pode ler usuarios, keys, sessoes ou HWIDs.
-- A API usa a conexao PostgreSQL do backend (role postgres), que ignora RLS.
alter table public.kf_users enable row level security;
alter table public.kf_products enable row level security;
alter table public.kf_license_keys enable row level security;
alter table public.kf_activations enable row level security;
alter table public.kf_sessions enable row level security;
alter table public.kf_meta enable row level security;

create or replace function public.kf_redeem_key(
  p_key text,
  p_product_id text,
  p_hwid_hash text,
  p_user_id uuid
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
  select * into license
  from public.kf_license_keys
  where license_key = upper(trim(p_key))
  for update;

  if not found then return jsonb_build_object('valid', false, 'reason', 'KEY_NOT_FOUND'); end if;
  if p_product_id is not null and license.product_id <> p_product_id then
    return jsonb_build_object('valid', false, 'reason', 'WRONG_PRODUCT');
  end if;
  if license.status <> 'active' then return jsonb_build_object('valid', false, 'reason', 'KEY_DISABLED'); end if;
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
    insert into public.kf_activations (license_id, hwid_hash, activated_at, last_seen_at)
      values (license.id, p_hwid_hash, now(), now());
    activation_number := activation_count + 1;
  else
    update public.kf_activations set last_seen_at = now()
      where license_id = license.id and hwid_hash = p_hwid_hash;
  end if;

  if p_user_id is not null and license.redeemed_by_user_id is null then
    update public.kf_license_keys set redeemed_by_user_id = p_user_id where id = license.id;
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

revoke all on function public.kf_redeem_key(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.kf_redeem_key(text, text, text, uuid) to service_role;
