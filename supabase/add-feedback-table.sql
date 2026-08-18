-- One-shot migration for the "Contact us" feature. Run once against the
-- already-live project (schema.sql/rls.sql already reflect this table for
-- fresh installs, but re-running those in full against a live DB would fail
-- on already-existing tables):
--
--   node scripts/run-sql.js supabase/add-feedback-table.sql
--
-- Safe to delete after running.

create table public.feedback (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null default auth.uid() references public.accounts (id) on delete cascade,
  email      text not null,
  message    text not null,
  created_at timestamptz not null default now()
);
create index feedback_account_idx on public.feedback (account_id);
create index feedback_created_idx on public.feedback (created_at desc);
comment on table public.feedback is 'Contact-us submissions from the ? button; admin-reviewed only.';

alter table public.feedback enable row level security;

create policy feedback_insert on public.feedback for insert to authenticated
  with check (account_id = (select auth.uid()));
create policy feedback_select on public.feedback for select to authenticated
  using (public.is_admin());
