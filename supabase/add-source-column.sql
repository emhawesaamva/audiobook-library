-- Adds books.source — import provenance for the library "Update" feature
-- (re-import a fresh export and reconcile changes, scoped per service).
-- Additive and nullable; safe to run on the live DB. Apply via the Supabase
-- SQL editor. Unrelated to the legacy-table migration (scripts/migrate-legacy.js).
alter table public.books
  add column if not exists source text
  check (source in ('audible','goodreads','libby','storygraph','other'));

comment on column public.books.source is 'Import provenance: which service this book was imported/updated from. NULL = added manually.';
