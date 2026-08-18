-- Row-level security for Audiobook Library v2. Run after schema.sql.
-- Also RLS-locks the legacy audiobook_library table (no policies = inaccessible
-- via anon/authenticated keys; the secret key still reads it server-side).

alter table public.accounts                 enable row level security;
alter table public.profiles                 enable row level security;
alter table public.books                    enable row level security;
alter table public.book_reads               enable row level security;
alter table public.reading_goals            enable row level security;
alter table public.rejected_recommendations enable row level security;
alter table public.library_snapshots        enable row level security;
alter table public.user_settings            enable row level security;
alter table public.app_settings             enable row level security;
alter table public.feedback                 enable row level security;

-- The legacy table predates schema.sql and is never created by it, so it is
-- absent on any fresh install (including the local Docker stack). Guard the
-- lock so this file still runs end to end where there is nothing to lock.
do $$ begin
  if to_regclass('public.audiobook_library') is not null then
    execute 'alter table public.audiobook_library enable row level security';
  end if;
end $$;

-- ---- accounts ----
create policy accounts_select on public.accounts for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());
create policy accounts_update on public.accounts for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
-- Self-promotion is prevented by column privileges, not policy (a WITH CHECK
-- subselect on accounts recurses into its own policies): authenticated users
-- may only update display_name. is_admin changes require the service role.
revoke update on public.accounts from authenticated, anon;
grant update (display_name) on public.accounts to authenticated;
-- No insert/delete policies: rows are created by the signup trigger and removed
-- by the auth.users cascade.

-- ---- profiles ----
create policy profiles_all on public.profiles for all to authenticated
  using (account_id = (select auth.uid()) or public.is_admin())
  with check (account_id = (select auth.uid()) or public.is_admin());

-- ---- books / book_reads / reading_goals / rejected / snapshots ----
create policy books_all on public.books for all to authenticated
  using (exists (select 1 from public.profiles p
                 where p.id = profile_id and p.account_id = (select auth.uid()))
         or public.is_admin())
  with check (exists (select 1 from public.profiles p
                 where p.id = profile_id and p.account_id = (select auth.uid()))
         or public.is_admin());

create policy book_reads_all on public.book_reads for all to authenticated
  using (exists (select 1 from public.books b
                 join public.profiles p on p.id = b.profile_id
                 where b.id = book_id and p.account_id = (select auth.uid()))
         or public.is_admin())
  with check (exists (select 1 from public.books b
                 join public.profiles p on p.id = b.profile_id
                 where b.id = book_id and p.account_id = (select auth.uid()))
         or public.is_admin());

create policy goals_all on public.reading_goals for all to authenticated
  using (exists (select 1 from public.profiles p
                 where p.id = profile_id and p.account_id = (select auth.uid()))
         or public.is_admin())
  with check (exists (select 1 from public.profiles p
                 where p.id = profile_id and p.account_id = (select auth.uid()))
         or public.is_admin());

create policy rejected_all on public.rejected_recommendations for all to authenticated
  using (exists (select 1 from public.profiles p
                 where p.id = profile_id and p.account_id = (select auth.uid()))
         or public.is_admin())
  with check (exists (select 1 from public.profiles p
                 where p.id = profile_id and p.account_id = (select auth.uid()))
         or public.is_admin());

create policy snapshots_all on public.library_snapshots for all to authenticated
  using (exists (select 1 from public.profiles p
                 where p.id = profile_id and p.account_id = (select auth.uid()))
         or public.is_admin())
  with check (exists (select 1 from public.profiles p
                 where p.id = profile_id and p.account_id = (select auth.uid()))
         or public.is_admin());

-- ---- user_settings ----
create policy usettings_all on public.user_settings for all to authenticated
  using (account_id = (select auth.uid()))
  with check (account_id = (select auth.uid()));

-- ---- app_settings: world-readable (login page needs signups_disabled), admin-writable ----
create policy appsettings_read  on public.app_settings for select to anon, authenticated using (true);
create policy appsettings_write on public.app_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- feedback: anyone can submit their own, only the admin can read ----
create policy feedback_insert on public.feedback for insert to authenticated
  with check (account_id = (select auth.uid()));
create policy feedback_select on public.feedback for select to authenticated
  using (public.is_admin());
