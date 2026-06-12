-- Locks the legacy audiobook_library table: drops the pre-existing allow-all
-- policy so it is no longer reachable with the publishable (anon) key.
-- RLS is already enabled; with no policies, only the secret key can read it
-- (which is how the migration/verify scripts access it).
-- Run when approved: npx supabase db query --linked --file supabase/lock-legacy-table.sql
drop policy if exists public_access on public.audiobook_library;
