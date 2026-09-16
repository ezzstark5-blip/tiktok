-- Corrige "canceling statement due to statement timeout".
-- Causa raiz: counts exact + SELECTs sem limite (getAllKeys/getAdminOverview)
-- + filtros ilike '%...%' sem indice trigram faziam SEQ SCAN em tabelas grandes.
-- Esta migracao cria os indices que faltavam; o codigo passa a usar
-- count estimated + LIMIT, entao as queries ficam O(log n) em vez de O(n).

create extension if not exists pg_trgm;

-- getUserProducts: redeemed_by_user_id + status + expires_at
create index if not exists idx_kf_keys_user_status_expiry
  on public.kf_license_keys (redeemed_by_user_id, status, expires_at desc);

-- listKeysPage: ordenacao + filtros mais comuns
create index if not exists idx_kf_keys_expires on public.kf_license_keys (expires_at desc);
create index if not exists idx_kf_keys_status_created on public.kf_license_keys (status, created_at desc);

-- listKeysPage busca textual: key_hint ilike '%...%' e product_id ilike '%...%'
-- (btree nao serve p/ LIKE com % inicial; gin_trgm sim)
create index if not exists idx_kf_keys_hint_trgm
  on public.kf_license_keys using gin (key_hint gin_trgm_ops);
create index if not exists idx_kf_keys_product_trgm
  on public.kf_license_keys using gin (product_id gin_trgm_ops);

-- findSessionUser: join sessions -> users + filtro de expiracao
create index if not exists idx_kf_sessions_token_expires
  on public.kf_sessions (token_hash, expires_at);
create index if not exists idx_kf_sessions_user on public.kf_sessions (user_id);

-- kf_redeem_key: lookup por key_hash ja existe, garante ativacoes por licenca
create index if not exists idx_kf_activations_license on public.kf_activations (license_id);

-- getAuditLogs: filtros level/action + ordenacao
create index if not exists idx_kf_audit_level_created
  on public.kf_audit_logs (level, created_at desc);

-- Atualiza estatisticas para o count 'estimated' (pg_class.reltuples) ficar preciso
analyze public.kf_users;
analyze public.kf_products;
analyze public.kf_license_keys;
analyze public.kf_activations;
analyze public.kf_sessions;
analyze public.kf_audit_logs;
analyze public.kf_key_history;
analyze public.kf_meta;
