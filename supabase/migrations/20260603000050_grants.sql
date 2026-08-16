-- Table privileges for the Supabase roles.
--
-- Hosted Supabase projects come with default privileges that grant anon,
-- authenticated and service_role access to anything created in `public`, so the
-- schema never had to say this out loud. A database built purely from these
-- migrations — the local Docker stack — gets no such grants, and every request
-- fails with 42501 "permission denied for table …" long before RLS is consulted.
--
-- Broad grants are the Supabase model, not a hole: RLS is the gate, and every
-- table in this schema has it enabled with policies in the next migration.
-- Without a grant, RLS never even runs.

grant usage on schema public to anon, authenticated, service_role;

grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines  in schema public to anon, authenticated, service_role;

-- Cover tables added by later migrations.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines  to anon, authenticated, service_role;

-- `grant all on all tables` above includes UPDATE on public.accounts, which
-- would hand authenticated users the is_admin column. rls.sql narrows this back
-- to display_name only, but that file runs *after* this one and someone could
-- apply this migration alone against an existing database. Re-assert it here so
-- the restriction holds regardless of order. Keep in step with rls.sql.
revoke update on public.accounts from authenticated, anon;
grant update (display_name) on public.accounts to authenticated;
