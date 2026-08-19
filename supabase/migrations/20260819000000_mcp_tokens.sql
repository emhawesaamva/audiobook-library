-- Personal access tokens for the MCP server (api/mcp.js).
--
-- A token is bound to ONE library (a profiles row), not to an account. That is
-- the security property the whole design rests on: api/_lib/mcp-scope.js filters
-- every query by the token's profile_id, so a token can never see or touch
-- another library even under the same account.
--
-- Only the SHA-256 of the token is stored. The raw value exists once, in the
-- browser that generated it, and is shown to the user once. sha256 rather than
-- bcrypt/argon2 on purpose: the secret is 256 bits of CSPRNG output, so there is
-- no dictionary to slow down, and a plain digest is what lets the server find
-- the row with a single indexed lookup instead of testing every hash in the
-- table.
--
-- Additive and idempotent, like every other migration here.

create table if not exists public.mcp_tokens (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null default auth.uid() references public.accounts (id) on delete cascade,
  profile_id   uuid not null references public.profiles (id) on delete cascade,
  name         text not null,
  token_prefix text not null,          -- displayable head, e.g. "alib_7Kq2xR9m"
  token_hash   text not null unique,   -- lower-hex sha256 of the raw token
  can_write    boolean not null default true,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  -- Fixed-window rate limiting, stamped by the same write as last_used_at.
  -- Lives here because a Vercel function has no shared memory to count in.
  req_window   timestamptz,
  req_count    int not null default 0
);

create index if not exists mcp_tokens_account_idx on public.mcp_tokens (account_id);
create index if not exists mcp_tokens_profile_idx on public.mcp_tokens (profile_id);

alter table public.mcp_tokens drop constraint if exists mcp_tokens_hash_shape;
alter table public.mcp_tokens add constraint mcp_tokens_hash_shape
  check (token_hash ~ '^[0-9a-f]{64}$');

comment on table  public.mcp_tokens            is 'Personal access tokens for /api/mcp; one library each.';
comment on column public.mcp_tokens.token_hash is 'sha256 hex of the raw token. The raw token is never stored anywhere.';
comment on column public.mcp_tokens.can_write  is 'false = read-only token; every write tool refuses.';

-- RLS is not optional here. 20260603000050_grants.sql ends with
--   alter default privileges in schema public grant all on tables to anon, ...
-- so a new table is granted to anon automatically, and the publishable key is
-- bundled into the frontend. Without RLS this table would be world-readable.
alter table public.mcp_tokens enable row level security;

-- Owner-only, and a token can only ever be bound to a library the caller owns.
-- Deliberately no `or public.is_admin()` clause, unlike every other table here:
-- there is nothing an admin needs from a credentials table.
drop policy if exists mcp_tokens_select on public.mcp_tokens;
create policy mcp_tokens_select on public.mcp_tokens for select to authenticated
  using (account_id = (select auth.uid()));

drop policy if exists mcp_tokens_insert on public.mcp_tokens;
create policy mcp_tokens_insert on public.mcp_tokens for insert to authenticated
  with check (
    account_id = (select auth.uid())
    and exists (select 1 from public.profiles p
                where p.id = profile_id and p.account_id = (select auth.uid()))
  );

drop policy if exists mcp_tokens_update on public.mcp_tokens;
create policy mcp_tokens_update on public.mcp_tokens for update to authenticated
  using (account_id = (select auth.uid()))
  with check (account_id = (select auth.uid()));

drop policy if exists mcp_tokens_delete on public.mcp_tokens;
create policy mcp_tokens_delete on public.mcp_tokens for delete to authenticated
  using (account_id = (select auth.uid()));

-- Column privileges, the same technique 20260603000100_rls.sql uses on accounts.
-- A user may rename and revoke a token; nothing may repoint an existing token at
-- another library or swap its hash. Rebinding means minting a new token.
revoke update on public.mcp_tokens from authenticated, anon;
grant update (name, revoked_at) on public.mcp_tokens to authenticated;

-- profiles and books are anon-readable for share links
-- (20260603000200_public_read.sql); credentials are not.
revoke all on public.mcp_tokens from anon;
